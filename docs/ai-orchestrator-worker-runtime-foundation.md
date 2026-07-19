# AI Orchestrator Worker Runtime Foundation v1

Questa Foundation aggiunge il protocollo persistente del futuro worker senza installare o avviare un worker. Tutti i percorsi restano interni, sintetici, mock-only e senza rete/provider call.

## Confine della release

Incluso:

- policy runtime/capability `FAI-AUDIT-WORKER-RUNTIME-POLICY@1.0`;
- kill switch persistente separato, disabilitato per default, per ciascuna delle
  tredici capability canoniche;
- admission transazionale dell'outbox tramite receipt separata;
- runtime e attempt persistenti;
- claim atomico, lease, heartbeat e fencing token;
- retry/backoff, surrender, terminalizzazione e recovery;
- supersession batch-limitata degli idle non più eleggibili, invocabile soltanto
  come riduzione del rischio e mai schedulata;
- audit runtime append-only, serializzato e semanticamente legato al lifecycle;
- controlli PostgreSQL sulla fase e sull'executor.

Escluso:

- processo, cron, timer, systemd o script schedulabile;
- handler agente, prompt, output e artefatti;
- `AiRun` e reconciler AI esistente;
- UI, route o API pubbliche;
- avanzamento del workflow o fan-in;
- OpenAI, fetch, provider esterno o accesso CRM reale;
- deploy o attivazione production.

## Persistenza

`AiWorkflowJob` e `AiWorkflowJobOutboxEvent` restano invariati. La migration non esegue backfill. Un evento viene ammesso soltanto quando il worker gate applicativo e tutti i gate database sono aperti; runtime e receipt nascono nella stessa transazione.

Constraint trigger differiti verificano lo stato finale della transazione:
receipt e `ADMITTED`, claim/attempt/`CLAIMED`, outcome runtime e relativo
evento devono essere completi e coerenti prima del commit. Indici parziali
impongono un solo `ADMITTED`, un solo `CLAIMED` e un solo evento terminale per
attempt; l'evento terminale deve corrispondere all'outcome e al suo timestamp.
L'append dell'audit
acquisisce un lock transazionale per runtime, evitando due sequence concorrenti.

| Entità | Funzione |
|---|---|
| `AiWorkflowJobRuntime` | Stato tecnico corrente, disponibilità effettiva, lease e fence |
| `AiWorkflowJobAttempt` | Snapshot immutabile del claim e outcome fenced |
| `AiWorkflowOutboxConsumption` | Receipt unica dell'ammissione outbox |
| `AiWorkflowJobRuntimeEvent` | Audit tecnico hashato e concatenato |
| `AiOrchestratorWorkerCapabilitySetting` | Kill switch operativo per capability, default `false` |

## Policy v1

| Parametro | Valore |
|---|---:|
| Lease | 120 secondi |
| Heartbeat indicativo | 30 secondi |
| Durata massima attempt | 600 secondi |
| Failure retryable massime | 3 |
| Backoff iniziale | 30 secondi |
| Backoff massimo | 15 minuti |
| Jitter deterministico | 0–20% |
| Concorrenza globale | 1 |
| Concorrenza per workflow | 1 |
| Concorrenza per executor config | 1 |

Non esiste configurazione runtime libera. Cambiare valori richiede una nuova versione e un nuovo hash policy.

## Kill switch

Il percorso positivo richiede `AI_ORCHESTRATOR_WORKER_ENABLED=1`, entrambi i flag database attivi, modalità sintetica, provider mock e provider esterni disabilitati. La configurazione production deve restare:

```text
AI_ORCHESTRATOR_WORKER_ENABLED=0
stateMachineEnabled=false
dispatchEnabled=false
syntheticDataOnly=true
provider=mock
externalProvidersEnabled=false
AiOrchestratorWorkerCapabilitySetting.enabled=false per tutte le 13 capability
```

Record mancante, non canonico o con versione/hash non corrispondenti equivale a
capability disabilitata. Admission, claim, heartbeat e successo rileggono e
lockano il relativo record; surrender, recovery e supersession restano
disponibili come riduzione del rischio. Questa PR non fornisce alcun comando,
UI o route per cambiare tali valori: la futura Admin Control Plane dovrà
aggiungere autorizzazione, motivazione e audit amministrativo.

## HUMAN_APPROVAL

Ogni operazione rilegge fase, ingresso fase e ciclo dal ledger. Un workflow che abbia raggiunto `HUMAN_APPROVAL` non è più eleggibile, anche se una futura transizione lo riportasse in uno stato precedente. La Foundation non importa né invoca il workflow service e non applica WF-001..WF-023.

Failure e recovery derivano dal database le cause strutturali di supersession.
Il worker non può dichiarare autonomamente `HUMAN_APPROVAL_REACHED`,
`JOB_BLOCKED`, `PHASE_SUPERSEDED` o una causa di invalidità executor. Una lease
scaduta ancora eleggibile usa `LEASE_EXPIRED`; una lease divenuta ineleggibile
termina `SUPERSEDED` con la causa canonica esatta e senza consumare retry budget.

## Verifiche richieste

```bash
npm test
npx tsc --noEmit
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/fai_crm_test?schema=public" npx prisma validate
npm run prisma:generate
RUN_DB_TESTS=1 AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1 npm run test:db
npm run build
git diff --check
```

Migration chain, upgrade PR74→PR75→Worker Runtime e test di concorrenza devono
essere eseguiti su PostgreSQL 16 effimero dedicato. La migration production
preserva `AiOrchestratorSetting_dispatch_disabled_check` e PostgreSQL continua
a rifiutare `dispatchEnabled=true`. I test positivi rimuovono temporaneamente
il constraint soltanto con entrambi i flag di conferma DB, quindi in `finally`
ripristinano `dispatchEnabled=false`, ricreano e validano lo stesso constraint.
Non sono ammessi test production con workflow o job reali.

## Rollback

Prima del merge/deploy non esiste rollback database: si ritira la Draft PR. Dopo un futuro deploy autorizzato, il rollback ordinario mantiene `AI_ORCHESTRATOR_WORKER_ENABLED=0`, `stateMachineEnabled=false` e `dispatchEnabled=false`, ripristina l'immagine precedente e lascia intatte le nuove tabelle. Non usare reset, truncate, delete o downgrade distruttivi.

La decisione completa è nell'[ADR-0003](adr/0003-ai-orchestrator-worker-runtime-foundation.md).
