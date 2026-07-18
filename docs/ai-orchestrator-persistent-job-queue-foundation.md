# AI Orchestrator: Persistent Job Queue Foundation v1

Questa fondazione aggiunge la rappresentazione persistente e passiva dei job conseguenti alle transizioni della State Machine Foundation v1.1. Non aggiunge UI, route pubbliche, worker, cron, unità systemd, claim, lease, dispatch, esecuzione agente o chiamate provider. Il provider resta esclusivamente `mock` e i payload sono soltanto sintetici.

La decisione architetturale è descritta nell'[ADR-0002](adr/0002-ai-orchestrator-persistent-job-queue-foundation.md).

## Contratti versionati

```text
workflowKey = FAI-AUDIT-WORKFLOW@1.1
catalogKey  = FAI-AUDIT-JOB-CATALOG@1.0
catalogHash = 3e99436a4734323a423907bf742f71e632e433f8d0203f28da0c96bcc44a45f9
```

Il catalogo comprende tredici definizioni immutabili per hash. Ogni definizione dichiara `jobVersion=1.0`, provider `mock`, `dataMode=synthetic`, `automaticDispatchAllowed=false`, bundle, transizione di completamento e binding executor. L'hash complessivo copre definizioni, ordine, regole di planning e mapping executor v1.

## Mapping transizione-job

| Transizione accettata | Job pianificati in ordine | Completion attesa | Modalità |
|---|---|---|---|
| WF-004 | `DOCUMENT_INGESTION` | WF-005 | singolo |
| WF-005 | `DOCUMENT_CLASSIFICATION` | WF-006 | singolo |
| WF-006 | `EVIDENCE_EXTRACTION` | WF-007 | singolo |
| WF-009 | `DOCUMENT_INGESTION` | WF-005 | singolo |
| WF-010 | `FINANCIAL_ANALYSIS`, `CREDIT_ANALYSIS`, `CALCULATIONS` | WF-011 | tutti nel bundle |
| WF-011 | `FINDINGS_DRAFTING` | WF-012 | singolo |
| WF-012 | `REPORT_COMPOSITION` | WF-013 | singolo |
| WF-013 | `SCHEMA_REVIEW`, `NUMERIC_REVIEW`, `SOURCE_REVIEW`, `RED_TEAM_REVIEW` | WF-014 | tutti nel bundle |
| WF-015 | `CORRECTION` | WF-016 | singolo |
| WF-016 | `SCHEMA_REVIEW`, `NUMERIC_REVIEW`, `SOURCE_REVIEW`, `RED_TEAM_REVIEW` | WF-014 | tutti nel bundle |

WF-001..003, WF-007..008, WF-014 e WF-017 producono un piano vuoto. WF-018..023 restano fuori dalla porta applicativa con `FOUNDATION_SCOPE_LIMIT` e non raggiungono il planner. Nessun mapping attraversa la barriera `HUMAN_APPROVAL`.

### Mapping job-executor v1

| Job | Executor agent code | Config |
|---|---|---|
| `DOCUMENT_INGESTION`, `DOCUMENT_CLASSIFICATION` | `verifica_ai_preliminare_fai` | v1 + hash canonico |
| `EVIDENCE_EXTRACTION`, `FINDINGS_DRAFTING` | `pre_analisi_ai_ammissibilita_fai` | v1 + hash canonico |
| `FINANCIAL_ANALYSIS`, `CALCULATIONS` | `business_plan_fai` | v1 + hash canonico |
| `CREDIT_ANALYSIS` | `audit_ai_bancabilita_fai` | v1 + hash canonico |
| `REPORT_COMPOSITION` | `dossier_strategico_fai` | v1 + hash canonico |
| `SCHEMA_REVIEW`, `NUMERIC_REVIEW`, `SOURCE_REVIEW`, `RED_TEAM_REVIEW` | `revisore_ai_fai` | v1 + hash canonico |
| `CORRECTION` | `ottimizzazione_ai_progetto_fai` | v1 + hash canonico |

Il chiamante non può fornire o derivare questo binding dall'attore della transizione. La porta risolve agente e snapshot nella stessa transazione `SERIALIZABLE` e richiede agente/config attivi, provider `mock`, nessun model esterno, versione corrente e hash esatto. Il job conserva ID database, code stabile, versione e hash; la FK composita verso `AiAgentConfigVersion(agentId, version)` usa `RESTRICT`. Gli snapshot sono già protetti contro UPDATE/DELETE e un futuro consumer dovrà comunque ricalcolare l'hash persistito prima di interpretarli.

## Schema dati

### `AiWorkflowJob`

Conserva workflow e definition hash, identità di fase, transizione/stato/versione sorgente, correction cycle, executor/config/hash, catalogo/versione/hash, job/versione/definition hash, mapping di completion, slot e bundle, dedupe key, stato, policy mock/synthetic, payload tecnico e relativo hash, correlation id, `plannedAt`, `availableAt` e timestamp di blocco.

Vincoli principali:

- unique su `dedupeKey`;
- unique su transizione, job version e slot;
- catalogo esattamente v1 e mapping esattamente canonico;
- stato soltanto `PLANNED` o `BLOCKED`;
- provider `mock`, dati `synthetic`, dispatch automatico falso;
- `availableAt=plannedAt`, entrambi immutabili e privi di qualunque semantica di dispatch;
- indici per disponibilità globale/per workflow, fase-ciclo, executor-config e correlation id;
- payload e campi identitari immutabili;
- nessun DELETE.

### `AiWorkflowJobOutboxEvent`

Conserva un solo evento `AI_JOB_PLANNED` v1 per job, con event key canonica, payload/hash, stato `PENDING` e timestamp. La coppia job/event type e la event key sono univoche. UPDATE e DELETE sono rifiutati: non esiste ancora un consumer.

## Dedupe canonica

La dedupe key è SHA-256 del JSON canonico v2 contenente, nell'ordine semantico: catalog key/hash; workflow instance e definition hash; `phaseCode` e `phaseEntrySequence`; idempotency key del comando; codice e sequenza della transizione; stato e state version sorgenti; correction cycle; executor agent ID/code, config version/hash; job code/version e slot. Il bundle key usa la stessa identità causale ma omette l'executor e sostituisce job/slot con il bundle code, così resta comune a tutti i job del bundle.

Questo rende distinti:

- job diversi dello stesso bundle;
- transizioni diverse o nuovi cicli di correzione;
- comandi causali diversi.

Il replay dello stesso comando riusa la transizione e il piano già persistiti. Un unique index costituisce la seconda barriera contro duplicati.

## Transazione atomica

Per una transizione accettata, la porta interna esegue nella medesima transazione `SERIALIZABLE`:

1. validazione dei setting fail-closed, attore, permessi, stato, milestone, gate e precondizioni;
2. reservation idempotente del comando;
3. risoluzione e verifica fail-closed degli executor canonici;
4. derivazione di fase e phase-entry dal ledger/guard persistiti e calcolo puro del piano e del `planHash`;
5. compare-and-swap dell'istanza;
6. inserimento del ledger con metadati del piano;
7. inserimento di ciascun job `PLANNED` e del relativo outbox `PENDING`;
8. chiusura del comando e audit minimizzato;
9. verifica differita PostgreSQL di causalità, executor, cardinalità, mapping, outbox e hash; quindi commit.

Qualunque incoerenza effettua rollback di stato, ledger, comando, job, outbox e audit di successo. Un piano vuoto è comunque hashato e verificato.

## Lifecycle passivo

```text
PLANNED ── reason code + blockedAt ──> BLOCKED
```

Non esistono altri stati. `BLOCKED` è terminale in questa Foundation. Non esistono claim, lease, fencing, attempt, retry, esito, artefatto o collegamento ad `AiRun`. L'outbox resta `PENDING`; la sua presenza non è una capability e non abilita dispatch.

`availableAt` coincide con `plannedAt`, è immutabile e serve soltanto a definire in anticipo l'ordinamento temporale della futura coda. Non abilita worker, claim o dispatch.

## Identità di fase

Ogni piano lega `workflowDefinitionHash`, `phaseCode`, `phaseEntrySequence`, stato/versione sorgenti e correction cycle. Per una transizione che entra in un nuovo stato (`WF-004`, `WF-009`, `WF-011`, `WF-013`, `WF-015`, `WF-016`) il phase-entry è la sequenza della transizione stessa. Per le self-transition in `DATA_VALIDATION`, `AI_DRAFT` e `INDEPENDENT_REVIEW` il phase-entry è l'ultimo ingresso valido ricostruito dal ledger e già incluso nel guard snapshot. `WF-016` apre quindi una nuova fase review e un nuovo correction cycle; le review successive non possono collidere con quelle precedenti.

## Replay legacy PR #74

La migration aggiunge `jobPlanningVersion` nullable senza riscrivere il ledger. Le transizioni PR #74 restano `NULL`: un replay con request hash identico restituisce `LEGACY_NOT_PLANNED`, `plannedJobCount=0` e `jobPlanHash=null`, senza backfill e senza job/outbox. Il replay fallisce se trova artefatti queue associati a un record legacy. Ogni nuova transizione è invece protetta da trigger differito e deve avere `jobPlanningVersion=1`, metadati v2 e piano completo, anche quando il piano è vuoto.

## Payload e minimizzazione

Il payload job contiene soltanto:

- identità e versione del workflow sintetico;
- definition hash, fase/phase-entry, stato/versione sorgenti e correction cycle;
- executor agent ID/code e config version/hash;
- catalog key/hash;
- transizione sorgente, sequenza, idempotency key, correlation id, stati e ciclo;
- job/versione/hash, completion mapping, slot/bundle e policy mock/no-dispatch.

Il payload outbox contiene le medesime identità tecniche minimizzate e l'hash del payload job. I trigger PostgreSQL verificano il numero esatto di campi a ogni livello. Sono esclusi dati cliente, azienda, progetto o servizio, documenti, prompt, output, cookie, password, token, credenziali, API key e segreti.

## Configurazione production

Questa Draft PR non autorizza deploy. In produzione devono restare:

| Controllo | Valore |
|---|---|
| `AiOrchestratorSetting.stateMachineEnabled` | `false` |
| `AiOrchestratorSetting.dispatchEnabled` | `false` |
| `AiOrchestratorSetting.syntheticDataOnly` | `true` |
| `AiOrchestratorSetting.provider` | `mock` |
| `AiControlSetting.externalProvidersEnabled` | `false` |
| `AI_EXTERNAL_PROVIDERS_ENABLED` | `false` |

La migration non aggiorna questi flag, non crea workflow e non crea job. Non aggiunge variabili worker, comandi runtime, timer o servizi.

## Verifica

```bash
npm test
npx tsc --noEmit
DATABASE_URL=postgresql://... npx prisma validate
npm run prisma:generate
npm run build
RUN_DB_TESTS=1 AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1 npm run test:db
git diff --check
```

La catena completa delle migration e i test DB devono essere eseguiti su PostgreSQL 16 effimero con `test` nel nome di database o schema. Le prove coprono mapping e cardinalità, replay senza duplicati, outbox uno-a-uno, hash canonici, rollback della transazione incompleta, stato `BLOCKED`, divieto `RUNNING`, immutabilità e assenza di nuovi `AiRun`.

## Rischi residui e confini

- TypeScript e SQL replicano intenzionalmente il mapping: hash fissati e test PostgreSQL rilevano divergenze.
- Outbox `PENDING` non viene drenata: in produzione la state machine resta disabilitata; nessun consumer viene introdotto.
- La migration è additiva e append-only: un rollback applicativo lascia le tabelle intatte per preservare compatibilità e audit.
- L'introduzione di un worker richiederà una nuova ADR e una PR separata. Questa Foundation non ne anticipa l'autorizzazione.
