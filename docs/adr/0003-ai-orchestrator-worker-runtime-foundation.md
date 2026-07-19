# ADR-0003 — AI Orchestrator Worker Runtime Foundation v1

- Stato: proposto
- Data: 2026-07-18
- Dipendenze: ADR-0001, ADR-0002

## Contesto

La State Machine Foundation v1.1 persiste il ledger fino a `HUMAN_APPROVAL`. La Persistent Job Queue Foundation v1 persiste job `PLANNED`/`BLOCKED` e un outbox `PENDING`, entrambi deliberatamente passivi e immutabili. La presenza di un job o di un evento non costituisce autorizzazione al dispatch.

Prima di installare un processo worker serve un protocollo persistente che impedisca doppio claim, scritture da worker scaduti, reinterpretazione della configurazione agente, retry illimitati, esecuzione oltre la fase causale e superamento del gate umano.

## Decisione

La Worker Runtime Foundation v1 introduce esclusivamente il contratto dormiente e le primitive interne. Non introduce un processo worker, handler agente, timer, cron, unità systemd, route, UI, provider call o avanzamento automatico del workflow.

### Separazione tra intent e runtime

`AiWorkflowJob` e `AiWorkflowJobOutboxEvent` non cambiano lifecycle. Il job resta `PLANNED` o `BLOCKED`; l'evento resta `PENDING` e append-only. Il runtime usa quattro nuove entità:

- `AiWorkflowJobRuntime`: stato tecnico corrente uno-a-uno con il job;
- `AiWorkflowJobAttempt`: tentativi e lease fenced;
- `AiWorkflowOutboxConsumption`: receipt append-only uno-a-uno con l'evento;
- `AiWorkflowJobRuntimeEvent`: audit tecnico hashato e concatenato.
- `AiOrchestratorWorkerCapabilitySetting`: kill switch persistente e separato
  per ognuna delle tredici capability, inizialmente disabilitato.

La migration non crea record runtime per job esistenti. L'ammissione futura avviene soltanto consumando l'outbox e rivalidando il contratto PR75.

### Lifecycle runtime

Il lifecycle è distinto dal job:

```text
AVAILABLE → LEASED → SUCCEEDED
              │
              ├→ RETRY_WAIT → LEASED
              ├→ FAILED_TERMINAL
              └→ SUPERSEDED
```

`SUPERSEDED` è terminale e copre job fuori fase, ciclo non corrente, job bloccato o barriera umana raggiunta. Nessuno stato runtime muta il ledger o il job originario.

### Consumo outbox

Il consumer esegue una ammissione transazionale: lock dell'evento, verifica di evento/job/ledger/executor/capability, creazione del runtime `AVAILABLE`, receipt e audit. La receipt unica rende l'ammissione exactly-once nel database; il processo chiamante resta at-least-once. L'outbox PR75 non viene aggiornato.

### Claim, lease e fencing

Il claim seleziona un solo runtime con `FOR UPDATE SKIP LOCKED`. Usa il clock UTC PostgreSQL, incrementa insieme `attemptSequence` e `fencingToken`, crea l'attempt e restituisce un token opaco di 256 bit. Nel database è conservato soltanto SHA-256 del token.

Heartbeat e terminalizzazione richiedono runtime, attempt, token hash, fencing token e lease non scaduta. Ogni nuovo claim incrementa il fence; un worker precedente non può quindi scrivere dopo scadenza, surrender o takeover.

La lease dura 120 secondi, heartbeat previsto ogni 30 secondi e durata assoluta massima del tentativo 600 secondi. I valori appartengono alla policy versionata e non sono input liberi.

### Retry e recovery

Solo `LEASE_EXPIRED`, `MOCK_HANDLER_TRANSIENT` e `WORKER_TRANSIENT` sono retryable. Il budget massimo è tre failure retryable. Il backoff è esponenziale, parte da 30 secondi, ha cap 15 minuti e jitter deterministico massimo 20% derivato da job e fencing token.

Il surrender non consuma retry budget. Il recupero di lease scadute è una primitiva interna distinta dal reconciler `AiRun`; questa PR non la schedula.
La recovery ricalcola la causa canonica completa: soltanto un job ancora
eleggibile consuma budget con `LEASE_EXPIRED`; fase/ciclo, barriera umana, job
bloccato o executor/config non più validi producono `SUPERSEDED` con la causa
esatta. Le cause strutturali non sono accettate come dichiarazioni fidate del
worker.

### Capability e configurazione agente

`FAI-AUDIT-WORKER-RUNTIME-POLICY@1.0` mappa ognuno dei tredici job a:

- esatto job definition hash;
- executor agent code, config version e config hash PR75;
- capability code/hash;
- handler code/version dichiarativo;
- provider `mock` e data mode `synthetic`;
- rete, dati CRM, provider call e scrittura transizioni tutte vietate.

Il mapping e l'hash sono duplicati in TypeScript e SQL. Prima di admission, claim, heartbeat e successo PostgreSQL ricalcola l'hash dell'esatta `AiAgentConfigVersion` immutabile. Una nuova versione corrente dell'agente non sostituisce quella persistita nel job. L'agente padre deve comunque esistere, essere attivo, avere code coerente e provider mock.

Ogni mapping possiede inoltre un record operativo distinto. Tutti i tredici
record nascono con `enabled=false`; assenza, duplicazione o mismatch di
code/version/hash chiudono la capability. L'abilitazione di una capability non
abilita le altre. Questo gate operativo non modifica l'hash della policy e non
reinterpreta runtime già persistiti.

Attore della transizione, executor canonico e worker instance sono identità distinte.

### Gate e kill switch

Admission, claim, heartbeat e successo richiedono contemporaneamente:

```text
AI_ORCHESTRATOR_WORKER_ENABLED=1
stateMachineEnabled=true
dispatchEnabled=true
syntheticDataOnly=true
provider=mock
externalProvidersEnabled=false
runtime policy e capability esatte
kill switch della capability specifica enabled=true
```

La migration preserva il vincolo fisico PR74
`AiOrchestratorSetting_dispatch_disabled_check`: nella catena production
PostgreSQL continua a rifiutare `dispatchEnabled=true`. La sua eventuale
rimozione richiede una futura migration separata e un'autorizzazione esplicita.
I test positivi aprono il gate soltanto tramite DDL temporaneo nel PostgreSQL
effimero confermato e ripristinano valore e constraint in `finally`. Il gate
ambiente è exact-match e manca per default. La chiusura dei gate impedisce
nuovo lavoro; surrender, recovery e supersession degli idle ineleggibili
restano operazioni di sola riduzione del rischio.

Questa Foundation non espone un comando di amministrazione dei kill switch.
La futura Admin Control Plane dovrà aggiungere RBAC, conferma, motivazione e
audit delle modifiche senza poter alterare identità o hash canonici.

`automaticDispatchAllowed=false` resta immutato: la pianificazione non conferisce capability. L'eventuale autorizzazione runtime richiede tutti i gate separati sopra.

### Fase corrente e barriera umana

Il database confronta definition hash, `phaseCode`, `phaseEntrySequence`, `correctionCycle` e stato corrente con ledger e workflow persistiti. Un job può essere ammesso, claimato o completato soltanto nella stessa identità di fase.

La presenza di una transizione verso `HUMAN_APPROVAL` blocca definitivamente l'automazione di questa Foundation. Nessuna funzione applica transizioni; WF-018..WF-023 restano negate dalla porta esistente.

### Concorrenza

La policy v1 usa limiti conservativi pari a uno globalmente, per workflow e per executor config. Il lock breve sul singleton serializza la decisione di claim e rende i conteggi non racy. Una versione successiva potrà aumentare i limiti senza cambiare il significato dei record v1.

### Osservabilità

Gli eventi materiali (`ADMITTED`, `CLAIMED`, retry, surrender, recovery e
terminali) sono append-only, minimizzati, hashati e concatenati per runtime.
L'append è serializzato per runtime. Constraint trigger differiti verificano al
commit receipt, attempt, fencing, stato runtime ed evento come un'unica
transizione semantica. Indici unici parziali impongono esattamente un
`ADMITTED`, un `CLAIMED` e, per ogni attempt concluso, un solo evento terminale
coerente con outcome, causa e timestamp. Gli heartbeat aggiornano soltanto attempt/runtime per
evitare audit amplification. Non vengono persistiti prompt, output, documenti,
eccezioni, credenziali o dati cliente.

## Compatibilità

- Nessuna migration PR74/PR75 viene modificata.
- Nessun backfill, update o delete di ledger, job o outbox.
- Il replay PR74 resta `LEGACY_NOT_PLANNED` con zero job/runtime.
- I job PR75 vengono ammessi solo dopo rivalidazione esatta; `BLOCKED` e fuori fase restano esclusi.
- `AiRun`, `AiOutput` e il reconciler esistente restano separati e invariati.

## Alternative escluse

- Aggiungere `RUNNING` al job: reinterpretazione del lifecycle PR75.
- Aggiornare `deliveryState`: violazione dell'outbox append-only distribuito.
- Riutilizzare `AiRun`: mescola orchestrazione, provider runtime e dati CRM.
- Token senza fence monotono: consente scritture tardive dopo takeover.
- Retry libero dal chiamante: abilita loop e retry storm.
- Nuovo secondo flag database al posto di `dispatchEnabled`: crea autorità ambigue.
- Processo worker nella stessa PR: allargherebbe la superficie operativa prima della validazione del protocollo.

## Passi successivi esclusi da questa decisione

Una PR distinta potrà introdurre un processo mock-only che invochi queste primitive. Handler, artefatti, fan-in, completion transition, uso di `AiRun`, qualunque rete/provider e ogni attivazione production richiederanno decisioni e review separate.
