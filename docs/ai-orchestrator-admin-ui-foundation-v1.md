# AI Orchestrator Admin UI Foundation v1

## Stato e perimetro

Questa guida definisce il contratto della PR80. La documentazione descrive rollout e rollback, ma non costituisce da sola un'autorizzazione ad attivare l'AI Orchestrator.

PR80 aggiunge una superficie amministrativa privata sopra il ledger PR79 e il relativo hardening della motivazione. Il perimetro resta additivo, reversibile e fail-closed:

- pagina server-rendered `/settings/ai-orchestrator`;
- distinzione visibile fra configurazione `desired` e stato `effective`;
- consultazione di 1 policy globale e 35 scope canonici;
- tre azioni server controllate: policy globale, policy scope ed emergency stop;
- storico append-only con RBAC e paginazione keyset;
- vincolo PostgreSQL/TypeScript condiviso per minimizzare `reason`;
- indice additivo per il cursore audit.

PR80 non introduce o collega worker, loop runtime, scheduler, cron, timer, systemd, dispatch, handler, provider esterni, OpenAI, `fetch`, rete, dati CRM reali, `AiRun`, `AiOutput` o transizioni di workflow. Non modifica il reconciler AI esistente.

## Configurazione desiderata, non operativa

La pagina mostra in modo permanente il messaggio **“Configurazione desiderata, non operativa”**. Le revisioni registrate dalla UI appartengono al ledger desiderato PR79; non aggiornano direttamente `AiOrchestratorSetting`, `AiControlSetting` o `AiOrchestratorWorkerCapabilitySetting`.

L'effective della Foundation resta sempre non operativo:

- `operational=false`;
- `databaseEligible=false`;
- `workerEnabled=false`;
- `dispatchEnabled=false`;
- bypass dell'approvazione umana non consentito;
- activation epoch `FOUNDATION_LOCKED_V1`.

La pagina osserva, senza modificarli, gate ambiente e database, barriera fisica dispatch, provider, synthetic-only, provider esterni e numero di capability abilitate. Un gate osservato aperto non rende operativo il sistema e viene rappresentato come anomalia o ragione di blocco.

## Route e navigazione

La route privata è:

```text
/settings/ai-orchestrator
```

La voce **Orchestrator AI** appartiene alla sezione Admin / Sistema e richiede `ai.orchestrator.read`. Anche la route verifica lo stesso permesso lato server. L'assenza della voce di navigazione non sostituisce il controllo server-side.

La pagina è dinamica e server-rendered. Non effettua polling e non usa chiamate client a provider o API esterne.

## Contenuto della pagina

La vista comprende:

1. banner contrattuale non operativo;
2. stato effective e ragioni di blocco;
3. policy globale desiderata con versione e preview degli hash;
4. catalogo dei 35 scope non globali, raggruppati in provider, agenti, capability, job e workflow;
5. dettaglio dello scope selezionato;
6. moduli di modifica disponibili in base ai permessi;
7. emergency stop per le sessioni autorizzate;
8. storico append-only per le sessioni dotate di permesso audit.

La proiezione read non contiene motivazione completa, attore o dettagli dell'identità di comando. Questi campi sono proiettati esclusivamente nello storico protetto da `ai.orchestrator.audit`.

## RBAC

I permessi PR79 restano separati:

| Operazione | Permesso |
|---|---|
| Accesso pagina e navigazione | `ai.orchestrator.read` |
| Storico completo | `ai.orchestrator.audit` |
| Apertura dei moduli di configurazione | `ai.orchestrator.configure` |
| Variazioni espansive | `ai.orchestrator.enable` |
| Variazioni restrittive | `ai.orchestrator.disable` |
| Emergency stop e kill switch | `ai.orchestrator.kill` |
| Limiti | `ai.orchestrator.limits` |
| Retry | `ai.orchestrator.retry` |
| Policy agente | `ai.orchestrator.agents` |

La UI usa i permessi della sessione solo per costruire la vista. Il command service rilegge l'utente attivo, il ruolo e gli override nel database, ricostruisce la differenza di policy e decide i permessi effettivamente richiesti nella stessa operazione transazionale. Per `desiredMode` l'ordine di rischio è `STOPPED < PAUSED < DRAINING < READY`: ogni transizione verso destra richiede `ai.orchestrator.enable`, ogni transizione verso sinistra richiede `ai.orchestrator.disable`. La migration aggiorna atomicamente la funzione PostgreSQL che applica la stessa matrice nel trigger append-only. Nessun ruolo non-admin riceve nuovi permessi di default.

## Form e conferma forte

I form sono strict e rifiutano chiavi sconosciute o duplicate. Non accettano dal browser attore, ruolo, decisioni permesso, target definition hash, policy hash, activation epoch, policy version, provider, synthetic-only o un valore libero di dispatch.

Le modifiche globali e scope richiedono:

- UUIDv4 lowercase come request idempotente;
- versione e revision hash attesi;
- reason code appartenente al catalogo chiuso;
- motivazione minimizzata;
- checkbox esplicita;
- frase esatta `CONFERMO CONFIGURAZIONE DESIDERATA`.

L'emergency stop richiede la frase esatta `CONFERMO ARRESTO DI EMERGENZA`. Rimane CAS-less perché è un reducer monotono verso lo stato sicuro, ma non aggira sessione, permesso kill, idempotenza, motivazione o conferma.

Gli esiti vengono riflessi nell'URL soltanto mediante codici chiusi, per esempio `UPDATED`, `REPLAYED`, `CAS_MISMATCH`, `INVALID_INPUT` o `LEDGER_INTEGRITY_ERROR`. Il testo fornito dall'operatore e i dettagli tecnici dell'errore non vengono inseriti nell'URL.

## Reason Minimization Hardening

`AiOrchestratorAdminReasonSchema` è il contratto TypeScript canonico usato da command, request identity, revision identity e rilettura del ledger. Dopo la normalizzazione degli spazi esterni accetta da 10 a 500 code point Unicode e, contemporaneamente, non più di 500 unità UTF-16. Il secondo limite conserva la leggibilità del ledger con il codice PR79 durante un rollback. Lo schema respinge:

- caratteri di controllo C0, DEL e C1;
- URL `http://` e `https://`, senza distinzione fra maiuscole e minuscole;
- tag con forma `<...>`;
- qualsiasi `@`;
- termini delimitati `password`, `passwd`, `secret`, `token`, `prompt`, `authorization`, `cookie`;
- `api key`, `api_key`, `api-key` e `apikey`.

La migration `20260721190000_ai_orchestrator_admin_ui_foundation_v1` applica lo stesso limite di unità UTF-16 contando ogni code point supplementare due volte. Le espressioni regolari sensibili alle classi ASCII usano esplicitamente la collation `C`. Il preflight è count-only: una ragione incompatibile arresta atomicamente la migration prima di lasciare vincolo, indice o funzione parzialmente installati; il contenuto non viene stampato, sanificato o riscritto. La migration aggiunge e valida:

```text
AiOAdminPolicy_reason_minimized_v1_check
```

Il vincolo PR79 `AiOAdminPolicy_reason_check` resta presente. Non viene introdotta una funzione SQL sostituibile che possa reinterpretare retroattivamente il contratto v1.

Il filtro è una difesa di minimizzazione e non una garanzia assoluta di assenza di dati personali. Le motivazioni devono restare tecniche, sintetiche e prive di nomi, riferimenti cliente, credenziali, prompt o contenuti documentali.

## Storico cursor-based

Lo storico è disponibile solo con `ai.orchestrator.audit`. La UI offre tre viste esplicite: intero ledger, policy globale incluse le revisioni `EMERGENCY_STOP`, oppure scope non globale selezionato. Ogni vista usa:

- ordine stabile `createdAt DESC, id DESC`;
- cursore base64url opaco e versionato;
- binding del cursore ai filtri scope;
- filtri validati rispetto al catalogo canonico;
- massimo 50 revisioni restituite;
- lettura di una riga aggiuntiva per determinare `nextCursor`;
- nessun `OFFSET`.

L'indice additivo è:

```text
AiOAdminPolicy_audit_cursor_idx(createdAt, id)
```

Un cursore malformato, non canonico o associato a filtri diversi produce un errore controllato e non viene usato per costruire SQL libero.

## Comportamento fail-closed

Se la snapshot corrente non supera le verifiche di integrità:

- nessun modulo di modifica viene renderizzato;
- non viene eseguita una query di fallback semplificata;
- viene mostrato un errore tecnico minimizzato;
- lo stato effective resta non operativo.

Se l'errore d'integrità emerge durante la lettura dello storico, la pagina rimuove ugualmente i moduli di modifica. Errori di filtro o cursore non espongono righe e invitano a tornare alla prima pagina.

## Invarianti operative

Prima e dopo le verifiche PR80 devono restare invariati:

- `AiWorkflowInstance`, command e transition;
- job e outbox;
- runtime, attempt, receipt ed eventi runtime;
- result, artifact e source artifact;
- `AiRun` e `AiOutput`;
- `AiOrchestratorSetting` e `AiControlSetting`;
- le 13 capability worker, tutte disabilitate;
- la barriera fisica `AiOrchestratorSetting_dispatch_disabled_check`.

La crescita del ledger `AiOrchestratorAdminPolicyRevision` e dei relativi eventi `AuditLog` è invece l'effetto previsto di una modifica amministrativa autorizzata.

## Verifiche richieste prima del merge

```bash
npm ci
npm test
npm run prisma:generate
npx prisma validate
npx tsc --noEmit --incremental false
env -u DATABASE_URL npm run test:db
RUN_DB_TESTS=1 AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1 AI_ORCHESTRATOR_DB_TEST_SENTINEL=FAI_CRM_EPHEMERAL_TEST_ONLY_V1 npm run test:db
npm run build
git diff --check
bash -n scripts/smoke-docker-prod.sh
```

La suite distruttiva richiede un PostgreSQL 16 effimero con URL loopback,
database esatto `fai_crm_test`, schema `public` e commento DB-bound
`FAI_CRM_EPHEMERAL_TEST_ONLY_V1` impostato prima dei test. Ambiente production,
target remoti e sentinel presente soltanto nell'environment vengono rifiutati.

I test PostgreSQL devono coprire la catena completa di 29 migration, l'upgrade PR79→PR80, il preflight negativo su uno schema effimero, il nuovo vincolo validato, l'indice cursor, le 36 GENESIS invariate, parità TypeScript/SQL del corpus reason inclusi i limiti Unicode/UTF-16, matrice completa delle transizioni `desiredMode`, filtri audit globale/scope, paginazione senza duplicati o salti, RBAC audit e invarianza dei record operativi.

L'esecuzione dei test DB è ammessa soltanto su database o schema effimero dedicato con `test` nel nome e con conferma esplicita. Non usare staging o produzione come target della suite.

## Rollout autorizzato

Quando merge e finestra production sono esplicitamente autorizzati, la sequenza obbligatoria è:

1. verificare baseline e creare un backup validato;
2. confermare worker, state machine, dispatch e provider esterni disabilitati;
3. avviare il preflight count-only tramite la migration;
4. applicare `prisma migrate deploy`;
5. verificare vincolo reason validato, indice cursor, barriera dispatch e 36 target canonici;
6. distribuire la nuova immagine;
7. verificare health e login;
8. aprire `/settings/ai-orchestrator` in sola lettura;
9. confermare banner non operativo, gate chiusi, zero capability abilitate e assenza di errori d'integrità;
10. non inviare form e non creare revisioni di prova con dati di produzione.

Se il preflight rileva una ragione incompatibile, interrompere il rollout. La riga non deve essere modificata perché `reason` partecipa a request hash e revision hash. L'analisi e l'eventuale strategia di migrazione richiedono una decisione separata.

## Rollback

Il rollback ordinario dopo il deploy consiste nel ripristinare l'immagine PR79 mantenendo:

- il vincolo `AiOAdminPolicy_reason_minimized_v1_check`;
- l'indice `AiOAdminPolicy_audit_cursor_idx`;
- tutte le revisioni e gli audit append-only eventualmente creati;
- worker, state machine, dispatch e provider esterni disabilitati.

Il doppio limite Unicode/UTF-16 garantisce che PR79 possa rileggere tutte le ragioni accettate dopo la migration; PR79 ignora inoltre l'indice additivo. La funzione PostgreSQL dei permessi conserva invece la matrice RBAC più restrittiva di PR80: durante il rollback mantenere i gate chiusi e usare PR79 in lettura/health, senza proporre transizioni `PAUSED`/`DRAINING`. Non usare down migration, `DROP`, `TRUNCATE`, reset, `UPDATE` o `DELETE` del ledger. Un restore database è una procedura distinta e non costituisce il rollback ordinario della UI.

Decisione architetturale: [ADR-0007](adr/ADR-0007-ai-orchestrator-admin-ui-foundation-v1.md).
