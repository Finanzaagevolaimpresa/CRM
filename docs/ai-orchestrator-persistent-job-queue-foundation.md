# AI Orchestrator: Persistent Job Queue Foundation v1

Questa fondazione aggiunge la rappresentazione persistente e passiva dei job conseguenti alle transizioni della State Machine Foundation v1.1. Non aggiunge UI, route pubbliche, worker, cron, unità systemd, claim, lease, dispatch, esecuzione agente o chiamate provider. Il provider resta esclusivamente `mock` e i payload sono soltanto sintetici.

La decisione architetturale è descritta nell'[ADR-0002](adr/0002-ai-orchestrator-persistent-job-queue-foundation.md).

## Contratti versionati

```text
workflowKey = FAI-AUDIT-WORKFLOW@1.1
catalogKey  = FAI-AUDIT-JOB-CATALOG@1.0
catalogHash = eca7f4174ab8a188ef21df6758ab6cfd081dd51a126f47097f6a3706ec7bbb9e
```

Il catalogo comprende tredici definizioni immutabili per hash. Ogni definizione dichiara `jobVersion=1.0`, provider `mock`, `dataMode=synthetic`, `automaticDispatchAllowed=false`, bundle e transizione di completamento prevista. L'hash complessivo copre definizioni, ordine e regole di planning.

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

## Schema dati

### `AiWorkflowJob`

Conserva workflow e transizione sorgente, catalogo/versione/hash, job/versione/definition hash, mapping di completion, slot e bundle, dedupe key, stato, policy mock/synthetic, payload tecnico e relativo hash, correlation id e timestamp di planning o blocco.

Vincoli principali:

- unique su `dedupeKey`;
- unique su transizione, job version e slot;
- catalogo esattamente v1 e mapping esattamente canonico;
- stato soltanto `PLANNED` o `BLOCKED`;
- provider `mock`, dati `synthetic`, dispatch automatico falso;
- payload e campi identitari immutabili;
- nessun DELETE.

### `AiWorkflowJobOutboxEvent`

Conserva un solo evento `AI_JOB_PLANNED` v1 per job, con event key canonica, payload/hash, stato `PENDING` e timestamp. La coppia job/event type e la event key sono univoche. UPDATE e DELETE sono rifiutati: non esiste ancora un consumer.

## Dedupe canonica

La dedupe key è SHA-256 del JSON canonico contenente catalog key/hash, workflow instance, idempotency key del comando, codice e sequenza della transizione, ciclo di correzione, job key e slot. Il bundle key sostituisce job key/slot con il bundle code.

Questo rende distinti:

- job diversi dello stesso bundle;
- transizioni diverse o nuovi cicli di correzione;
- comandi causali diversi.

Il replay dello stesso comando riusa la transizione e il piano già persistiti. Un unique index costituisce la seconda barriera contro duplicati.

## Transazione atomica

Per una transizione accettata, la porta interna esegue nella medesima transazione `SERIALIZABLE`:

1. validazione dei setting fail-closed, attore, permessi, stato, milestone, gate e precondizioni;
2. reservation idempotente del comando;
3. calcolo puro del piano e del `planHash`;
4. compare-and-swap dell'istanza;
5. inserimento del ledger con metadati del piano;
6. inserimento di ciascun job `PLANNED` e del relativo outbox `PENDING`;
7. chiusura del comando e audit minimizzato;
8. verifica differita PostgreSQL di cardinalità, mapping, outbox e hash; quindi commit.

Qualunque incoerenza effettua rollback di stato, ledger, comando, job, outbox e audit di successo. Un piano vuoto è comunque hashato e verificato.

## Lifecycle passivo

```text
PLANNED ── reason code + blockedAt ──> BLOCKED
```

Non esistono altri stati. `BLOCKED` è terminale in questa Foundation. Non esistono claim, lease, fencing, attempt, retry, esito, artefatto o collegamento ad `AiRun`. L'outbox resta `PENDING`; la sua presenza non è una capability e non abilita dispatch.

## Payload e minimizzazione

Il payload job contiene soltanto:

- identità e versione del workflow sintetico;
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
