# AI Orchestrator: State Machine Foundation v1.1

Questa guida descrive la fondazione proposta dalla prima PR dell'AI Orchestrator MVP. Il suo perimetro è deliberatamente strutturale: definizione versionata della macchina, persistenza additiva, idempotenza, concorrenza, audit e test. La porta applicativa termina obbligatoriamente a `HUMAN_APPROVAL`. Non introduce coda, worker, esecuzione agente, nuova route pubblica, approvazione, rilascio o deploy automatico.

La correzione semantica del workflow è motivata nell'[ADR-0001](adr/0001-ai-audit-workflow-v1-1.md).

## Contratto della fondazione

Il workflow canonico è identificato dalla coppia:

```text
workflowCode    = FAI-AUDIT-WORKFLOW
workflowVersion = 1.1
workflowKey     = FAI-AUDIT-WORKFLOW@1.1
```

La definizione canonica espone 16 stati e 23 transizioni per descrivere l'intero ciclo di vita. La porta applicativa della State Machine Foundation consente esclusivamente WF-001..WF-017. Qualunque richiesta WF-018..WF-023 viene negata con `FOUNDATION_SCOPE_LIMIT`, indipendentemente dall'attore, e non può mutare stato, versione, ciclo di correzione o ledger. All'avvio dei test vengono verificate unicità dei codici, validità degli endpoint, raggiungibilità, conteggi e barriera applicativa a `HUMAN_APPROVAL`.

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
| `AiOrchestratorSetting` | Singleton globale: state machine e dispatch distinti e disabilitati, soli dati sintetici e provider mock come default sicuri. |
| `AiWorkflowInstance` | Istanza idempotente del caso con contratto versionato, campi contesto riservati, stato corrente, `stateVersion` e ciclo di correzione. |
| `AiWorkflowCommand` | Intento idempotente, actor kind, stato/versione attesi, hash richiesta, correlazione ed esito o diniego. |
| `AiWorkflowTransition` | Ledger append-only della transizione accettata, con sequenza, versioni, snapshot strutturato dei guard, relativo hash e correlazione. |

I campi di contesto a cliente, azienda, progetto e servizio sono riservati all'evoluzione futura ma un `CHECK` li obbliga tutti a `NULL` nella PR 1: non esiste ancora un modo verificabile per distinguere un record CRM reale da uno sintetico. L'utente che crea l'istanza resta obbligatorio. La migration non collega né modifica record CRM esistenti e non esegue backfill. Le foreign key sono già predisposte con comportamento restrittivo; identità di istanza e comando, stato, esiti e catena del ledger sono inoltre protetti da vincoli e trigger PostgreSQL.

La coda persistente (`outbox`, job e attempt), le escalation e gli artefatti/review versionati non fanno parte di questa migration: saranno additive nelle PR successive.

## Feature flag e provider

Il setting iniziale deve essere:

| Campo | Valore sicuro |
|---|---|
| `stateMachineEnabled` | `false` |
| `dispatchEnabled` | `false` |
| `syntheticDataOnly` | `true` |
| `provider` | `mock` |

I due flag non sono intercambiabili. Creazione e applicazione delle transizioni WF-001..WF-017 richiedono `stateMachineEnabled=true`, ma non richiedono `dispatchEnabled=true`: la foundation viene collaudata esclusivamente con state machine abilitata e dispatch disabilitato. `dispatchEnabled` non autorizza da solo alcun lavoro e `automaticDispatchAllowed` resta sempre `false`.

La riga assente, duplicata, illeggibile o con valore non ammesso non abilita nulla. La PR 1 non ha un worker e non offre un comando di dispatch. In produzione entrambi i flag restano `false`; una loro eventuale modifica futura richiede una decisione operativa separata e non è autorizzata da questa PR.

`AI_ORCHESTRATOR_WORKER_ENABLED` è un controllo infrastrutturale previsto per la futura PR del worker; non è una variabile riconosciuta dalla State Machine Foundation. I controlli `AI_EXTERNAL_PROVIDERS_ENABLED`, `AI_ALLOWED_MODELS` e lo switch database dell'[AI Control Plane](ai-control-plane.md) restano invariati e disabilitati.

## Atomicità di un comando

La porta applicativa interna della PR 1 tratta un comando nella seguente transazione PostgreSQL:

1. caricare e validare il setting, richiedendo state machine abilitata, dati sintetici, provider mock e provider esterni disabilitati;
2. caricare istanza e definizione esatta e applicare la barriera WF-001..WF-017;
3. rileggere identità, ruolo, override e permesso effettivo dell'attore;
4. riservare o rileggere `AiWorkflowCommand` usando l'idempotency key;
5. verificare sul ledger sequenza, fase corrente, milestone richieste e divieto di duplicazione;
6. valutare gate e precondizioni dichiarate senza usarle come sostituto dei fatti persistiti;
7. costruire un unico `guardSnapshot` minimizzato e calcolarne l'hash canonico;
8. applicare compare-and-swap sull'istanza;
9. inserire una sola riga `AiWorkflowTransition` con sequenza monotona, snapshot e hash esatto;
10. registrare l'evento `AuditLog` minimizzato;
11. chiudere il comando con risultato e nuova versione ed eseguire il commit.

Se un passaggio fallisce, stato, transizione e audit di successo non devono essere parzialmente visibili. Dopo la reservation, un diniego viene chiuso come esito `REJECTED` del comando, senza mutare l'istanza e senza creare una transizione fittizia. Richieste malformate, actor inesistenti, actor kind errati e mismatch che non possono soddisfare i `CHECK` del command vengono negati prima della reservation e registrati soltanto in `AuditLog`.

La PR 1 non espone questa porta tramite UI o API production. Gli entrypoint interni accettano un'identità già scelta dal chiamante e non sono quindi un confine di autenticazione: non devono essere collegati direttamente a payload HTTP. La futura porta umana dovrà derivare l'utente dalla sessione; worker e agenti dovranno presentare job, lease e capability verificabili.

Il motore non presume permessi impliciti: il servizio rilegge dal database utente attivo, ruolo e override e usa una sola decisione effettiva sia per autorizzare sia per compilare lo snapshot. WF-001..004, WF-009 e WF-010 richiedono `ai.run`; WF-017 richiede `ai.review`. Nel contratto canonico WF-018..023 richiederebbero `ai.approve`, ma la Foundation le nega prima che quel permesso possa autorizzarle. Le transizioni `AGENT` e `SYSTEM` non ricevono permessi umani impliciti. L'ABAC sui record cliente non è applicabile in PR 1 perché i link CRM sono obbligatoriamente null; verrà aggiunto e testato prima di allentare il vincolo synthetic-only.

`workerDirective` descrive soltanto la semantica del passo successivo. Non è una capability e non autorizza un job: `automaticDispatchAllowed` è sempre `false` nella foundation e il ledger persiste esplicitamente questo valore. Agent code/capability, outbox, lease e policy di dispatch appartengono alle PR successive.

## Idempotenza e anti-duplicazione

Anche la creazione dell'istanza è idempotente: una `creationKey` UUID v4 globalmente univoca è legata al payload canonico dal `creationRequestHash` SHA-256. Il replay coerente riusa la stessa istanza; il riuso della chiave con hash diverso è un conflitto.

Per le transizioni, l'idempotency key è una UUID v4 generata per il comando e ha ambito nell'istanza di workflow. Il `requestHash` SHA-256 lega la chiave ai dati canonici che influenzano la decisione.

- Stessa chiave e stesso hash: soltanto dopo aver rivalidato setting fail-closed, provider esterni, attore attivo e permessi effettivi correnti, restituire l'esito già persistito senza nuova transizione o nuovo audit di successo.
- Stessa chiave e hash diverso: diniego per conflitto; nessuna mutazione dello stato o del ledger di successo. Il diniego resta registrabile in `AuditLog`.
- Nuova chiave con stato o versione attesi obsoleti: diniego per concorrenza; nessuna mutazione dello stato o nuova transizione. Il comando riservato viene chiuso `REJECTED` e il diniego viene auditato.
- Due comandi concorrenti validi sulla stessa `stateVersion`: il compare-and-swap consente un solo vincitore.
- Ogni comando accettato può produrre al massimo una transizione.
- La coppia istanza/sequenza è univoca e crescente.

Una self-transition valida è un nuovo evento di dominio: incrementa `stateVersion` e sequenza. Il replay dello stesso comando non è una self-transition e non incrementa nulla. Una nuova idempotency key non trasforma una milestone già completata nella medesima fase o ciclo in un nuovo evento valido: viene negata come duplicato.

Queste garanzie riguardano la state machine. La deduplica dei job e il fencing delle lease saranno aggiunti con la coda e il worker, riutilizzando i principi già presenti in AI Runtime Reliability v1.

## Milestone persistite e confini di fase

Gate e precondizioni provenienti dal chiamante restano necessari, ma non sono una prova sufficiente. Per le transizioni che dipendono dal completamento di passi precedenti, il servizio consulta il ledger append-only e usa `sequence` come ordine autorevole.

| Fase corrente | Transizione richiesta | Evidenza ledger obbligatoria nello stesso confine |
|---|---|---|
| `DATA_VALIDATION` | WF-006 | WF-005 |
| `DATA_VALIDATION` | WF-007 | WF-005, poi WF-006 |
| `DATA_VALIDATION` | WF-010 | WF-005, WF-006 e WF-007 nell'ordine dichiarato |
| `AI_DRAFT` | WF-013 | WF-012 |
| `INDEPENDENT_REVIEW` | WF-015 o WF-017 | WF-014 |

Il confine di `DATA_VALIDATION` è aperto dall'ultima WF-004 o WF-009; quello di `AI_DRAFT` dall'ultima WF-011; ogni ciclo di `INDEPENDENT_REVIEW` dall'ultima WF-013 o WF-016. Le evidenze antecedenti al confine corrente non sono riutilizzabili. WF-005, WF-006, WF-007, WF-012 e WF-014 non possono essere ripetute con una nuova idempotency key entro lo stesso confine. Il replay esatto del comando originale rimane invece idempotente.

Un tentativo con milestone mancante, fuori ordine o duplicata non cambia istanza e non crea una transizione. I codici stabili della porta applicativa sono rispettivamente `MILESTONE_NOT_COMPLETED`, `MILESTONE_OUT_OF_ORDER` e `MILESTONE_DUPLICATE`.

## Audit

`AiWorkflowTransition` è il ledger di dominio autorevole. `AuditLog` rende l'evento consultabile con il modello di audit comune al CRM. Per ogni transizione accettata devono essere ricostruibili almeno:

- workflow, versione e hash di definizione;
- comando, idempotency key e correlation id;
- `actorKind` `HUMAN`, `AGENT` o `SYSTEM` e la relativa identità esclusiva; per `AGENT` anche la versione immutabile della configurazione;
- transition code, stato/versione prima e dopo;
- snapshot strutturato dei guard, relativo hash canonico e reason code;
- hash della transizione e hash della precedente per verificare la catena append-only;
- timestamp PostgreSQL.

Il `guardSnapshot` persistito è un JSON minimizzato e versionato che contiene almeno:

- tipo di attore e, per l'attore umano, ruolo effettivo;
- permesso richiesto, risultato effettivo e fonte `ADMIN`, `ROLE`, `OVERRIDE` o `NOT_REQUIRED`;
- identificativo logico, versione e timestamp di aggiornamento del setting Orchestrator;
- `stateMachineEnabled`, `dispatchEnabled`, modalità sintetica e provider mock osservati;
- gate e precondizioni effettivamente valutati, con esito normalizzato;
- milestone richieste e osservate nel confine di fase o ciclo corrente;
- ciclo di correzione e verifiche di separazione applicate o non applicabili nel perimetro Foundation;
- provider esterni disabilitati e `automaticDispatchAllowed=false`.

Il servizio costruisce un solo oggetto snapshot, calcola `guardSnapshotHash = SHA-256(canonicalJson(guardSnapshot))` e persiste esattamente lo stesso oggetto. Il database valida lo schema minimizzato, lega attore, permesso, gate, precondizioni, milestone e separazioni alla transizione, canonicalizza il JSON persistito e ricalcola lo SHA-256 nel `CHECK`: snapshot incompleti, campi inattesi e hash arbitrari sono rifiutati anche in caso di scrittura SQL diretta. Il test DB rilegge inoltre lo snapshot e ricalcola l'hash lato applicativo. Ledger e snapshot sono append-only e non modificabili.

Non vanno copiati nello snapshot o nel ledger documenti, prompt, output completi, dati cliente, cookie, password, token, credenziali, chiavi API, segreti o payload sensibili. Identità e correlazioni già presenti nelle colonne relazionali non vengono duplicate nello snapshot. Gli hash dimostrano coerenza senza trasformare l'audit in un secondo archivio dati.

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

La porta applicativa aggiunge almeno i codici stabili `FOUNDATION_SCOPE_LIMIT`, `MILESTONE_NOT_COMPLETED`, `MILESTONE_OUT_OF_ORDER` e `MILESTONE_DUPLICATE`.

Un diniego non crea una riga `AiWorkflowTransition`.

## Revisione umana e barriera di rilascio

La prima vertical slice termina a `HUMAN_APPROVAL`. Il contratto richiede fan-in delle review indipendenti, WF-014 persistita nel ciclo corrente, gate in PASS e zero finding Critical/Major aperti. La PR 1 conserva nel ledger la milestone e nello snapshot la decisione minimizzata; non persiste ancora gli artefatti completi dei futuri job.

Il contratto include WF-018..WF-023 per completezza del ciclo di vita, ma la porta applicativa della Foundation:

- le nega sempre con `FOUNDATION_SCOPE_LIMIT`, anche se l'attore è umano e possiede `ai.approve`;
- non consente di raggiungere `APPROVED`, `RELEASED`, `SUPERSEDED`, `CLOSED` o `DELETION_PENDING`;
- non espone approvazione, richiesta modifiche post-approval, rilascio, sostituzione, chiusura o cancellazione;
- richiederà una successiva decisione architetturale e di governance prima di poter ampliare l'allowlist.

## Strategia di test

### Test unitari della definizione

- conteggio esatto di 16 stati e 23 transizioni;
- codici univoci; le coppie `from`/`to` ripetute sono soltanto quelle espressamente previste per milestone diverse;
- stato iniziale valido e tutti gli endpoint dichiarati;
- raggiungibilità dei 16 stati;
- verifica positiva di ciascuna delle 23 transizioni nella definizione canonica pura;
- verifica negativa di ciascuna transizione con stato iniziale errato;
- diniego fail-closed per codice, stato, actor, gate o versione sconosciuti;
- limite di due cicli di correzione;
- reason code obbligatorio per correzione, modifiche richieste, supersede e cancellazione;
- divieto per worker/agent sulle transizioni umane;
- assenza di un cammino automatico fino a `RELEASED`;
- allowlist della porta Foundation esattamente WF-001..WF-017 e dispatch mai autorizzato.

### Test PostgreSQL

- migration applicabile su database aggiornato e su database vuoto tramite l'intera catena Prisma;
- default globale `stateMachineEnabled=false`, `dispatchEnabled=false`, `syntheticDataOnly=true`, provider `mock`;
- state machine disabilitata: creazione e transizioni negate;
- state machine abilitata con dispatch disabilitato: operazioni WF-001..WF-017 consentite, senza autorizzare dispatch;
- WF-018..WF-023 tutte negate con `FOUNDATION_SCOPE_LIMIT` e istanza ferma a `HUMAN_APPROVAL`;
- vincoli su stato, versione, provider, idempotency key e request hash;
- replay idempotente senza duplicare transizione o audit di successo;
- milestone mancanti, fuori ordine e duplicate negate sulla base del ledger;
- reset logico delle milestone dopo WF-009 e WF-016;
- `guardSnapshotHash` ricalcolato sullo snapshot persistito e snapshot privo di dati sensibili;
- fonti di permesso `ADMIN`, `ROLE` e `OVERRIDE` verificabili nello snapshot;
- conflitto stessa chiave/hash diverso;
- concorrenza su `stateVersion` con un solo vincitore;
- sequenza monotona e una transizione per comando;
- self-transition con incremento esattamente unitario;
- UPDATE e DELETE del ledger rifiutati;
- nessuna regressione sui test PostgreSQL, permessi v2, Control Plane e Runtime Reliability esistenti.

I test DB devono isolare i dati con rollback della transazione o con un database effimero dedicato. La suite Orchestrator distruttiva parte soltanto con doppio opt-in, ambiente non-production, URL PostgreSQL loopback verso il database esatto `fai_crm_test`, schema `public` e commento DB-bound `FAI_CRM_EPHEMERAL_TEST_ONLY_V1`; i record del ledger sono immutabili e restano confinati lì. Il commento va applicato esplicitamente al database effimero prima della suite. Non usare `deleteMany` sul ledger: i trigger append-only rifiutano UPDATE e DELETE per progettazione. Un eventuale `TRUNCATE` è ammesso soltanto nel database effimero confermato, mai in staging o produzione.

Prima di aggiornare la Draft PR devono risultare completate, senza saltare passaggi, le verifiche seguenti:

```bash
npm test
npx tsc --noEmit
npx prisma validate
npm run prisma:generate
RUN_DB_TESTS=1 AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1 AI_ORCHESTRATOR_DB_TEST_SENTINEL=FAI_CRM_EPHEMERAL_TEST_ONLY_V1 npm run test:db
npm run build
git diff --check
```

L'intera catena delle migration deve inoltre essere applicata da zero su un PostgreSQL 16 dedicato. Il risultato dei comandi, il commit esaminato e gli eventuali blocker residui devono essere riportati nella Draft PR. Un riesame indipendente del diff aggiornato è obbligatorio prima di fermare il lavoro; non equivale a marcare la PR Ready for review.

## Definition of Done della PR 1

- [ ] ADR v1.0 -> v1.1 in stato proposto/in revisione e matrice canonica 16/23 versionata.
- [ ] Migration Prisma esclusivamente additiva e verificata su PostgreSQL 16.
- [ ] `stateMachineEnabled=false` e `dispatchEnabled=false` distinti come default database; dati sintetici e provider mock obbligatori.
- [ ] Motore puro con risultati `allowed`/`denied`, senza fallback permissivi.
- [ ] Tutte le 23 transizioni canoniche testate; porta applicativa limitata e testata su WF-001..WF-017.
- [ ] WF-018..WF-023 negate con `FOUNDATION_SCOPE_LIMIT`; nessun servizio porta un'istanza oltre `HUMAN_APPROVAL`.
- [ ] Milestone della fase/ciclo corrente verificate dal ledger per ordine, presenza e unicità.
- [ ] Snapshot dei guard strutturato, minimizzato, append-only e verificato tramite ricalcolo dell'hash esatto.
- [ ] Idempotenza, compare-and-swap, sequenza e ledger append-only testati sul database.
- [ ] Nessuna route pubblica, coda, worker o esecuzione agente introdotta.
- [ ] OpenAI e tutti i provider esterni disabilitati; dispatch non abilitato da codice o test.
- [ ] Nessuna approvazione, rilascio, chiusura, cancellazione o deploy introdotti.
- [ ] Documentazione di produzione e rollback verificata.
- [ ] Intera suite richiesta eseguita su PostgreSQL 16 dedicato e riesame indipendente del diff completato.
- [ ] PR mantenuta Draft; nessun merge, Ready for review o deploy eseguito.

## Runbook per un eventuale rilascio manuale futuro

Questa PR Draft non autorizza merge o deploy, automatico o manuale. Le istruzioni seguenti descrivono soltanto un eventuale rilascio futuro, subordinato a merge e approvazione esplicita di una distinta finestra production:

1. verificare che produzione sia stabile e creare un backup validato;
2. costruire l'immagine dal commit approvato;
3. avviare soltanto PostgreSQL se necessario;
4. eseguire `npm run prisma:migrate:deploy` con il comando Compose documentato;
5. distribuire manualmente l'applicazione;
6. verificare health check, login, permessi v2 e flussi CRM esistenti;
7. verificare in sola lettura il setting globale: state machine `false`, dispatch `false`, dati sintetici `true`, provider `mock`;
8. confermare che non esistano worker Orchestrator e che i provider esterni siano ancora disabilitati.

La presenza delle nuove tabelle non avvia alcun workflow. La release della Foundation non autorizza l'attivazione di `stateMachineEnabled` in produzione; tale attivazione richiederebbe una decisione operativa separata. `dispatchEnabled` deve restare `false` in ogni caso. Non inserire casi reali per collaudare la fondazione: i test production devono limitarsi a configurazione e non regressione.

## Rollback non distruttivo

In caso di regressione:

1. mantenere o riportare `stateMachineEnabled=false` tramite una procedura amministrativa autorizzata e auditabile;
2. mantenere `dispatchEnabled=false` e tutti i provider esterni disabilitati;
3. ripristinare l'immagine applicativa precedente;
4. riavviare lo stack senza rimuovere volumi;
5. verificare health, login, permessi v2 e flussi CRM principali;
6. lasciare intatte le nuove tabelle, gli snapshot e il ledger per preservare audit e compatibilità con la migration applicata.

Finché la Draft PR non è unita né distribuita, il rollback consiste nel non effettuare il merge o nel ritirare la branch: nessuna operazione sul database è necessaria. Dopo un eventuale rilascio futuro, non usare `docker compose down -v`, `prisma migrate reset`, `DROP TABLE`, `TRUNCATE` o downgrade improvvisati. Un rollback dati è un'operazione distinta, ammessa solo con procedura provata in staging e backup validato. Poiché la migration è additiva e la versione precedente non usa le nuove tabelle, il rollback ordinario è applicativo, non distruttivo sul database.

## Passi successivi, fuori perimetro

1. outbox e coda persistente con deduplica dei job;
2. worker separato, retry controllati, lease, fencing, dead-letter ed escalation;
3. artefatti e review versionati per la vertical slice Audit AI Bancabilità, senza ampliare implicitamente la barriera `HUMAN_APPROVAL`;
4. hardening produzione, osservabilità e runbook del worker.

Ogni passo richiede una PR distinta e una nuova approvazione.
