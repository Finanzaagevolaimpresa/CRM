# AI Orchestrator Mock Execution & Result Wiring Foundation v1

## Stato

`FAI-AI-ORCHESTRATOR-MOCK-EXECUTION-RESULT-WIRING@1.0` collega, soltanto nei test sintetici autorizzati, una lease opaca PR82 al registry mock PR78 e alla completion atomica PR77.

La composizione production resta non operativa: `FOUNDATION_LOCKED_V1`, `operational=false`, `canAcceptLease=false`, `consumer=NONE`, capability disabilitate, dispatch fisicamente chiuso e gate worker `0`. Il gate worker `1` non abilita il consumer.

## Boundary

La factory di test produce due superfici separate che condividono una `WeakMap`: la superficie runtime PR82 invariata e una superficie execution che accetta esclusivamente l'handle. Il processo production importa soltanto la prima.

Il preflight read-only usa tempo PostgreSQL e verifica due volte runtime, job, attempt, worker, lease, fencing, executor/config e cataloghi. Il payload e la dedupe key vengono letti dal job persistito e rivalidati dal costruttore canonico dell'invocazione. Nessuna transazione resta aperta durante l'handler.

Result, artifact e source lineage sono scritti esclusivamente da `completeAiWorkflowJob`. Le failure deterministiche usano `POLICY_HASH_MISMATCH`; soltanto una classificazione transient esplicita di test può usare `MOCK_HANDLER_TRANSIENT`. Authority/capability negate e drain richiedono surrender senza consumare retry; una lease stale resta affidata alla recovery PR76.

## Limite authority

`adminAuthorityAtomicWithCompletion=false`. I recheck prima e dopo l'handler riducono la finestra di race ma non sono una garanzia sufficiente per un'attivazione reale. Una futura activation PR deve rendere atomico il confine dell'authority amministrativa con la completion prima di collegare il consumer in production.

## Dati e side effect

Sono ammessi esclusivamente provider `mock`, dati sintetici, registry statico 13/13 e output conformi al catalogo PR77. Sono vietati dati CRM, rete, filesystem, subprocess, worker thread, handler dinamici, workflow transition, `AiRun`, `AiOutput`, payload o draft forniti dal chiamante.

Non sono introdotti schema, migration, seed, backfill, dipendenze, route, UI, servizi Compose, unità systemd, cron, timer o deploy.
