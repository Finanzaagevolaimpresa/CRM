# ADR-0010 — AI Orchestrator Mock Execution & Result Wiring Foundation v1

## Decisione

Definiamo `FAI-AI-ORCHESTRATOR-MOCK-EXECUTION-RESULT-WIRING@1.0`: una composizione factory-scoped, usabile soltanto nei test sintetici autorizzati, che collega una lease opaca PR82 al registry statico PR78 e alla completion atomica PR77.

La superficie runtime PR82 resta invariata. Una superficie execution separata condivide privatamente la stessa `WeakMap`, accetta soltanto l'handle e non è istanziata dalla composizione production.

## Confini

Il preflight è read-only, fenced e ripetuto prima dell'handler e immediatamente prima della completion. Nessuna transazione resta aperta durante l'handler. Il draft viene persistito esclusivamente da `completeAiWorkflowJob`; failure deterministiche ammesse passano esclusivamente da `failAiWorkflowJob`.

`adminAuthorityAtomicWithCompletion=false`: il doppio recheck dell'authority amministrativa non è atomico con la completion e **non è sufficiente per l'attivazione production**. Una futura activation PR dovrà risolvere questo confine prima di collegare il consumer a un processo operativo.

Production conserva `FOUNDATION_LOCKED_V1`, `operational=false`, `canAcceptLease=false` e `consumer=NONE`. Nessuna modifica semantica è ammessa senza nuova versione e nuovo hash.
