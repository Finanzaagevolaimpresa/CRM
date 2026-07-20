# AI Orchestrator Result & Artifact Contract Foundation v1

## Obiettivo e confini

Questa fondazione definisce il contratto canonico result/artifact v1 e la persistenza append-only necessaria a completare un job AI Orchestrator in modo atomico, fenced e idempotente. Il perimetro resta esclusivamente `mock` e `synthetic`: sono esclusi worker, handler eseguibili, route API, UI, dispatch, provider esterni, OpenAI, accesso a dati CRM reali, `AiRun`, `AiOutput`, scheduler, cron e deploy.

La PR aggiunge il contratto e le barriere che un futuro worker dovrà rispettare; non introduce un processo capace di eseguire o pianificare job.

## Catalogo canonico 13/13

- `DOCUMENT_INGESTION` → `DOCUMENT_MANIFEST`
- `DOCUMENT_CLASSIFICATION` → `DOCUMENT_CLASSIFICATION`
- `EVIDENCE_EXTRACTION` → `EVIDENCE_SET`
- `FINANCIAL_ANALYSIS` → `FINANCIAL_ANALYSIS`
- `CREDIT_ANALYSIS` → `CREDIT_ANALYSIS`
- `CALCULATIONS` → `CALCULATION_SET`
- `FINDINGS_DRAFTING` → `FINDINGS_DRAFT`
- `REPORT_COMPOSITION` → `REPORT_DRAFT`
- `SCHEMA_REVIEW` → `SCHEMA_REVIEW_REPORT`
- `NUMERIC_REVIEW` → `NUMERIC_REVIEW_REPORT`
- `SOURCE_REVIEW` → `SOURCE_REVIEW_REPORT`
- `RED_TEAM_REVIEW` → `RED_TEAM_REVIEW_REPORT`
- `CORRECTION` → `CORRECTED_REPORT` + `CORRECTION_MANIFEST`

Ogni contratto lega in modo immutabile job definition, runtime policy, capability, handler, executor/config, schema del risultato, lista ordinata degli artifact richiesti, loro schema e regole dell'envelope. Sia l'identità del singolo contratto sia quella del catalogo cambiano quando cambia una di queste componenti.

## Canonicalizzazione, hash e limiti

TypeScript usa JSON canonico con chiavi degli oggetti ordinate e ordine degli array preservato. PostgreSQL contiene il mirror delle funzioni di canonicalizzazione e degli hash, delle shape strict v1 e delle mappe esatte e versionate dei digest ammessi per i 13 contratti e i 14 tipi di artifact. Un digest formalmente valido ma diverso dal valore canonico, o un payload che dichiara uno schema senza rispettarne campi e tipi, non è accettato.

Le separazioni di dominio v1 sono `ai.payload.v1`, `ai.artifact.v1`, `ai.manifest.v1`, `ai.result.v1`, `ai.resultContract.v1`, `ai.resultContractCatalog.v1` e `ai.retentionPolicy.v1`. La provenienza inclusa nel `resultHash` lega runtime, job, attempt, fencing token, worker build, policy, capability, handler, workflow, fase, ciclo di correzione, executor/config, provider e data mode. Il fencing token è serializzato come stringa decimale canonica.

I limiti generici v1 sono applicati sia dal validatore TypeScript sia dal mirror SQL: massimo 8 artifact, 16 KiB per artifact, 64 KiB complessivi, 16 source reference, profondità JSON 8, 512 nodi, stringhe da 4096 byte, numeri finiti e sicuri e solo `application/json`. Sono rifiutati HTML, URL operativi, prompt, segreti e riferimenti a dati CRM reali. Gli schema Zod specifici restano strict e vietano campi non dichiarati.

## Completion atomica e replay

`completeAiWorkflowJob` apre una transazione `Serializable`, verifica nuovamente gate, capability, lease, identità e fencing, valida il draft e ricalcola server-side tutti gli hash. Nella stessa transazione inserisce result, artifact e source reference, applica la transizione fenced di attempt/runtime a `SUCCEEDED` e appende l'evento runtime coerente.

Qualunque errore o perdita del lease annulla l'intera transazione: non può restare un risultato parziale. Se la prima completion è già stata committata ma la risposta è andata persa, il replay ricostruisce la provenienza dal record persistito e accetta soltanto lo stesso draft con lo stesso `resultHash`; un contenuto differente fallisce chiuso.

## Invarianti PostgreSQL al commit

La migration crea `AiWorkflowJobResult`, `AiWorkflowJobArtifact` e `AiWorkflowJobSourceArtifact` con FK `RESTRICT`, indici mirati e divieti di update/delete. Trigger di vincolo `DEFERRABLE INITIALLY DEFERRED` validano prima i singoli inserimenti e poi l'aggregato finale attraverso runtime, attempt, evento, result, artifact e source reference.

Al commit, un runtime non `SUCCEEDED` non può avere un risultato; un runtime `SUCCEEDED` deve avere esattamente un risultato canonico, l'unico attempt riuscito e l'unico evento `SUCCEEDED` coerenti con identità, fencing, timestamp e hash. Cardinalità, ordine, logical key, byte totali, retention, source lineage, `manifestHash` e `resultHash` vengono ricalcolati dall'aggregato persistito. Questo controllo copre anche scritture SQL dirette che non passano dal codice applicativo.

Il preflight della migration fallisce se trova runtime `SUCCEEDED` preesistenti che richiederebbero un backfill canonico oppure se la barriera fisica `AiOrchestratorSetting_dispatch_disabled_check` non esiste, non è validata o non è esatta. Non viene eseguito alcun backfill automatico.

## Source lineage e correzioni

I ruoli delle source reference sono chiusi a `PRIMARY`, `SUPPORTING` e `SUPERSEDED`; ordine e identificatore sorgente sono univoci per risultato. Sono vietati riferimenti a se stessi, a workflow differenti e a risultati futuri o non riusciti. La sorgente deve essere terminale prima del claim dell'attempt destinatario e il suo hash deve corrispondere all'artifact persistito.

Solo il job `CORRECTION` può creare una supersession. Il `CORRECTED_REPORT` può sostituire il `REPORT_DRAFT` del ciclo precedente nella prima correzione o il `CORRECTED_REPORT` del ciclo precedente nelle correzioni successive. Ogni arco deve avere la corrispondente source reference `SUPERSEDED`; il `CORRECTION_MANIFEST` e il payload del risultato devono riportare gli stessi hash dell'aggregato persistito.

## Stato operativo e verifiche ancora richieste

La fondazione deve restare dormiente: `stateMachineEnabled=false`, `dispatchEnabled=false`, `syntheticDataOnly=true`, `provider=mock`, `externalProvidersEnabled=false`, `AI_ORCHESTRATOR_WORKER_ENABLED=0` o assente e tutte le capability worker disabilitate. La presenza delle nuove tabelle non autorizza worker, dispatch o uso di dati reali.

Prima di considerare la PR pronta devono risultare verdi in CI i test PostgreSQL 16 sulla catena completa di migration e sugli invariant SQL. Le misure `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` su un dataset sintetico rappresentativo e lo smoke Docker production restano verifiche separate: questo documento non li dichiara eseguiti né superati.

## Deploy dormiente e rollback futuri

Un eventuale deploy richiede una distinta autorizzazione, backup validato, migration applicata con tutti i gate chiusi e controlli post-deploy in sola lettura. Worker e capability non devono essere abilitati nella stessa release.

Il rollback applicativo consiste nel mantenere i gate chiusi e ripristinare l'immagine PR76 lasciando intatte le nuove tabelle append-only. Non usare `DROP`, `TRUNCATE`, reset o down migration; un eventuale restore del database è una procedura separata.
