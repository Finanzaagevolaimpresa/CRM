# ADR-0006 — AI Orchestrator Admin Control Plane Foundation v1

## Stato

Proposto nella Draft PR #79. Nessuna autorizzazione di merge, deploy o attivazione.

## Contesto

Le fondazioni PR74–PR78 definiscono state machine, coda persistente, primitive runtime dormienti, result/artifact e handler mock deterministici. I setting globali e i tredici kill switch esistono, ma non esiste ancora un contratto amministrativo versionato per descrivere chi ha richiesto una variazione, con quale motivazione, contro quale versione e con quale esito fail-closed.

Collegare subito un pannello ai setting runtime produrrebbe una falsa equivalenza fra intenzione amministrativa ed effetto operativo. Inoltre rendere una revisione desiderata implicitamente efficace dopo un futuro aggiornamento consentirebbe un'attivazione differita non nuovamente autorizzata.

## Decisione

Adottiamo una fondazione **ledger-only**. Il Control Plane definisce un catalogo chiuso e registra revisioni append-only, identità di comando idempotenti e audit hash-chained. La testa corrente è la revisione massima dello scope, non una riga mutabile separata. Lo stato desiderato viene persistito; quello effettivo è derivato dalla activation epoch immutabile `FOUNDATION_LOCKED_V1` e non viene propagato ai setting runtime.

La migration crea 36 policy bootstrap — 1 globale, 1 provider, 7 agenti, 13 capability, 13 job e 1 workflow — tutte `OFF`/`KILLED`. Nessuna revisione bootstrap o successiva di questa foundation può aprire dispatch, avviare worker, invocare handler o provider, applicare transizioni o usare dati reali. Il vincolo PostgreSQL `AiOrchestratorSetting_dispatch_disabled_check` resta presente, esatto e validato.

Una revisione desired espansiva può essere conservata per revisione futura, ma non è una capability. Non potrà diventare effettiva per un semplice cambio di codice: serve una nuova activation epoch e una nuova revisione esplicitamente autorizzata. La versione `FOUNDATION_LOCKED_V1` resta permanentemente fail-closed.

Per il dispatch, `FOUNDATION_LOCKED_V1` impone anche `desired=false`: questa epoch non accetta né conserva una richiesta staged di apertura del dispatch.

## Autorizzazione e consistenza

Nove permessi RBAC dedicati — `ai.orchestrator.read`, `ai.orchestrator.configure`, `ai.orchestrator.enable`, `ai.orchestrator.disable`, `ai.orchestrator.kill`, `ai.orchestrator.retry`, `ai.orchestrator.audit`, `ai.orchestrator.limits` e `ai.orchestrator.agents` — separano lettura e operazioni amministrative. Solo `admin` li riceve per default; nessun ruolo non-admin ha un grant implicito. Ogni comando rilegge l'attore attivo e i suoi override nel database, richiede una motivazione, usa conferma esplicita per operazioni sensibili e non si affida a ruolo o permesso forniti dal chiamante.

Le revisioni appartengono soltanto agli scope chiusi `GLOBAL`, `PROVIDER`, `AGENT`, `CAPABILITY`, `JOB` e `WORKFLOW`. La loro identità include target definition hash/versione, policy hash, previous revision hash, request id/hash, operation code, permessi/decisioni, attore, motivo e conferma.

Le scritture sono serializzate per scope con lock transazionale, CAS sulla versione attesa e idempotency key con request hash server-side. Il command service interno rilegge la revisione già persistita per i replay identici, mentre collisioni semantiche e versioni stale falliscono chiuse. La catena lega atomicamente revisione nuova e precedente e rende ricostruibile l'audit old/new. Identità canoniche, hash, activation epoch e righe storiche non sono aggiornabili o cancellabili.

## Emergency stop e limiti

L'emergency stop è monotono verso la sicurezza: appende una revisione che forza le policy governate a `OFF`/`KILLED`. Non elimina né modifica record operativi già persistiti e non può essere usato per riscrivere lease, fencing, result o ledger.

I limiti amministrativi sono hard upper bound validati in TypeScript e PostgreSQL. In PR79 restano dichiarativi perché nessun worker importa o consuma il Control Plane. I limiti canonici della Worker Runtime Foundation non vengono modificati.

## Alternative escluse

- aggiornamento diretto dei setting da UI o route;
- interpretazione di `desired=true` come autorizzazione effettiva;
- riuso del solo `AuditLog` generico come ledger strutturale;
- permesso generico `settings.manage` come unica barriera;
- mutazione in place dello storico o dei digest canonici;
- rimozione del vincolo fisico dispatch;
- introduzione contestuale di worker, scheduler o provider.

## Conseguenze

Una futura UI potrà costruire su un contratto auditabile senza decidere autonomamente gli effetti runtime. Il costo è che anche una richiesta amministrativa valida non attiva alcun lavoro in v1. Questa è una proprietà di sicurezza, non una funzionalità incompleta da aggirare.

La futura attivazione richiederà una ADR, una PR e una activation epoch nuove, collaudo PostgreSQL e processo isolato, oltre all'autorizzazione operativa. Non sarà consentito reinterpretare revisioni staged create sotto `FOUNDATION_LOCKED_V1`.

## Confini

Questa decisione non introduce UI, route, server action, API pubblica, worker, worker thread, child process, scheduler, cron, timer, systemd, dispatch, provider esterni, rete, `fetch`, OpenAI, dati CRM reali, `AiRun`, `AiOutput` o transizioni di workflow. Non modifica il reconciler AI esistente e non collega il Mock Handler Registry alla Worker Runtime Foundation.

## Rollback

Prima di merge/deploy è sufficiente ritirare la Draft PR. Dopo un eventuale deploy separatamente autorizzato, il rollback è applicativo e mantiene tutti i gate chiusi; catalogo, revisioni e audit restano intatti. Non sono ammessi reset, down migration, `DROP`, `TRUNCATE` o cancellazioni dello storico.
