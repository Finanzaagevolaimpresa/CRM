# AI Orchestrator Result & Artifact Contract Foundation v1

## Obiettivo e confini
Questa fondazione definisce il contratto result/artifact v1 e la persistenza append-only per completare job AI Orchestrator in modo atomico, fenced, idempotente e sintetico. Sono esclusi worker, handler eseguibili, route API, UI, dispatch, provider esterni, OpenAI, accesso CRM reale, AiRun, AiOutput, cron e deploy.

## Catalogo 13/13
- DOCUMENT_INGESTION → DOCUMENT_MANIFEST
- DOCUMENT_CLASSIFICATION → DOCUMENT_CLASSIFICATION
- EVIDENCE_EXTRACTION → EVIDENCE_SET
- FINANCIAL_ANALYSIS → FINANCIAL_ANALYSIS
- CREDIT_ANALYSIS → CREDIT_ANALYSIS
- CALCULATIONS → CALCULATION_SET
- FINDINGS_DRAFTING → FINDINGS_DRAFT
- REPORT_COMPOSITION → REPORT_DRAFT
- SCHEMA_REVIEW → SCHEMA_REVIEW_REPORT
- NUMERIC_REVIEW → NUMERIC_REVIEW_REPORT
- SOURCE_REVIEW → SOURCE_REVIEW_REPORT
- RED_TEAM_REVIEW → RED_TEAM_REVIEW_REPORT
- CORRECTION → CORRECTED_REPORT + CORRECTION_MANIFEST

Il catalogo usa lookup O(1) tramite Map ed è legato agli hash di job definition, capability, handler identity e runtime policy.

## Hash e limiti
Domain separation: `ai.payload.v1`, `ai.artifact.v1`, `ai.manifest.v1`, `ai.result.v1`, `ai.resultContract.v1`, `ai.resultContractCatalog.v1`, `ai.retentionPolicy.v1`. Il fencing token entra nella provenienza come stringa decimale canonica. Limiti v1: massimo 8 artifact, 16 KiB per artifact, 64 KiB risultato complessivo, 16 source reference, profondità JSON 8, 512 nodi, stringhe 4096 byte, solo `application/json`, nessun HTML, URL operativo, prompt, segreto o dato CRM reale.

## Migration e retention
La migration è additiva, crea `AiWorkflowJobResult`, `AiWorkflowJobArtifact` e `AiWorkflowJobSourceArtifact`, FK RESTRICT, indici mirati e trigger append-only. Preflight fail-closed blocca runtime SUCCEEDED preesistenti senza risultati canonici e verifica `AiOrchestratorSetting_dispatch_disabled_check`. La retention aggiunge solo policy code/version/hash, classe e retainUntil deterministico; nessun cleanup o purge.

## Performance misurate
Soglie documentate: lookup contratto O(1) sotto 1 ms su 13 contratti; validazione+hash del payload massimo sotto 50 ms su workstation CI; query primarie via indici su runtime/result/artifact. Dataset sintetico target: 10.000 record con `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; nessun indice GIN sui payload.

## Deploy dormiente futuro
Applicare migration solo in ambiente controllato con gate chiusi; non abilitare worker o capability nella stessa release. La compatibilità PR76 è preservata perché le nuove tabelle sono additive.
