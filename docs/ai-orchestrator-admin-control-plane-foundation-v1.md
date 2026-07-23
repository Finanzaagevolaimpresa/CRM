# AI Orchestrator Admin Control Plane Foundation v1

## Obiettivo e confine ledger-only

Questa fondazione introduce il contratto interno e append-only con cui una futura interfaccia amministrativa potrà proporre variazioni di policy dell'AI Orchestrator. La PR persiste esclusivamente revisioni `desired`, identità di comando e audit amministrativo; lo stato `effective` è soltanto derivato dal contratto fail-closed e non viene scritto nei setting runtime. Nessuna revisione è collegata alla state machine, alla coda, alla Worker Runtime Foundation o al Mock Handler Registry.

La revisione v1 è quindi **ledger-only**. Non aggiunge pagina, route, server action, API, processo worker, scheduler, cron, timer, unità systemd o dispatch. Non invoca handler, non applica transizioni, non crea `AiRun` o `AiOutput`, non usa rete, `fetch`, OpenAI o provider esterni e non legge dati CRM reali.

## Desired ed effective non coincidono

Ogni revisione conserva in modo esplicito lo stato `desired` richiesto dall'amministratore. Lo stato `effective` non è un secondo valore liberamente mutabile: viene derivato dalla activation epoch `FOUNDATION_LOCKED_V1` e resta sempre `STOPPED`/`OFF`/`KILLED`. Qualunque valore desiderato che amplierebbe l'operatività rimane quindi non effettivo. Un valore desiderato non è una capability, un permesso di dispatch o un'autorizzazione a eseguire lavoro.

Il dispatch costituisce un'eccezione ancora più restrittiva: in `FOUNDATION_LOCKED_V1` anche il suo valore `desired` canonico è letteralmente `false`. Non è consentito mettere in staging un desiderato `dispatch=true` sotto questa activation epoch.

Il lock v1 mantiene sempre:

- `stateMachineEnabled=false` come stato operativo richiesto per il deploy dormiente;
- `dispatchEnabled=false`, protetto anche dal vincolo fisico PostgreSQL già distribuito;
- `syntheticDataOnly=true` e `provider=mock`;
- `externalProvidersEnabled=false` e allowlist modelli vuota;
- `AI_ORCHESTRATOR_WORKER_ENABLED=0` o assente;
- tutte le capability e policy operative in stato `OFF`/`KILLED`.

Una revisione `desired` già memorizzata non potrà diventare effettiva per il solo aggiornamento futuro dell'applicazione. Qualunque futura attivazione richiederà una nuova activation epoch, una nuova revisione esplicita, una decisione/versione distinta del derivatore e una PR di attivazione separatamente autorizzata. `FOUNDATION_LOCKED_V1` non può essere reinterpretato retroattivamente.

## Bootstrap canonico

La migration materializza **36 revisioni genesis** del catalogo canonico: 1 globale, 1 provider `mock`, 7 agenti executor, 13 capability, 13 job e 1 workflow. Tutte sono fail-closed: nessuna è attiva e ogni superficie eseguibile ha un effective derivato `OFF` o `KILLED`. Il bootstrap non modifica i setting PR74, non abilita le tredici capability PR76, non crea job, outbox, runtime, attempt, result o artifact e non effettua backfill.

Il catalogo e le revisioni hanno identità versionate e hashate. Gli scope ammessi sono esclusivamente `GLOBAL`, `PROVIDER`, `AGENT`, `CAPABILITY`, `JOB` e `WORKFLOW`. L'identità di revisione lega scope e target, target definition hash, versione, policy hash, previous revision hash, request id/hash, operation code, permessi richiesti e decisioni, attore/ruolo, motivazione e conferma. Codice, scope, target, activation epoch, policy version e hash non possono essere mutati in place. Una nuova semantica richiede una nuova revisione append-only; non è ammesso aggiornare o cancellare lo storico.

## RBAC dedicato

Il Control Plane usa nove permessi dedicati, nel gruppo `AI Orchestrator`, e separati dai permessi generici `settings.manage`, `ai.run`, `ai.review`, `ai.approve` e `ai.external.run`:

- `ai.orchestrator.read`;
- `ai.orchestrator.configure`;
- `ai.orchestrator.enable`;
- `ai.orchestrator.disable`;
- `ai.orchestrator.kill`;
- `ai.orchestrator.retry`;
- `ai.orchestrator.audit`;
- `ai.orchestrator.limits`;
- `ai.orchestrator.agents`.

Solo il ruolo `admin` li riceve per default mediante il grant amministrativo globale; nessun ruolo non-admin ottiene un grant implicito. Il servizio rilegge utente attivo, ruolo e override dal database nella stessa operazione e non accetta dal chiamante un booleano `permissionGranted` o un ruolo auto-dichiarato.

L'esistenza di un permesso non apre alcun gate. Permessi, conferma, motivazione, CAS e policy valida sono condizioni congiunte; `FOUNDATION_LOCKED_V1` resta comunque prevalente. L'amministratore non può modificare hash canonici, aggirare la barriera `HUMAN_APPROVAL`, abilitare provider esterni o trasformare dati sintetici in dati CRM reali.

## Comandi, CAS e idempotenza

Ogni richiesta amministrativa usa un envelope strict con:

- idempotency key e request hash ricalcolato server-side;
- versione attesa della policy o del target;
- motivazione obbligatoria, normalizzata e limitata;
- conferma esplicita per le operazioni sensibili;
- attore risolto dal database;
- target appartenente al catalogo chiuso.

L'append è serializzato per scope con lock transazionale e compare-and-swap. Una versione stale non produce una scrittura parziale. `requestId` è univoco e il request hash viene ricalcolato server-side: nessun replay può creare una seconda revisione. Il command service interno risolve un replay identico rileggendo la revisione già persistita, rifiuta la stessa chiave associata a contenuto diverso e rifiuta come `NO_CHANGE` un nuovo comando che non produrrebbe alcuna revisione.

La testa corrente è derivata come revisione massima dello scope, non è una riga mutabile separata. Il valore precedente è identificato da `previousRevisionHash`; old/new, attore, richiesta, permessi, motivazione e conferma sono quindi ricostruibili dalla stessa catena append-only senza una tabella evento riscrivibile.

Lo storico amministrativo è minimizzato e append-only. Conserva identità tecnica, attore, motivo, conferma, vecchio e nuovo valore, versione, esito e catena hash; non conserva API key, prompt, lease token, payload di handler, documenti o dati cliente.

## Emergency stop

L'emergency stop è una riduzione del rischio globale. Produce una nuova revisione globale auditata che imposta `STOPPED`, state machine desiderata disabilitata ed entrambi i kill switch globali inseriti; l'effective derivato di tutti gli scope resta così `OFF`/`KILLED`. Non cancella job, outbox, runtime, attempt, result, artifact o ledger precedenti, non tenta di revocare retroattivamente un effetto esterno già avvenuto e non riscrive lease o fencing token.

Il comando resta soggetto a permesso dedicato, conferma e motivazione, ma non richiede che i gate positivi siano aperti. Una race fra una proposta espansiva e l'emergency stop deve risolversi tramite lock/CAS senza lost update e con stato finale fail-closed.

## Limiti hard

I limiti v1 sono vincoli superiori, non suggerimenti modificabili liberamente. Valori negativi, fuori range, non interi o superiori ai limiti canonici vengono rifiutati sia dal contratto applicativo sia dai vincoli PostgreSQL. La fondazione non aumenta i limiti conservativi della Worker Runtime Foundation e non permette di mutarne hash o versione.

Poiché nessun worker consuma le revisioni PR79, i limiti desiderati restano dichiarativi. Non devono essere descritti come concorrenza, retry, lease o throughput realmente applicati finché una futura activation epoch non li collegherà esplicitamente a un processo isolato e revisionato.

## Verifiche richieste

```bash
npm test
npx tsc --noEmit --incremental false
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/fai_crm_test?schema=public" npx prisma validate
npm run prisma:generate
env -u DATABASE_URL npm run test:db
RUN_DB_TESTS=1 AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1 AI_ORCHESTRATOR_DB_TEST_SENTINEL=FAI_CRM_EPHEMERAL_TEST_ONLY_V1 npm run test:db
npm run build
git diff --check
```

La suite distruttiva richiede inoltre un PostgreSQL 16 effimero con URL
loopback, database esatto `fai_crm_test`, schema `public` e commento DB-bound
`FAI_CRM_EPHEMERAL_TEST_ONLY_V1` impostato prima dell'avvio. Il guard nega
ambienti production e non accetta la sola variabile environment come prova.

I test PostgreSQL 16 devono verificare migration chain completa, 36 revisioni bootstrap tutte off/killed, vincolo dispatch fisico invariato, CAS e replay idempotente, append-only/hash chain, concorrenza ed emergency stop. Prima e dopo le fixture devono risultare invariati i conteggi di job, outbox, runtime, attempt, result, artifact, `AiRun` e `AiOutput` non appartenenti al test.

## Stato operativo e rollback

La PR #79 è stata unita e distribuita in modalità dormiente il 21 luglio 2026; il collaudo production si è concluso con `PR79_SMOKE_OK`. La distribuzione non ha autorizzato l'attivazione di worker, state machine, dispatch o provider esterni. I gate devono restare verificati in sola lettura e non devono essere usati dati CRM reali per collaudare l'Orchestrator.

Il rollback ordinario è applicativo: mantenere worker e provider esterni disabilitati, ripristinare l'immagine precedente e lasciare intatti catalogo, revisioni e audit append-only. Non usare `DROP`, `TRUNCATE`, migration reset, down migration o cancellazione dello storico.
