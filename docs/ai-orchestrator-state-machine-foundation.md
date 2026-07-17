# AI Orchestrator: State Machine Foundation v1.1

Questa guida descrive la fondazione introdotta dalla prima PR dell'AI Orchestrator MVP. Il suo perimetro è deliberatamente strutturale: definizione versionata della macchina, persistenza additiva, idempotenza, concorrenza, audit e test. Non introduce coda, worker, esecuzione agente, nuova route pubblica o rilascio automatico.

La correzione semantica del workflow è motivata nell'[ADR-0001](adr/0001-ai-audit-workflow-v1-1.md).

## Contratto della fondazione

Il workflow canonico è identificato dalla coppia:

```text
workflowCode    = FAI-AUDIT-WORKFLOW
workflowVersion = 1.1
workflowKey     = FAI-AUDIT-WORKFLOW@1.1
```

La definizione applicativa espone 16 stati e 23 transizioni. All'avvio dei test vengono verificate unicità dei codici, validità degli endpoint, raggiungibilità, conteggi e assenza di percorsi automatici oltre `HUMAN_APPROVAL`.

Ogni istanza conserva anche il `definitionHash`: codice, versione e hash formano il contratto effettivamente eseguito. L'hash copre matrice, actor, permessi, provider mock, blocco dei provider esterni, limite e incremento delle correzioni, reason code e divieto di dispatch della foundation. Una definizione diversa non può essere applicata silenziosamente a un'istanza esistente.

Gli artefatti versionati della PR sono:

- `src/lib/ai-orchestrator/audit-workflow-v1-1.ts`: definizione, hash canonico, invarianti e `evaluateAuditWorkflowTransition()` fail-closed;
- `prisma/migrations/20260717120000_ai_orchestrator_state_machine_foundation/migration.sql`: persistenza e vincoli PostgreSQL;
- `tests/ai-orchestrator-state-machine.test.ts`: invarianti e matrice delle transizioni;
- `tests/db/ai-orchestrator-foundation-db.test.ts`: vincoli, idempotenza e concorrenza PostgreSQL.

## Modello dati additivo

La migration della PR 1 aggiunge soltanto nuove tabelle, indici, vincoli e controlli. Non rinomina o elimina colonne esistenti, non riscrive `AiRun` e non esegue backfill inventati sui flussi CRM correnti.

| Modello | Responsabilità |
|---|---|
| `AiOrchestratorSetting` | Singleton globale: dispatch disabilitato, soli dati sintetici e provider mock come default sicuri. |
| `AiWorkflowInstance` | Istanza idempotente del caso con contratto versionato, campi contesto riservati, stato corrente, `stateVersion` e ciclo di correzione. |
| `AiWorkflowCommand` | Intento idempotente, actor kind, stato/versione attesi, hash richiesta, correlazione ed esito o diniego. |
| `AiWorkflowTransition` | Ledger append-only della transizione accettata, con sequenza, versioni, guard snapshot e correlazione. |

I campi di contesto a cliente, azienda, progetto e servizio sono riservati all'evoluzione futura ma un `CHECK` li obbliga tutti a `NULL` nella PR 1: non esiste ancora un modo verificabile per distinguere un record CRM reale da uno sintetico. L'utente che crea l'istanza resta obbligatorio. La migration non collega né modifica record CRM esistenti e non esegue backfill. Le foreign key sono già predisposte con comportamento restrittivo; identità di istanza e comando, stato, esiti e catena del ledger sono inoltre protetti da vincoli e trigger PostgreSQL.

La coda persistente (`outbox`, job e attempt), le escalation e gli artefatti/review versionati non fanno parte di questa migration: saranno additive nelle PR successive.

## Feature flag e provider

Il setting iniziale deve essere:

| Campo | Valore sicuro |
|---|---|
| `dispatchEnabled` | `false` |
| `syntheticDataOnly` | `true` |
| `provider` | `mock` |

La riga assente, duplicata, illeggibile o con valore non ammesso non abilita nulla. La PR 1 non ha un worker e non offre un comando di dispatch: il flag documenta e persiste la postura fail-closed sulla quale si innesteranno le PR successive.

`AI_ORCHESTRATOR_WORKER_ENABLED` è un controllo infrastrutturale previsto per la futura PR del worker; non è una variabile riconosciuta dalla State Machine Foundation. I controlli `AI_EXTERNAL_PROVIDERS_ENABLED`, `AI_ALLOWED_MODELS` e lo switch database dell'[AI Control Plane](ai-control-plane.md) restano invariati e disabilitati.

## Atomicità di un comando

La porta applicativa interna della PR 1 tratta un comando nella seguente transazione PostgreSQL:

1. caricare setting, istanza e definizione esatta;
2. verificare identità, permessi, stato e `stateVersion` attesi e precondizioni della transizione;
3. riservare o rileggere `AiWorkflowCommand` usando l'idempotency key;
4. applicare compare-and-swap sull'istanza;
5. inserire una sola riga `AiWorkflowTransition` con sequenza monotona;
6. registrare l'evento `AuditLog` minimizzato;
7. chiudere il comando con risultato e nuova versione;
8. eseguire il commit.

Se un passaggio fallisce, stato, transizione e audit di successo non devono essere parzialmente visibili. Dopo la reservation, un diniego viene chiuso come esito `REJECTED` del comando, senza mutare l'istanza e senza creare una transizione fittizia. Richieste malformate, actor inesistenti, actor kind errati e mismatch che non possono soddisfare i `CHECK` del command vengono negati prima della reservation e registrati soltanto in `AuditLog`.

La PR 1 non espone questa porta tramite UI o API production. Gli entrypoint interni accettano un'identità già scelta dal chiamante e non sono quindi un confine di autenticazione: non devono essere collegati direttamente a payload HTTP. La futura porta umana dovrà derivare l'utente dalla sessione; worker e agenti dovranno presentare job, lease e capability verificabili.

Il motore non presume permessi impliciti: il servizio rilegge dal database utente attivo, ruolo e override e passa al motore solo i permessi effettivi. WF-001..004, WF-009 e WF-010 richiedono `ai.run`; WF-017 richiede `ai.review`; WF-018..023 richiedono `ai.approve`. Le transizioni `AGENT` e `SYSTEM` non ricevono permessi umani impliciti. L'ABAC sui record cliente non è applicabile in PR 1 perché i link CRM sono obbligatoriamente null; verrà aggiunto e testato prima di allentare il vincolo synthetic-only.

`workerDirective` descrive soltanto la semantica del passo successivo. Non è una capability e non autorizza un job: `automaticDispatchAllowed` è sempre `false` nella foundation e il ledger persiste esplicitamente questo valore. Agent code/capability, outbox, lease e policy di dispatch appartengono alle PR successive.

## Idempotenza e anti-duplicazione

Anche la creazione dell'istanza è idempotente: una `creationKey` UUID v4 globalmente univoca è legata al payload canonico dal `creationRequestHash` SHA-256. Il replay coerente riusa la stessa istanza; il riuso della chiave con hash diverso è un conflitto.

Per le transizioni, l'idempotency key è una UUID v4 generata per il comando e ha ambito nell'istanza di workflow. Il `requestHash` SHA-256 lega la chiave ai dati canonici che influenzano la decisione.

- Stessa chiave e stesso hash: dopo aver rivalidato attore attivo e permessi effettivi correnti, restituire l'esito già persistito senza nuova transizione o nuovo audit di successo.
- Stessa chiave e hash diverso: diniego per conflitto; nessuna mutazione dello stato o del ledger di successo. Il diniego resta registrabile in `AuditLog`.
- Nuova chiave con stato o versione attesi obsoleti: diniego per concorrenza; nessuna mutazione dello stato o nuova transizione. Il comando riservato viene chiuso `REJECTED` e il diniego viene auditato.
- Due comandi concorrenti validi sulla stessa `stateVersion`: il compare-and-swap consente un solo vincitore.
- Ogni comando accettato può produrre al massimo una transizione.
- La coppia istanza/sequenza è univoca e crescente.

Una self-transition valida è un nuovo evento di dominio: incrementa `stateVersion` e sequenza. Il replay dello stesso comando non è una self-transition e non incrementa nulla.

Queste garanzie riguardano la state machine. La deduplica dei job e il fencing delle lease saranno aggiunti con la coda e il worker, riutilizzando i principi già presenti in AI Runtime Reliability v1.

## Audit

`AiWorkflowTransition` è il ledger di dominio autorevole. `AuditLog` rende l'evento consultabile con il modello di audit comune al CRM. Per ogni transizione accettata devono essere ricostruibili almeno:

- workflow, versione e hash di definizione;
- comando, idempotency key e correlation id;
- `actorKind` `HUMAN`, `AGENT` o `SYSTEM` e la relativa identità esclusiva; per `AGENT` anche la versione immutabile della configurazione;
- transition code, stato/versione prima e dopo;
- hash dello snapshot dei guard e reason code;
- hash della transizione e hash della precedente per verificare la catena append-only;
- timestamp PostgreSQL.

Non vanno copiati nel ledger documenti, prompt, output integrali, segreti o payload sensibili. Gli hash dimostrano coerenza senza trasformare l'audit in un secondo archivio dati.

I dinieghi del motore hanno codici stabili:

```text
WORKFLOW_ID_MISMATCH
WORKFLOW_VERSION_MISMATCH
DEFINITION_HASH_MISMATCH
UNKNOWN_STATE
UNKNOWN_TRANSITION
STATE_MISMATCH
ACTOR_REQUIRED
UNKNOWN_ACTOR_KIND
ACTOR_NOT_ALLOWED
ACTOR_CONTEXT_INVALID
WORKER_STOP_REQUIRED
PERMISSION_NOT_GRANTED
GATE_NOT_PASSED
PRECONDITION_NOT_MET
EXTERNAL_PROVIDER_STATUS_UNKNOWN
EXTERNAL_PROVIDERS_ENABLED
MOCK_PROVIDER_REQUIRED
CORRECTION_CYCLE_INVALID
CORRECTION_LIMIT_REACHED
REASON_CODE_REQUIRED
MANUAL_RELEASE_REQUIRED
```

Un diniego non crea una riga `AiWorkflowTransition`.

## Revisione umana e barriera di rilascio

La prima vertical slice termina a `HUMAN_APPROVAL`. Il contratto richiede fan-in delle review indipendenti, gate in PASS e zero finding Critical/Major aperti; nella PR 1 queste sono precondizioni tipizzate e hashate, non ancora evidenze collegate ad artefatti persistiti.

Il contratto include `HUMAN_APPROVAL -> APPROVED` e `APPROVED -> RELEASED` per completezza del ciclo di vita, ma:

- nessun actor `AGENT` o `SYSTEM` può applicarle;
- WF-018..020 non sono ancora operativamente esposti: la PR degli artefatti dovrà fissare versione/checksum, ruolo e prova delle separazioni prima di abilitarli;
- il rilascio richiede un successivo comando manuale e doppio controllo;
- non esiste alcun percorso automatico da `HUMAN_APPROVAL` a `RELEASED`.

## Strategia di test

### Test unitari della definizione

- conteggio esatto di 16 stati e 23 transizioni;
- codici univoci; le coppie `from`/`to` ripetute sono soltanto quelle espressamente previste per milestone diverse;
- stato iniziale valido e tutti gli endpoint dichiarati;
- raggiungibilità dei 16 stati;
- verifica positiva di ciascuna delle 23 transizioni;
- verifica negativa di ciascuna transizione con stato iniziale errato;
- diniego fail-closed per codice, stato, actor, gate o versione sconosciuti;
- limite di due cicli di correzione;
- reason code obbligatorio per correzione, modifiche richieste, supersede e cancellazione;
- divieto per worker/agent sulle transizioni umane;
- assenza di un cammino automatico fino a `RELEASED`.

### Test PostgreSQL

- migration applicabile su database aggiornato e su database vuoto tramite l'intera catena Prisma;
- default globale `dispatchEnabled=false`, `syntheticDataOnly=true`, provider `mock`;
- vincoli su stato, versione, provider, idempotency key e request hash;
- replay idempotente senza duplicare transizione o audit di successo;
- conflitto stessa chiave/hash diverso;
- concorrenza su `stateVersion` con un solo vincitore;
- sequenza monotona e una transizione per comando;
- self-transition con incremento esattamente unitario;
- UPDATE e DELETE del ledger rifiutati;
- nessuna regressione sui test PostgreSQL, permessi v2, Control Plane e Runtime Reliability esistenti.

I test DB devono isolare i dati con rollback della transazione o con un database effimero dedicato. La suite Orchestrator parte soltanto se `RUN_DB_TESTS=1`, `AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1` e il nome del database o dello schema contiene `test`; i record del ledger sono immutabili e restano confinati lì. Non usare `deleteMany` sul ledger: i trigger append-only rifiutano UPDATE e DELETE per progettazione. Un eventuale `TRUNCATE` è ammesso soltanto nel database effimero di test, mai in staging o produzione.

## Definition of Done della PR 1

- [ ] ADR v1.0 -> v1.1 approvato e matrice 16/23 versionata.
- [ ] Migration Prisma esclusivamente additiva e verificata su PostgreSQL 16.
- [ ] Setting globale fail-closed e dati sintetici obbligatori.
- [ ] Motore puro con risultati `allowed`/`denied`, senza fallback permissivi.
- [ ] Tutte le 23 transizioni testate in positivo e negativo.
- [ ] Idempotenza, compare-and-swap, sequenza e ledger append-only testati sul database.
- [ ] Nessuna route pubblica, coda, worker o esecuzione agente introdotta.
- [ ] Provider esterni e dispatch disabilitati.
- [ ] Nessun percorso automatico di approvazione o rilascio.
- [ ] Documentazione di produzione e rollback verificata.

## Deploy manuale

La PR non autorizza alcun rilascio automatico. Dopo merge e approvazione esplicita della finestra production:

1. verificare che produzione sia stabile e creare un backup validato;
2. costruire l'immagine dal commit approvato;
3. avviare soltanto PostgreSQL se necessario;
4. eseguire `npm run prisma:migrate:deploy` con il comando Compose documentato;
5. distribuire manualmente l'applicazione;
6. verificare health check, login, permessi v2 e flussi CRM esistenti;
7. verificare in sola lettura il setting globale: dispatch `false`, dati sintetici `true`, provider `mock`;
8. confermare che non esistano worker Orchestrator e che i provider esterni siano ancora disabilitati.

La presenza delle nuove tabelle non avvia alcun workflow. Non inserire casi reali per collaudare la fondazione: i test production devono limitarsi a configurazione e non regressione.

## Rollback non distruttivo

In caso di regressione:

1. mantenere `dispatchEnabled=false`;
2. ripristinare l'immagine applicativa precedente;
3. riavviare lo stack senza rimuovere volumi;
4. verificare health, login e flussi CRM principali;
5. lasciare intatte le nuove tabelle e il ledger per preservare audit e compatibilità con la migration applicata.

Non usare `docker compose down -v`, `prisma migrate reset`, `DROP TABLE`, `TRUNCATE` o downgrade improvvisati. Un rollback dati è un'operazione distinta, ammessa solo con procedura provata in staging e backup validato. Poiché la migration è additiva e la versione precedente non usa le nuove tabelle, il rollback ordinario è applicativo, non distruttivo sul database.

## Passi successivi, fuori perimetro

1. outbox e coda persistente con deduplica dei job;
2. worker separato, retry controllati, lease, fencing, dead-letter ed escalation;
3. vertical slice Audit AI Bancabilità con provider mock fino a `HUMAN_APPROVAL`;
4. hardening produzione, osservabilità e runbook del worker.

Ogni passo richiede una PR distinta e una nuova approvazione.
