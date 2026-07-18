# ADR-0002: Persistent Job Queue Foundation v1

- Stato: Proposto
- Data: 2026-07-17
- Ambito: AI Orchestrator, pianificazione persistente passiva
- Dipendenza: State Machine Foundation v1.1 (`FAI-AUDIT-WORKFLOW@1.1`)

## Contesto

La State Machine Foundation v1.1 persiste istanze, comandi e transizioni fino alla barriera `HUMAN_APPROVAL`, ma non rappresenta ancora il lavoro tecnico conseguente a una transizione. Prima di introdurre qualunque worker serve un contratto persistente, versionato, idempotente e verificabile che distingua la decisione di pianificare dalla futura decisione di eseguire.

La produzione deve rimanere fail-closed: `stateMachineEnabled=false`, `dispatchEnabled=false`, provider `mock`, soli dati sintetici e provider esterni disabilitati. Questa decisione non autorizza l'attivazione della state machine, il dispatch, un worker o una chiamata provider.

## Decisione

Introduciamo una coda persistente passiva con due modelli additivi:

- `AiWorkflowJob`, per l'intento canonico conseguente a una transizione;
- `AiWorkflowJobOutboxEvent`, per l'evento transazionale `AI_JOB_PLANNED` associato uno-a-uno al job.

Una transizione accettata costruisce un piano puro dal catalogo `FAI-AUDIT-JOB-CATALOG@1.0` e persiste ledger, job e outbox nella stessa transazione `SERIALIZABLE`. Se job o outbox non corrispondono esattamente al mapping canonico, l'intera transazione fallisce. Le transizioni senza mapping persistono un piano vuoto, comunque identificato da un hash canonico.

Il catalogo comprende tredici tipi di job, ciascuno con versione, hash di definizione, bundle, modalità di completamento, transizione di completamento prevista e binding a uno snapshot executor. Il mapping `jobCode → executor agent code/config version/config hash` è esplicito, versionato e incluso nel catalog hash. Non deriva dal payload né dall'attore della transizione. Qualunque modifica semantica richiede una nuova versione del catalogo e una migration esplicita: non è ammessa una reinterpretazione silenziosa dei job già persistiti.

## Identità e deduplica

La dedupe key SHA-256 lega esattamente:

- versione e hash del catalogo;
- workflow instance;
- workflow definition hash;
- phase code e phase-entry sequence derivati dal ledger;
- idempotency key del comando sorgente;
- codice e sequenza della transizione sorgente;
- stato e state version sorgenti;
- ciclo di correzione;
- executor agent ID/code e config version/hash;
- job code/version e slot canonico.

La bundle key usa la medesima identità causale e il bundle code, ma omette l'executor affinché resti comune ai job del bundle. La dedupe key è univoca globalmente; anche `(sourceTransitionId, jobCode, jobVersion, slotKey)` è univoco. Il replay coerente del comando rilegge il piano già persistito e non crea nuove righe.

Il `planHash` copre identità causale e lista ordinata di job, inclusi definition hash, slot, bundle key, dedupe key e payload hash. Un trigger differito PostgreSQL ricostruisce l'hash dai record persistiti e lo confronta con i metadati del ledger.

L'identità di fase è deterministica. Una transizione che cambia stato apre la fase di destinazione alla propria sequence; una self-transition riusa l'ultimo phase-entry validato dal ledger e fissato nel guard snapshot. In particolare WF-004/WF-009 aprono `DATA_VALIDATION`, WF-011 apre `AI_DRAFT`, WF-013/WF-016 aprono `INDEPENDENT_REVIEW` e WF-015 apre `NEEDS_CORRECTION` incrementando il correction cycle.

## Binding executor

La porta risolve ogni executor nella stessa transazione `SERIALIZABLE` del planning. Agente e snapshot devono esistere, essere attivi, `mock`, senza model esterno, avere la versione corrente prevista e produrre esattamente il config hash catalogato. Una FK composita `RESTRICT` lega il job a `AiAgentConfigVersion(agentId, version)`. Gli snapshot sono protetti da UPDATE/DELETE; ID, code, versione e hash restano inoltre nel job, nel payload, nella dedupe key, nel plan hash e nell'outbox. Un futuro worker dovrà ricalcolare lo stesso hash prima di interpretare la configurazione.

## Lifecycle

Il lifecycle ammesso in questa Foundation è deliberatamente incompleto:

```text
PLANNED ── blocco di sicurezza esplicito ──> BLOCKED
```

Un job nasce soltanto `PLANNED`. L'unico aggiornamento ammesso è `PLANNED→BLOCKED`, con timestamp e reason code stabile. Identità e payload sono immutabili; UPDATE successivi e DELETE sono rifiutati. Non esistono `RUNNING`, lease, claim, attempt, retry, dispatch, esito o artefatto agente.

L'outbox nasce `PENDING` ed è append-only. In questa PR non esiste un consumer e `PENDING` non significa autorizzato al dispatch. La consegna, l'eventuale stato terminale e il fencing richiederanno una decisione successiva.

`availableAt` è obbligatorio, coincide con `plannedAt` ed è immutabile. Gli indici espongono stato/disponibilità globale e per workflow, fase/ciclo, executor/config e correlation ID, ma il timestamp non costituisce una capability di dispatch.

## Confini dei dati

Job e outbox contengono esclusivamente identità tecniche sintetiche: contratto workflow/catalogo, transizione e comando sorgente, correlation id, ciclo, mapping del job e hash. Non contengono client, azienda, progetto o servizio CRM, documenti, prompt, output, token, cookie, credenziali o segreti. PostgreSQL valida anche la cardinalità esatta delle chiavi dei payload per impedire l'aggiunta silenziosa di dati.

`AiRun` e il reconciler esistenti restano separati e invariati. La pianificazione non crea un run e non chiama provider.

## Barriera Foundation

Il mapping crea job soltanto in conseguenza di transizioni comprese fra WF-004 e WF-016. WF-017 non crea job e la porta applicativa continua a negare WF-018..WF-023 prima di ogni planning. Nessun job ha una completion transition successiva a WF-016. La barriera a `HUMAN_APPROVAL` resta quindi invariata.

## Enforcement PostgreSQL

La migration aggiunge vincoli e trigger per verificare:

- catalogo, mapping, hash di definizione, slot e cardinalità esatti;
- setting sicuro, provider esterni disabilitati e dispatch disabilitato;
- binding a workflow, comando e transizione sorgente;
- identità di definition, fase/phase-entry, stato/versione sorgenti e correction cycle;
- binding composito e hash dello snapshot executor mock;
- dedupe key, bundle key, payload hash, event key e outbox payload ricalcolati;
- payload JSON minimizzati e privi di campi aggiuntivi;
- conteggio esatto job/outbox e `planHash` prima del commit;
- outbox uno-a-uno obbligatoria per ogni job;
- lifecycle e immutabilità.

I trigger di consistenza transizione/piano e job/outbox sono `DEFERRABLE INITIALLY DEFERRED`, così la porta applicativa può inserire ledger, job e outbox in ordine nella stessa transazione senza rendere osservabile uno stato parziale.

## Compatibilità del ledger PR #74

La migration aggiunge alla transizione un marcatore nullable senza aggiornare le righe esistenti. `jobPlanningVersion=NULL` identifica esclusivamente ledger append-only precedente alla queue Foundation. Il replay esatto di tali comandi restituisce `LEGACY_NOT_PLANNED`, zero job e hash nullo, senza mutare o completare retroattivamente il record. Il servizio rifiuta un legacy associato a job/outbox. Dopo la migration, un trigger differito impone `jobPlanningVersion=1` e metadati/piano v2 completi a ogni nuova transizione, inclusi i piani vuoti.

## Conseguenze

Vantaggi:

- il lavoro futuro ha identità stabile e auditabile prima di esistere un worker;
- replay e concorrenza non duplicano intenti;
- il database rifiuta scritture parziali o non canoniche;
- catalogo e mapping possono evolvere soltanto con versioni esplicite;
- la coda non amplia il confine di sicurezza o la superficie pubblica.

Costi e limiti:

- il mapping è duplicato intenzionalmente in TypeScript e SQL per ottenere enforcement indipendente; i test devono mantenerli identici;
- outbox `PENDING` crescerà senza consumer se la state machine viene usata in un ambiente non production; questa PR non autorizza tale uso in produzione;
- i record append-only richiedono un database effimero dedicato nei test;
- non esiste ancora alcun percorso per completare un job o avanzare automaticamente la state machine.

## Alternative escluse

- Coda in memoria: non offre atomicità, replay o audit dopo un riavvio.
- Uso di `AiRun`: mescolerebbe un intento passivo con un'esecuzione già dotata di lifecycle e provider.
- Pubblicazione dopo il commit senza outbox: espone il dual-write transizione/evento.
- Worker nella stessa PR: introdurrebbe claim, lease, dispatch ed egress prima di aver stabilizzato il contratto persistente.
- Payload con riferimenti CRM reali: non esiste ancora una policy ABAC e di minimizzazione approvata per tale collegamento.

## Criteri per una decisione futura

Una PR successiva per il worker dovrà definire separatamente claim atomico, lease e fencing token, retry/backoff, terminalizzazione, consumo outbox, capability dell'agente, limiti di concorrenza, osservabilità, arresto a `HUMAN_APPROVAL` e kill switch. Questa ADR non autorizza nessuno di tali comportamenti.
