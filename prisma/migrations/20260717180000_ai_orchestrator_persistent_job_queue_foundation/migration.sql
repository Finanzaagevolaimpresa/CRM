BEGIN;

-- NULL marks an untouched State Machine Foundation ledger row. Every row
-- appended after this migration is forced to version 1 by the deferred guard.
ALTER TABLE "AiWorkflowTransition" ADD COLUMN "jobPlanningVersion" INTEGER;
ALTER TABLE "AiWorkflowTransition" ADD CONSTRAINT "AiWorkflowTransition_jobPlanningVersion_check"
  CHECK ("jobPlanningVersion" IS NULL OR "jobPlanningVersion" = 1);

CREATE TABLE "AiWorkflowJob" (
  "id" TEXT NOT NULL,
  "workflowInstanceId" TEXT NOT NULL,
  "sourceTransitionId" TEXT NOT NULL,
  "sourceTransitionCode" TEXT NOT NULL,
  "sourceTransitionSequence" INTEGER NOT NULL,
  "workflowDefinitionHash" TEXT NOT NULL,
  "phaseCode" TEXT NOT NULL,
  "phaseEntrySequence" INTEGER NOT NULL,
  "sourceState" TEXT NOT NULL,
  "sourceStateVersion" INTEGER NOT NULL,
  "correctionCycle" INTEGER NOT NULL,
  "executorAgentId" TEXT NOT NULL,
  "executorAgentCode" TEXT NOT NULL,
  "executorAgentConfigVersion" INTEGER NOT NULL,
  "executorAgentConfigHash" TEXT NOT NULL,
  "catalogCode" TEXT NOT NULL,
  "catalogVersion" TEXT NOT NULL,
  "catalogHash" TEXT NOT NULL,
  "jobCode" TEXT NOT NULL,
  "jobVersion" TEXT NOT NULL,
  "jobDefinitionHash" TEXT NOT NULL,
  "completionTransitionCode" TEXT NOT NULL,
  "completionMode" TEXT NOT NULL,
  "slotKey" TEXT NOT NULL,
  "bundleCode" TEXT NOT NULL,
  "bundleKey" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PLANNED',
  "provider" TEXT NOT NULL DEFAULT 'mock',
  "dataMode" TEXT NOT NULL DEFAULT 'synthetic',
  "automaticDispatchAllowed" BOOLEAN NOT NULL DEFAULT false,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "plannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "availableAt" TIMESTAMP(3) NOT NULL,
  "blockedAt" TIMESTAMP(3),
  "blockedReasonCode" TEXT,

  CONSTRAINT "AiWorkflowJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowJob_catalog_policy_check" CHECK (
    "catalogCode" = 'FAI-AUDIT-JOB-CATALOG'
    AND "catalogVersion" = '1.0'
    AND "catalogHash" = '3e99436a4734323a423907bf742f71e632e433f8d0203f28da0c96bcc44a45f9'
  ),
  CONSTRAINT "AiWorkflowJob_hashes_check" CHECK (
    "workflowDefinitionHash" ~ '^[0-9a-f]{64}$'
    AND "executorAgentConfigHash" ~ '^[0-9a-f]{64}$'
    AND "catalogHash" ~ '^[0-9a-f]{64}$'
    AND "jobDefinitionHash" ~ '^[0-9a-f]{64}$'
    AND "bundleKey" ~ '^[0-9a-f]{64}$'
    AND "dedupeKey" ~ '^[0-9a-f]{64}$'
    AND "payloadHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AiWorkflowJob_causal_identity_check" CHECK (
    "sourceTransitionSequence" >= 1
    AND "phaseEntrySequence" >= 1
    AND "phaseEntrySequence" <= "sourceTransitionSequence"
    AND "sourceStateVersion" >= 1
    AND "sourceStateVersion" = "sourceTransitionSequence"
    AND "correctionCycle" >= 0
    AND "executorAgentConfigVersion" >= 1
    AND LENGTH("executorAgentCode") > 0
  ),
  CONSTRAINT "AiWorkflowJob_status_check" CHECK (
    ("status" = 'PLANNED' AND "blockedAt" IS NULL AND "blockedReasonCode" IS NULL)
    OR (
      "status" = 'BLOCKED'
      AND "blockedAt" IS NOT NULL
      AND "blockedReasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    )
  ),
  CONSTRAINT "AiWorkflowJob_execution_boundary_check" CHECK (
    "provider" = 'mock'
    AND "dataMode" = 'synthetic'
    AND "automaticDispatchAllowed" = false
  ),
  CONSTRAINT "AiWorkflowJob_availability_check" CHECK ("availableAt" = "plannedAt"),
  CONSTRAINT "AiWorkflowJob_completion_mode_check" CHECK ("completionMode" IN ('SINGLE', 'ALL_OF_BUNDLE')),
  CONSTRAINT "AiWorkflowJob_payload_object_check" CHECK (JSONB_TYPEOF("payload") = 'object')
);

CREATE TABLE "AiWorkflowJobOutboxEvent" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "workflowInstanceId" TEXT NOT NULL,
  "sourceTransitionId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "deliveryState" TEXT NOT NULL DEFAULT 'PENDING',
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiWorkflowJobOutboxEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowJobOutboxEvent_contract_check" CHECK (
    "eventType" = 'AI_JOB_PLANNED' AND "eventVersion" = 1 AND "deliveryState" = 'PENDING'
  ),
  CONSTRAINT "AiWorkflowJobOutboxEvent_hashes_check" CHECK (
    "eventKey" ~ '^[0-9a-f]{64}$' AND "payloadHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AiWorkflowJobOutboxEvent_payload_object_check" CHECK (JSONB_TYPEOF("payload") = 'object')
);

CREATE UNIQUE INDEX "AiWorkflowJob_dedupeKey_key" ON "AiWorkflowJob"("dedupeKey");
CREATE UNIQUE INDEX "AiWorkflowJob_sourceTransitionId_jobCode_jobVersion_slotKey_key"
  ON "AiWorkflowJob"("sourceTransitionId", "jobCode", "jobVersion", "slotKey");
CREATE INDEX "AiWorkflowJob_status_availableAt_idx" ON "AiWorkflowJob"("status", "availableAt");
CREATE INDEX "AiWorkflowJob_workflowInstanceId_status_availableAt_idx"
  ON "AiWorkflowJob"("workflowInstanceId", "status", "availableAt");
CREATE INDEX "AiWorkflowJob_phaseCode_correctionCycle_status_idx"
  ON "AiWorkflowJob"("phaseCode", "correctionCycle", "status");
CREATE INDEX "AiWorkflowJob_executorConfig_status_idx"
  ON "AiWorkflowJob"("executorAgentId", "executorAgentConfigVersion", "status");
CREATE INDEX "AiWorkflowJob_sourceTransitionId_idx" ON "AiWorkflowJob"("sourceTransitionId");
CREATE INDEX "AiWorkflowJob_bundleKey_status_idx" ON "AiWorkflowJob"("bundleKey", "status");
CREATE INDEX "AiWorkflowJob_correlationId_idx" ON "AiWorkflowJob"("correlationId");

CREATE UNIQUE INDEX "AiWorkflowJobOutboxEvent_eventKey_key" ON "AiWorkflowJobOutboxEvent"("eventKey");
CREATE UNIQUE INDEX "AiWorkflowJobOutboxEvent_jobId_eventType_key"
  ON "AiWorkflowJobOutboxEvent"("jobId", "eventType");
CREATE INDEX "AiWorkflowJobOutboxEvent_deliveryState_occurredAt_idx"
  ON "AiWorkflowJobOutboxEvent"("deliveryState", "occurredAt");
CREATE INDEX "AiWorkflowJobOutboxEvent_workflowInstanceId_occurredAt_idx"
  ON "AiWorkflowJobOutboxEvent"("workflowInstanceId", "occurredAt");
CREATE INDEX "AiWorkflowJobOutboxEvent_sourceTransitionId_idx"
  ON "AiWorkflowJobOutboxEvent"("sourceTransitionId");

ALTER TABLE "AiWorkflowJob" ADD CONSTRAINT "AiWorkflowJob_workflowInstanceId_fkey"
  FOREIGN KEY ("workflowInstanceId") REFERENCES "AiWorkflowInstance"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJob" ADD CONSTRAINT "AiWorkflowJob_sourceTransitionId_fkey"
  FOREIGN KEY ("sourceTransitionId") REFERENCES "AiWorkflowTransition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJob" ADD CONSTRAINT "AiWorkflowJob_executorAgentConfig_fkey"
  FOREIGN KEY ("executorAgentId", "executorAgentConfigVersion")
  REFERENCES "AiAgentConfigVersion"("agentId", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobOutboxEvent" ADD CONSTRAINT "AiWorkflowJobOutboxEvent_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "AiWorkflowJob"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobOutboxEvent" ADD CONSTRAINT "AiWorkflowJobOutboxEvent_workflowInstanceId_fkey"
  FOREIGN KEY ("workflowInstanceId") REFERENCES "AiWorkflowInstance"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobOutboxEvent" ADD CONSTRAINT "AiWorkflowJobOutboxEvent_sourceTransitionId_fkey"
  FOREIGN KEY ("sourceTransitionId") REFERENCES "AiWorkflowTransition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Versioned SQL mirror of FAI-AUDIT-JOB-CATALOG@1.0, including the
-- job->executor binding and immutable expected config hash.
CREATE FUNCTION "expected_ai_workflow_jobs"(p_transition_code TEXT)
RETURNS TABLE (
  "jobCode" TEXT,
  "jobVersion" TEXT,
  "jobDefinitionHash" TEXT,
  "completionTransitionCode" TEXT,
  "completionMode" TEXT,
  "slotKey" TEXT,
  "bundleCode" TEXT,
  "executorAgentCode" TEXT,
  "executorAgentConfigVersion" INTEGER,
  "executorAgentConfigHash" TEXT
)
LANGUAGE sql IMMUTABLE AS $$
  SELECT mapping."jobCode", mapping."jobVersion", mapping."jobDefinitionHash",
    mapping."completionTransitionCode", mapping."completionMode", mapping."slotKey",
    mapping."bundleCode", mapping."executorAgentCode",
    mapping."executorAgentConfigVersion", mapping."executorAgentConfigHash"
  FROM (VALUES
    ('WF-004', 'DOCUMENT_INGESTION',      '1.0', 'c5139e8658ca552640247b18ae97b5331168777a69a52d6f533694d9b1fc3166', 'WF-005', 'SINGLE',        '01:DOCUMENT_INGESTION',      'DOCUMENT_PIPELINE',   'verifica_ai_preliminare_fai',          1, '99ae44b882e1cd1f52c04b8ec2ab5aa4ef2e54cb09ae0b2aecdd16587c0b4f67'),
    ('WF-005', 'DOCUMENT_CLASSIFICATION', '1.0', 'd53bd449976ccba3c69b59d9c98d6cd1765594249e4576495d1f713fbd3984ec', 'WF-006', 'SINGLE',        '01:DOCUMENT_CLASSIFICATION', 'DOCUMENT_PIPELINE',   'verifica_ai_preliminare_fai',          1, '99ae44b882e1cd1f52c04b8ec2ab5aa4ef2e54cb09ae0b2aecdd16587c0b4f67'),
    ('WF-006', 'EVIDENCE_EXTRACTION',     '1.0', '5c2d6e98c89204b585ab346b3ff514295502c124666d9f86f2af975bc1f8015e', 'WF-007', 'SINGLE',        '01:EVIDENCE_EXTRACTION',     'DOCUMENT_PIPELINE',   'pre_analisi_ai_ammissibilita_fai',     1, '3b5902fb767a64e7710d5bd71cc283102d0df3a4a6184d8786e6a5f06510ef5c'),
    ('WF-009', 'DOCUMENT_INGESTION',      '1.0', 'c5139e8658ca552640247b18ae97b5331168777a69a52d6f533694d9b1fc3166', 'WF-005', 'SINGLE',        '01:DOCUMENT_INGESTION',      'DOCUMENT_PIPELINE',   'verifica_ai_preliminare_fai',          1, '99ae44b882e1cd1f52c04b8ec2ab5aa4ef2e54cb09ae0b2aecdd16587c0b4f67'),
    ('WF-010', 'FINANCIAL_ANALYSIS',      '1.0', '401f38a8b56f036257e983e9e7942c1fabbc90482d0bc00587704b12cdd3c87d', 'WF-011', 'ALL_OF_BUNDLE', '01:FINANCIAL_ANALYSIS',      'ANALYSIS_BUNDLE',     'business_plan_fai',                    1, '48baa1112ed62a6cba09f35dea87557adf43df7304feefb5693f9379a8340e3e'),
    ('WF-010', 'CREDIT_ANALYSIS',         '1.0', '0880d19f715b47030ca52e441fa697da336b60dc5f8476a0dbee573e5a592e18', 'WF-011', 'ALL_OF_BUNDLE', '02:CREDIT_ANALYSIS',         'ANALYSIS_BUNDLE',     'audit_ai_bancabilita_fai',             1, 'e575e630bbd7daeb92e281619a374fff8afd064c18adb5d833af177fe7ebbb4c'),
    ('WF-010', 'CALCULATIONS',            '1.0', 'ff1538c4129cc4b14aeed626d255f8910a565261741c1efbe645c668227bd378', 'WF-011', 'ALL_OF_BUNDLE', '03:CALCULATIONS',            'ANALYSIS_BUNDLE',     'business_plan_fai',                    1, '48baa1112ed62a6cba09f35dea87557adf43df7304feefb5693f9379a8340e3e'),
    ('WF-011', 'FINDINGS_DRAFTING',       '1.0', 'cedaf856b21a00f0b3f5edb92148f3c3a49e72d1faf6487aac28c772d7d351fd', 'WF-012', 'SINGLE',        '01:FINDINGS_DRAFTING',       'DRAFTING_PIPELINE', 'pre_analisi_ai_ammissibilita_fai',     1, '3b5902fb767a64e7710d5bd71cc283102d0df3a4a6184d8786e6a5f06510ef5c'),
    ('WF-012', 'REPORT_COMPOSITION',      '1.0', '9ca22ddbd6e664433b6caa4cf7aa4f298c0f332e771f2dca9c6d9dc922b61233', 'WF-013', 'SINGLE',        '01:REPORT_COMPOSITION',      'DRAFTING_PIPELINE', 'dossier_strategico_fai',                1, 'd9c6dc5418e2beb0ac1468770cfa7f629b870ef2312df2f8ca20f53f5135af49'),
    ('WF-013', 'SCHEMA_REVIEW',           '1.0', 'e9bed22d8af15be8ebe834cdc9fc470272cb923c56dc36e23379a4f1e4473893', 'WF-014', 'ALL_OF_BUNDLE', '01:SCHEMA_REVIEW',           'REVIEW_BUNDLE',       'revisore_ai_fai',                       1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('WF-013', 'NUMERIC_REVIEW',          '1.0', 'af7cb1aeb637b894949a1bffd9302b80e885f4166537996455554b02461210ca', 'WF-014', 'ALL_OF_BUNDLE', '02:NUMERIC_REVIEW',          'REVIEW_BUNDLE',       'revisore_ai_fai',                       1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('WF-013', 'SOURCE_REVIEW',           '1.0', 'a44a71297b6db68ffdfb219a88eda66bf7ad8d2a8c8472f76e793f798f582207', 'WF-014', 'ALL_OF_BUNDLE', '03:SOURCE_REVIEW',           'REVIEW_BUNDLE',       'revisore_ai_fai',                       1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('WF-013', 'RED_TEAM_REVIEW',         '1.0', 'ecacd1eba32c78a0e7868d2b6683fc3f136c84e402105fd8e35dd0c9e96d1e0a', 'WF-014', 'ALL_OF_BUNDLE', '04:RED_TEAM_REVIEW',         'REVIEW_BUNDLE',       'revisore_ai_fai',                       1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('WF-015', 'CORRECTION',              '1.0', '304f384f455ff396dc3a4b90b674da428ee19461623cb6b669d180135989ed6f', 'WF-016', 'SINGLE',        '01:CORRECTION',              'CORRECTION_PIPELINE', 'ottimizzazione_ai_progetto_fai',        1, '2b213d8a828c55a16eb14be27b18a90812e530ecd522a073576d8e36e33a58ff'),
    ('WF-016', 'SCHEMA_REVIEW',           '1.0', 'e9bed22d8af15be8ebe834cdc9fc470272cb923c56dc36e23379a4f1e4473893', 'WF-014', 'ALL_OF_BUNDLE', '01:SCHEMA_REVIEW',           'REVIEW_BUNDLE',       'revisore_ai_fai',                       1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('WF-016', 'NUMERIC_REVIEW',          '1.0', 'af7cb1aeb637b894949a1bffd9302b80e885f4166537996455554b02461210ca', 'WF-014', 'ALL_OF_BUNDLE', '02:NUMERIC_REVIEW',          'REVIEW_BUNDLE',       'revisore_ai_fai',                       1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('WF-016', 'SOURCE_REVIEW',           '1.0', 'a44a71297b6db68ffdfb219a88eda66bf7ad8d2a8c8472f76e793f798f582207', 'WF-014', 'ALL_OF_BUNDLE', '03:SOURCE_REVIEW',           'REVIEW_BUNDLE',       'revisore_ai_fai',                       1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('WF-016', 'RED_TEAM_REVIEW',         '1.0', 'ecacd1eba32c78a0e7868d2b6683fc3f136c84e402105fd8e35dd0c9e96d1e0a', 'WF-014', 'ALL_OF_BUNDLE', '04:RED_TEAM_REVIEW',         'REVIEW_BUNDLE',       'revisore_ai_fai',                       1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f')
  ) AS mapping(
    "sourceTransitionCode", "jobCode", "jobVersion", "jobDefinitionHash",
    "completionTransitionCode", "completionMode", "slotKey", "bundleCode",
    "executorAgentCode", "executorAgentConfigVersion", "executorAgentConfigHash"
  )
  WHERE mapping."sourceTransitionCode" = p_transition_code
  ORDER BY mapping."slotKey";
$$;

CREATE FUNCTION "ai_agent_config_snapshot_hash"(snapshot "AiAgentConfigVersion")
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(
    JSONB_BUILD_OBJECT(
      'schemaVersion', 1,
      'version', snapshot."version",
      'code', snapshot."code",
      'name', snapshot."name",
      'description', snapshot."description",
      'operationalScope', snapshot."operationalScope",
      'systemPrompt', snapshot."systemPrompt",
      'requiredDataChecklist', snapshot."requiredDataChecklist",
      'expectedOutput', snapshot."expectedOutput",
      'toneStyle', snapshot."toneStyle",
      'active', snapshot."active",
      'provider', snapshot."provider",
      'model', snapshot."model",
      'promptVersion', snapshot."promptVersion",
      'inputSchema', snapshot."inputSchema",
      'outputSchema', snapshot."outputSchema"
    )
  ), 'UTF8')), 'hex');
$$;

CREATE FUNCTION "validate_ai_workflow_job_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transition_row "AiWorkflowTransition"%ROWTYPE;
  command_row "AiWorkflowCommand"%ROWTYPE;
  instance_row "AiWorkflowInstance"%ROWTYPE;
  config_row "AiAgentConfigVersion"%ROWTYPE;
  agent_row "AiAgent"%ROWTYPE;
  expected RECORD;
  expected_phase_code TEXT;
  expected_phase_entry_sequence INTEGER;
  expected_correction_cycle INTEGER;
  expected_bundle_key TEXT;
  expected_dedupe_key TEXT;
  top_level_key_count INTEGER;
  workflow_key_count INTEGER;
  phase_key_count INTEGER;
  source_transition_key_count INTEGER;
  executor_key_count INTEGER;
  job_key_count INTEGER;
BEGIN
  IF NEW."status" <> 'PLANNED' OR NEW."blockedAt" IS NOT NULL OR NEW."blockedReasonCode" IS NOT NULL THEN
    RAISE EXCEPTION 'AiWorkflowJob must be inserted as PLANNED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "AiOrchestratorSetting" WHERE "id" = 'global'
      AND "stateMachineEnabled" = true AND "dispatchEnabled" = false
      AND "syntheticDataOnly" = true AND "provider" = 'mock'
  ) OR NOT EXISTS (
    SELECT 1 FROM "AiControlSetting" WHERE "id" = 'global' AND "externalProvidersEnabled" = false
  ) THEN
    RAISE EXCEPTION 'Persistent Job Queue Foundation is not in a safe state';
  END IF;

  SELECT * INTO transition_row FROM "AiWorkflowTransition" WHERE "id" = NEW."sourceTransitionId";
  IF NOT FOUND
    OR transition_row."jobPlanningVersion" IS DISTINCT FROM 1
    OR transition_row."workflowInstanceId" IS DISTINCT FROM NEW."workflowInstanceId"
    OR transition_row."transitionCode" IS DISTINCT FROM NEW."sourceTransitionCode"
    OR transition_row."sequence" IS DISTINCT FROM NEW."sourceTransitionSequence"
    OR transition_row."correlationId" IS DISTINCT FROM NEW."correlationId"
  THEN RAISE EXCEPTION 'AiWorkflowJob source transition binding is invalid'; END IF;

  SELECT * INTO command_row FROM "AiWorkflowCommand"
    WHERE "id" = transition_row."commandId" AND "workflowInstanceId" = NEW."workflowInstanceId";
  SELECT * INTO instance_row FROM "AiWorkflowInstance" WHERE "id" = NEW."workflowInstanceId";
  IF command_row."id" IS NULL OR instance_row."id" IS NULL THEN
    RAISE EXCEPTION 'AiWorkflowJob source command or workflow is missing';
  END IF;

  SELECT * INTO expected FROM "expected_ai_workflow_jobs"(transition_row."transitionCode") AS expected_jobs
    WHERE expected_jobs."jobCode" = NEW."jobCode" AND expected_jobs."slotKey" = NEW."slotKey";
  IF NOT FOUND
    OR expected."jobVersion" IS DISTINCT FROM NEW."jobVersion"
    OR expected."jobDefinitionHash" IS DISTINCT FROM NEW."jobDefinitionHash"
    OR expected."completionTransitionCode" IS DISTINCT FROM NEW."completionTransitionCode"
    OR expected."completionMode" IS DISTINCT FROM NEW."completionMode"
    OR expected."bundleCode" IS DISTINCT FROM NEW."bundleCode"
    OR expected."executorAgentCode" IS DISTINCT FROM NEW."executorAgentCode"
    OR expected."executorAgentConfigVersion" IS DISTINCT FROM NEW."executorAgentConfigVersion"
    OR expected."executorAgentConfigHash" IS DISTINCT FROM NEW."executorAgentConfigHash"
  THEN RAISE EXCEPTION 'AiWorkflowJob does not match the canonical catalog mapping'; END IF;

  SELECT * INTO config_row FROM "AiAgentConfigVersion"
    WHERE "agentId" = NEW."executorAgentId" AND "version" = NEW."executorAgentConfigVersion";
  SELECT * INTO agent_row FROM "AiAgent" WHERE "id" = NEW."executorAgentId";
  IF config_row."id" IS NULL OR agent_row."id" IS NULL
    OR config_row."code" IS DISTINCT FROM NEW."executorAgentCode"
    OR agent_row."code" IS DISTINCT FROM NEW."executorAgentCode"
    OR config_row."active" IS DISTINCT FROM true OR agent_row."active" IS DISTINCT FROM true
    OR config_row."provider" IS DISTINCT FROM 'mock' OR agent_row."provider" IS DISTINCT FROM 'mock'
    OR config_row."model" IS NOT NULL
    OR agent_row."configVersion" IS DISTINCT FROM NEW."executorAgentConfigVersion"
    OR "ai_agent_config_snapshot_hash"(config_row) IS DISTINCT FROM NEW."executorAgentConfigHash"
  THEN RAISE EXCEPTION 'AiWorkflowJob executor config is unavailable or not the canonical mock snapshot'; END IF;

  expected_correction_cycle := (transition_row."guardSnapshot" ->> 'correctionCycle')::INTEGER
    + CASE WHEN transition_row."transitionCode" = 'WF-015' THEN 1 ELSE 0 END;
  IF transition_row."fromState" <> transition_row."toState" THEN
    expected_phase_code := transition_row."toState";
    expected_phase_entry_sequence := transition_row."sequence";
  ELSE
    expected_phase_code := transition_row."guardSnapshot" -> 'milestone' ->> 'phase';
    expected_phase_entry_sequence := (transition_row."guardSnapshot" -> 'milestone' ->> 'phaseEntrySequence')::INTEGER;
  END IF;
  IF NEW."workflowDefinitionHash" IS DISTINCT FROM instance_row."definitionHash"
    OR NEW."workflowDefinitionHash" IS DISTINCT FROM transition_row."definitionHash"
    OR NEW."workflowDefinitionHash" IS DISTINCT FROM command_row."definitionHash"
    OR NEW."phaseCode" IS DISTINCT FROM expected_phase_code
    OR NEW."phaseEntrySequence" IS DISTINCT FROM expected_phase_entry_sequence
    OR NEW."sourceState" IS DISTINCT FROM transition_row."fromState"
    OR NEW."sourceStateVersion" IS DISTINCT FROM transition_row."fromVersion"
    OR NEW."correctionCycle" IS DISTINCT FROM expected_correction_cycle
    OR NEW."correctionCycle" IS DISTINCT FROM instance_row."correctionCycle"
  THEN RAISE EXCEPTION 'AiWorkflowJob causal phase identity is invalid'; END IF;

  IF transition_row."metadata" -> 'jobPlanning' ->> 'catalogKey' IS DISTINCT FROM 'FAI-AUDIT-JOB-CATALOG@1.0'
    OR transition_row."metadata" -> 'jobPlanning' ->> 'catalogHash'
      IS DISTINCT FROM '3e99436a4734323a423907bf742f71e632e433f8d0203f28da0c96bcc44a45f9'
    OR transition_row."metadata" -> 'jobPlanning' ->> 'workflowDefinitionHash' IS DISTINCT FROM NEW."workflowDefinitionHash"
    OR transition_row."metadata" -> 'jobPlanning' ->> 'phaseCode' IS DISTINCT FROM NEW."phaseCode"
    OR (transition_row."metadata" -> 'jobPlanning' ->> 'phaseEntrySequence')::INTEGER IS DISTINCT FROM NEW."phaseEntrySequence"
    OR transition_row."metadata" -> 'jobPlanning' ->> 'sourceState' IS DISTINCT FROM NEW."sourceState"
    OR (transition_row."metadata" -> 'jobPlanning' ->> 'sourceStateVersion')::INTEGER IS DISTINCT FROM NEW."sourceStateVersion"
    OR (transition_row."metadata" -> 'jobPlanning' ->> 'correctionCycle')::INTEGER IS DISTINCT FROM NEW."correctionCycle"
    OR transition_row."metadata" -> 'jobPlanning' -> 'automaticDispatchAllowed' IS DISTINCT FROM 'false'::JSONB
  THEN RAISE EXCEPTION 'AiWorkflowJob transition planning metadata is invalid'; END IF;

  expected_bundle_key := ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(JSONB_BUILD_OBJECT(
    'schemaVersion', 2, 'catalogKey', 'FAI-AUDIT-JOB-CATALOG@1.0',
    'catalogHash', '3e99436a4734323a423907bf742f71e632e433f8d0203f28da0c96bcc44a45f9',
    'workflowInstanceId', NEW."workflowInstanceId", 'workflowDefinitionHash', NEW."workflowDefinitionHash",
    'phaseCode', NEW."phaseCode", 'phaseEntrySequence', NEW."phaseEntrySequence",
    'sourceCommandIdempotencyKey', command_row."idempotencyKey",
    'sourceTransitionCode', NEW."sourceTransitionCode", 'sourceTransitionSequence', NEW."sourceTransitionSequence",
    'sourceState', NEW."sourceState", 'sourceStateVersion', NEW."sourceStateVersion",
    'correctionCycle', NEW."correctionCycle", 'bundleCode', NEW."bundleCode"
  )), 'UTF8')), 'hex');
  expected_dedupe_key := ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(JSONB_BUILD_OBJECT(
    'schemaVersion', 2, 'catalogKey', 'FAI-AUDIT-JOB-CATALOG@1.0',
    'catalogHash', '3e99436a4734323a423907bf742f71e632e433f8d0203f28da0c96bcc44a45f9',
    'workflowInstanceId', NEW."workflowInstanceId", 'workflowDefinitionHash', NEW."workflowDefinitionHash",
    'phaseCode', NEW."phaseCode", 'phaseEntrySequence', NEW."phaseEntrySequence",
    'sourceCommandIdempotencyKey', command_row."idempotencyKey",
    'sourceTransitionCode', NEW."sourceTransitionCode", 'sourceTransitionSequence', NEW."sourceTransitionSequence",
    'sourceState', NEW."sourceState", 'sourceStateVersion', NEW."sourceStateVersion",
    'correctionCycle', NEW."correctionCycle",
    'executorAgentId', NEW."executorAgentId", 'executorAgentCode', NEW."executorAgentCode",
    'executorAgentConfigVersion', NEW."executorAgentConfigVersion",
    'executorAgentConfigHash', NEW."executorAgentConfigHash",
    'jobKey', NEW."jobCode" || '@' || NEW."jobVersion", 'slotKey', NEW."slotKey"
  )), 'UTF8')), 'hex');
  IF NEW."bundleKey" IS DISTINCT FROM expected_bundle_key OR NEW."dedupeKey" IS DISTINCT FROM expected_dedupe_key THEN
    RAISE EXCEPTION 'AiWorkflowJob canonical dedupe identity is invalid';
  END IF;

  SELECT COUNT(*) INTO top_level_key_count FROM JSONB_OBJECT_KEYS(NEW."payload");
  SELECT COUNT(*) INTO workflow_key_count FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'workflow');
  SELECT COUNT(*) INTO phase_key_count FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'phase');
  SELECT COUNT(*) INTO source_transition_key_count FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'sourceTransition');
  SELECT COUNT(*) INTO executor_key_count FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'executor');
  SELECT COUNT(*) INTO job_key_count FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'job');
  IF top_level_key_count IS DISTINCT FROM 8 OR workflow_key_count IS DISTINCT FROM 5
    OR phase_key_count IS DISTINCT FROM 3 OR source_transition_key_count IS DISTINCT FROM 7
    OR executor_key_count IS DISTINCT FROM 5 OR job_key_count IS DISTINCT FROM 11
    OR NEW."payload" ->> 'schemaVersion' IS DISTINCT FROM '2'
    OR NEW."payload" ->> 'catalogKey' IS DISTINCT FROM 'FAI-AUDIT-JOB-CATALOG@1.0'
    OR NEW."payload" ->> 'catalogHash' IS DISTINCT FROM NEW."catalogHash"
    OR NEW."payload" -> 'workflow' ->> 'workflowInstanceId' IS DISTINCT FROM NEW."workflowInstanceId"
    OR NEW."payload" -> 'workflow' ->> 'workflowCode' IS DISTINCT FROM instance_row."workflowCode"
    OR NEW."payload" -> 'workflow' ->> 'workflowVersion' IS DISTINCT FROM instance_row."workflowVersion"
    OR NEW."payload" -> 'workflow' ->> 'workflowDefinitionHash' IS DISTINCT FROM NEW."workflowDefinitionHash"
    OR NEW."payload" -> 'workflow' ->> 'dataMode' IS DISTINCT FROM 'synthetic'
    OR NEW."payload" -> 'phase' ->> 'phaseCode' IS DISTINCT FROM NEW."phaseCode"
    OR (NEW."payload" -> 'phase' ->> 'phaseEntrySequence')::INTEGER IS DISTINCT FROM NEW."phaseEntrySequence"
    OR (NEW."payload" -> 'phase' ->> 'correctionCycle')::INTEGER IS DISTINCT FROM NEW."correctionCycle"
    OR NEW."payload" -> 'sourceTransition' ->> 'transitionCode' IS DISTINCT FROM NEW."sourceTransitionCode"
    OR (NEW."payload" -> 'sourceTransition' ->> 'sequence')::INTEGER IS DISTINCT FROM NEW."sourceTransitionSequence"
    OR NEW."payload" -> 'sourceTransition' ->> 'idempotencyKey' IS DISTINCT FROM command_row."idempotencyKey"
    OR NEW."payload" -> 'sourceTransition' ->> 'correlationId' IS DISTINCT FROM NEW."correlationId"
    OR NEW."payload" -> 'sourceTransition' ->> 'sourceState' IS DISTINCT FROM NEW."sourceState"
    OR (NEW."payload" -> 'sourceTransition' ->> 'sourceStateVersion')::INTEGER IS DISTINCT FROM NEW."sourceStateVersion"
    OR NEW."payload" -> 'sourceTransition' ->> 'targetState' IS DISTINCT FROM transition_row."toState"
    OR NEW."payload" -> 'executor' ->> 'bindingVersion' IS DISTINCT FROM '1.0'
    OR NEW."payload" -> 'executor' ->> 'agentId' IS DISTINCT FROM NEW."executorAgentId"
    OR NEW."payload" -> 'executor' ->> 'agentCode' IS DISTINCT FROM NEW."executorAgentCode"
    OR (NEW."payload" -> 'executor' ->> 'configVersion')::INTEGER IS DISTINCT FROM NEW."executorAgentConfigVersion"
    OR NEW."payload" -> 'executor' ->> 'configHash' IS DISTINCT FROM NEW."executorAgentConfigHash"
    OR NEW."payload" -> 'job' ->> 'jobCode' IS DISTINCT FROM NEW."jobCode"
    OR NEW."payload" -> 'job' ->> 'jobVersion' IS DISTINCT FROM NEW."jobVersion"
    OR NEW."payload" -> 'job' ->> 'jobDefinitionHash' IS DISTINCT FROM NEW."jobDefinitionHash"
    OR NEW."payload" -> 'job' ->> 'completionTransitionCode' IS DISTINCT FROM NEW."completionTransitionCode"
    OR NEW."payload" -> 'job' ->> 'completionMode' IS DISTINCT FROM NEW."completionMode"
    OR NEW."payload" -> 'job' ->> 'slotKey' IS DISTINCT FROM NEW."slotKey"
    OR NEW."payload" -> 'job' ->> 'bundleCode' IS DISTINCT FROM NEW."bundleCode"
    OR NEW."payload" -> 'job' ->> 'bundleKey' IS DISTINCT FROM NEW."bundleKey"
    OR NEW."payload" -> 'job' ->> 'provider' IS DISTINCT FROM 'mock'
    OR NEW."payload" -> 'job' -> 'automaticDispatchAllowed' IS DISTINCT FROM 'false'::JSONB
    OR ((NEW."payload" -> 'job' ->> 'availableAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') IS DISTINCT FROM NEW."availableAt"
    OR NEW."payloadHash" IS DISTINCT FROM ENCODE(SHA256(CONVERT_TO(
      "canonicalize_ai_workflow_jsonb"(NEW."payload"), 'UTF8')), 'hex')
  THEN RAISE EXCEPTION 'AiWorkflowJob payload or persisted payload hash is invalid'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJob_validate_insert" BEFORE INSERT ON "AiWorkflowJob"
FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_insert"();

CREATE FUNCTION "validate_ai_workflow_job_outbox_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row "AiWorkflowJob"%ROWTYPE;
  expected_event_key TEXT;
  top_level_key_count INTEGER;
  executor_key_count INTEGER;
  job_key_count INTEGER;
BEGIN
  SELECT * INTO job_row FROM "AiWorkflowJob" WHERE "id" = NEW."jobId";
  IF NOT FOUND OR job_row."workflowInstanceId" IS DISTINCT FROM NEW."workflowInstanceId"
    OR job_row."sourceTransitionId" IS DISTINCT FROM NEW."sourceTransitionId"
    OR job_row."status" IS DISTINCT FROM 'PLANNED'
  THEN RAISE EXCEPTION 'AiWorkflowJobOutboxEvent job binding is invalid'; END IF;

  expected_event_key := ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(JSONB_BUILD_OBJECT(
    'schemaVersion', 1, 'eventType', 'AI_JOB_PLANNED', 'eventVersion', 1,
    'jobDedupeKey', job_row."dedupeKey"
  )), 'UTF8')), 'hex');
  SELECT COUNT(*) INTO top_level_key_count FROM JSONB_OBJECT_KEYS(NEW."payload");
  SELECT COUNT(*) INTO executor_key_count FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'executor');
  SELECT COUNT(*) INTO job_key_count FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'job');
  IF top_level_key_count IS DISTINCT FROM 16 OR executor_key_count IS DISTINCT FROM 4
    OR job_key_count IS DISTINCT FROM 11 OR NEW."eventKey" IS DISTINCT FROM expected_event_key
    OR NEW."payload" ->> 'schemaVersion' IS DISTINCT FROM '1'
    OR NEW."payload" ->> 'eventType' IS DISTINCT FROM 'AI_JOB_PLANNED'
    OR NEW."payload" ->> 'eventVersion' IS DISTINCT FROM '1'
    OR NEW."payload" ->> 'workflowInstanceId' IS DISTINCT FROM NEW."workflowInstanceId"
    OR NEW."payload" ->> 'sourceTransitionId' IS DISTINCT FROM NEW."sourceTransitionId"
    OR NEW."payload" ->> 'sourceTransitionCode' IS DISTINCT FROM job_row."sourceTransitionCode"
    OR (NEW."payload" ->> 'sourceTransitionSequence')::INTEGER IS DISTINCT FROM job_row."sourceTransitionSequence"
    OR NEW."payload" ->> 'workflowDefinitionHash' IS DISTINCT FROM job_row."workflowDefinitionHash"
    OR NEW."payload" ->> 'phaseCode' IS DISTINCT FROM job_row."phaseCode"
    OR (NEW."payload" ->> 'phaseEntrySequence')::INTEGER IS DISTINCT FROM job_row."phaseEntrySequence"
    OR NEW."payload" ->> 'sourceState' IS DISTINCT FROM job_row."sourceState"
    OR (NEW."payload" ->> 'sourceStateVersion')::INTEGER IS DISTINCT FROM job_row."sourceStateVersion"
    OR (NEW."payload" ->> 'correctionCycle')::INTEGER IS DISTINCT FROM job_row."correctionCycle"
    OR NEW."payload" -> 'executor' ->> 'agentId' IS DISTINCT FROM job_row."executorAgentId"
    OR NEW."payload" -> 'executor' ->> 'agentCode' IS DISTINCT FROM job_row."executorAgentCode"
    OR (NEW."payload" -> 'executor' ->> 'configVersion')::INTEGER IS DISTINCT FROM job_row."executorAgentConfigVersion"
    OR NEW."payload" -> 'executor' ->> 'configHash' IS DISTINCT FROM job_row."executorAgentConfigHash"
    OR NEW."payload" -> 'job' ->> 'id' IS DISTINCT FROM NEW."jobId"
    OR NEW."payload" -> 'job' ->> 'jobCode' IS DISTINCT FROM job_row."jobCode"
    OR NEW."payload" -> 'job' ->> 'jobVersion' IS DISTINCT FROM job_row."jobVersion"
    OR NEW."payload" -> 'job' ->> 'dedupeKey' IS DISTINCT FROM job_row."dedupeKey"
    OR NEW."payload" -> 'job' ->> 'bundleKey' IS DISTINCT FROM job_row."bundleKey"
    OR NEW."payload" -> 'job' ->> 'status' IS DISTINCT FROM 'PLANNED'
    OR NEW."payload" -> 'job' ->> 'provider' IS DISTINCT FROM 'mock'
    OR NEW."payload" -> 'job' ->> 'dataMode' IS DISTINCT FROM 'synthetic'
    OR NEW."payload" -> 'job' -> 'automaticDispatchAllowed' IS DISTINCT FROM 'false'::JSONB
    OR ((NEW."payload" -> 'job' ->> 'availableAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') IS DISTINCT FROM job_row."availableAt"
    OR NEW."payload" -> 'job' ->> 'payloadHash' IS DISTINCT FROM job_row."payloadHash"
    OR ((NEW."payload" ->> 'occurredAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') IS DISTINCT FROM NEW."occurredAt"
    OR NEW."payloadHash" IS DISTINCT FROM ENCODE(SHA256(CONVERT_TO(
      "canonicalize_ai_workflow_jsonb"(NEW."payload"), 'UTF8')), 'hex')
  THEN RAISE EXCEPTION 'AiWorkflowJobOutboxEvent canonical identity or payload is invalid'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJobOutboxEvent_validate_insert" BEFORE INSERT ON "AiWorkflowJobOutboxEvent"
FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_outbox_insert"();

CREATE FUNCTION "verify_ai_workflow_transition_job_plan"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_count INTEGER;
  actual_job_count INTEGER;
  actual_outbox_count INTEGER;
  expected_plan_hash TEXT;
  expected_phase_code TEXT;
  expected_phase_entry_sequence INTEGER;
  expected_correction_cycle INTEGER;
  expected_executors JSONB;
  command_row "AiWorkflowCommand"%ROWTYPE;
  instance_row "AiWorkflowInstance"%ROWTYPE;
BEGIN
  SELECT COUNT(*) INTO expected_count FROM "expected_ai_workflow_jobs"(NEW."transitionCode");
  SELECT * INTO command_row FROM "AiWorkflowCommand" WHERE "id" = NEW."commandId";
  SELECT * INTO instance_row FROM "AiWorkflowInstance" WHERE "id" = NEW."workflowInstanceId";
  IF command_row."id" IS NULL OR instance_row."id" IS NULL THEN
    RAISE EXCEPTION 'AiWorkflowTransition job plan identity cannot be resolved';
  END IF;

  expected_correction_cycle := (NEW."guardSnapshot" ->> 'correctionCycle')::INTEGER
    + CASE WHEN NEW."transitionCode" = 'WF-015' THEN 1 ELSE 0 END;
  IF NEW."fromState" <> NEW."toState" THEN
    expected_phase_code := NEW."toState";
    expected_phase_entry_sequence := NEW."sequence";
  ELSE
    expected_phase_code := NEW."guardSnapshot" -> 'milestone' ->> 'phase';
    expected_phase_entry_sequence := (NEW."guardSnapshot" -> 'milestone' ->> 'phaseEntrySequence')::INTEGER;
  END IF;
  SELECT COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
    'jobCode', expected."jobCode",
    'executorAgentId', config."agentId",
    'executorAgentCode', expected."executorAgentCode",
    'executorAgentConfigVersion', expected."executorAgentConfigVersion",
    'executorAgentConfigHash', expected."executorAgentConfigHash"
  ) ORDER BY expected."slotKey"), '[]'::JSONB) INTO expected_executors
  FROM "expected_ai_workflow_jobs"(NEW."transitionCode") expected
  JOIN "AiAgent" agent ON agent."code" = expected."executorAgentCode"
  JOIN "AiAgentConfigVersion" config
    ON config."agentId" = agent."id" AND config."version" = expected."executorAgentConfigVersion";

  IF NEW."jobPlanningVersion" IS DISTINCT FROM 1
    OR JSONB_TYPEOF(NEW."metadata" -> 'jobPlanning') IS DISTINCT FROM 'object'
    OR NEW."metadata" -> 'jobPlanning' ->> 'schemaVersion' IS DISTINCT FROM '2'
    OR NEW."metadata" -> 'jobPlanning' ->> 'catalogKey' IS DISTINCT FROM 'FAI-AUDIT-JOB-CATALOG@1.0'
    OR NEW."metadata" -> 'jobPlanning' ->> 'catalogHash'
      IS DISTINCT FROM '3e99436a4734323a423907bf742f71e632e433f8d0203f28da0c96bcc44a45f9'
    OR NEW."metadata" -> 'jobPlanning' ->> 'executorBindingVersion' IS DISTINCT FROM '1.0'
    OR NEW."metadata" -> 'jobPlanning' ->> 'workflowDefinitionHash' IS DISTINCT FROM NEW."definitionHash"
    OR NEW."metadata" -> 'jobPlanning' ->> 'workflowDefinitionHash' IS DISTINCT FROM instance_row."definitionHash"
    OR NEW."metadata" -> 'jobPlanning' ->> 'phaseCode' IS DISTINCT FROM expected_phase_code
    OR (NEW."metadata" -> 'jobPlanning' ->> 'phaseEntrySequence')::INTEGER IS DISTINCT FROM expected_phase_entry_sequence
    OR NEW."metadata" -> 'jobPlanning' ->> 'sourceState' IS DISTINCT FROM NEW."fromState"
    OR (NEW."metadata" -> 'jobPlanning' ->> 'sourceStateVersion')::INTEGER IS DISTINCT FROM NEW."fromVersion"
    OR (NEW."metadata" -> 'jobPlanning' ->> 'correctionCycle')::INTEGER IS DISTINCT FROM expected_correction_cycle
    OR (NEW."metadata" -> 'jobPlanning' ->> 'correctionCycle')::INTEGER IS DISTINCT FROM instance_row."correctionCycle"
    OR NEW."metadata" -> 'jobPlanning' -> 'executors' IS DISTINCT FROM expected_executors
    OR NEW."metadata" -> 'jobPlanning' ->> 'planHash' IS NULL
    OR NEW."metadata" -> 'jobPlanning' ->> 'planHash' !~ '^[0-9a-f]{64}$'
    OR JSONB_TYPEOF(NEW."metadata" -> 'jobPlanning' -> 'plannedJobCount') IS DISTINCT FROM 'number'
    OR (NEW."metadata" -> 'jobPlanning' ->> 'plannedJobCount')::INTEGER IS DISTINCT FROM expected_count
    OR NEW."metadata" -> 'jobPlanning' -> 'automaticDispatchAllowed' IS DISTINCT FROM 'false'::JSONB
  THEN RAISE EXCEPTION 'AiWorkflowTransition job planning metadata is incomplete or invalid'; END IF;

  SELECT COUNT(*) INTO actual_job_count FROM "AiWorkflowJob"
    WHERE "sourceTransitionId" = NEW."id" AND "workflowInstanceId" = NEW."workflowInstanceId";
  SELECT COUNT(*) INTO actual_outbox_count FROM "AiWorkflowJobOutboxEvent"
    WHERE "sourceTransitionId" = NEW."id" AND "workflowInstanceId" = NEW."workflowInstanceId"
      AND "eventType" = 'AI_JOB_PLANNED' AND "deliveryState" = 'PENDING';
  IF actual_job_count <> expected_count OR actual_outbox_count <> expected_count THEN
    RAISE EXCEPTION 'AiWorkflowTransition does not own the exact transactional job plan and outbox';
  END IF;

  SELECT ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(JSONB_BUILD_OBJECT(
    'schemaVersion', 2, 'catalogKey', 'FAI-AUDIT-JOB-CATALOG@1.0',
    'catalogHash', '3e99436a4734323a423907bf742f71e632e433f8d0203f28da0c96bcc44a45f9',
    'workflowInstanceId', NEW."workflowInstanceId", 'workflowDefinitionHash', NEW."definitionHash",
    'phaseCode', expected_phase_code, 'phaseEntrySequence', expected_phase_entry_sequence,
    'sourceCommandIdempotencyKey', command_row."idempotencyKey",
    'sourceTransitionCode', NEW."transitionCode", 'sourceTransitionSequence', NEW."sequence",
    'sourceState', NEW."fromState", 'sourceStateVersion', NEW."fromVersion",
    'correctionCycle', expected_correction_cycle,
    'jobs', COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
      'executorAgentId', queue_job."executorAgentId",
      'executorAgentCode', queue_job."executorAgentCode",
      'executorAgentConfigVersion', queue_job."executorAgentConfigVersion",
      'executorAgentConfigHash', queue_job."executorAgentConfigHash",
      'jobCode', queue_job."jobCode", 'jobVersion', queue_job."jobVersion",
      'jobDefinitionHash', queue_job."jobDefinitionHash", 'slotKey', queue_job."slotKey",
      'bundleKey', queue_job."bundleKey", 'dedupeKey', queue_job."dedupeKey",
      'payloadHash', queue_job."payloadHash"
    ) ORDER BY queue_job."slotKey"), '[]'::JSONB)
  )), 'UTF8')), 'hex') INTO expected_plan_hash
  FROM "AiWorkflowJob" queue_job
  WHERE queue_job."sourceTransitionId" = NEW."id" AND queue_job."workflowInstanceId" = NEW."workflowInstanceId";
  IF NEW."metadata" -> 'jobPlanning' ->> 'planHash' IS DISTINCT FROM expected_plan_hash THEN
    RAISE EXCEPTION 'AiWorkflowTransition canonical job plan hash is invalid';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiWorkflowTransition_requires_job_plan"
AFTER INSERT ON "AiWorkflowTransition" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_transition_job_plan"();

CREATE FUNCTION "verify_ai_workflow_job_outbox"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AiWorkflowJobOutboxEvent" WHERE "jobId" = NEW."id"
      AND "workflowInstanceId" = NEW."workflowInstanceId"
      AND "sourceTransitionId" = NEW."sourceTransitionId"
      AND "eventType" = 'AI_JOB_PLANNED' AND "deliveryState" = 'PENDING'
  ) THEN RAISE EXCEPTION 'AiWorkflowJob has no matching transactional outbox event'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiWorkflowJob_requires_outbox"
AFTER INSERT ON "AiWorkflowJob" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_job_outbox"();

CREATE FUNCTION "protect_ai_workflow_job_lifecycle"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."workflowInstanceId" IS DISTINCT FROM NEW."workflowInstanceId"
    OR OLD."sourceTransitionId" IS DISTINCT FROM NEW."sourceTransitionId"
    OR OLD."sourceTransitionCode" IS DISTINCT FROM NEW."sourceTransitionCode"
    OR OLD."sourceTransitionSequence" IS DISTINCT FROM NEW."sourceTransitionSequence"
    OR OLD."workflowDefinitionHash" IS DISTINCT FROM NEW."workflowDefinitionHash"
    OR OLD."phaseCode" IS DISTINCT FROM NEW."phaseCode"
    OR OLD."phaseEntrySequence" IS DISTINCT FROM NEW."phaseEntrySequence"
    OR OLD."sourceState" IS DISTINCT FROM NEW."sourceState"
    OR OLD."sourceStateVersion" IS DISTINCT FROM NEW."sourceStateVersion"
    OR OLD."correctionCycle" IS DISTINCT FROM NEW."correctionCycle"
    OR OLD."executorAgentId" IS DISTINCT FROM NEW."executorAgentId"
    OR OLD."executorAgentCode" IS DISTINCT FROM NEW."executorAgentCode"
    OR OLD."executorAgentConfigVersion" IS DISTINCT FROM NEW."executorAgentConfigVersion"
    OR OLD."executorAgentConfigHash" IS DISTINCT FROM NEW."executorAgentConfigHash"
    OR OLD."catalogCode" IS DISTINCT FROM NEW."catalogCode"
    OR OLD."catalogVersion" IS DISTINCT FROM NEW."catalogVersion"
    OR OLD."catalogHash" IS DISTINCT FROM NEW."catalogHash"
    OR OLD."jobCode" IS DISTINCT FROM NEW."jobCode" OR OLD."jobVersion" IS DISTINCT FROM NEW."jobVersion"
    OR OLD."jobDefinitionHash" IS DISTINCT FROM NEW."jobDefinitionHash"
    OR OLD."completionTransitionCode" IS DISTINCT FROM NEW."completionTransitionCode"
    OR OLD."completionMode" IS DISTINCT FROM NEW."completionMode"
    OR OLD."slotKey" IS DISTINCT FROM NEW."slotKey" OR OLD."bundleCode" IS DISTINCT FROM NEW."bundleCode"
    OR OLD."bundleKey" IS DISTINCT FROM NEW."bundleKey" OR OLD."dedupeKey" IS DISTINCT FROM NEW."dedupeKey"
    OR OLD."provider" IS DISTINCT FROM NEW."provider" OR OLD."dataMode" IS DISTINCT FROM NEW."dataMode"
    OR OLD."automaticDispatchAllowed" IS DISTINCT FROM NEW."automaticDispatchAllowed"
    OR OLD."payload" IS DISTINCT FROM NEW."payload" OR OLD."payloadHash" IS DISTINCT FROM NEW."payloadHash"
    OR OLD."correlationId" IS DISTINCT FROM NEW."correlationId"
    OR OLD."plannedAt" IS DISTINCT FROM NEW."plannedAt" OR OLD."availableAt" IS DISTINCT FROM NEW."availableAt"
  THEN RAISE EXCEPTION 'AiWorkflowJob identity, availability and payload are immutable'; END IF;
  IF OLD."status" <> 'PLANNED' OR NEW."status" <> 'BLOCKED'
    OR NEW."blockedAt" IS NULL OR NEW."blockedReasonCode" !~ '^[A-Z][A-Z0-9_]{2,63}$'
  THEN RAISE EXCEPTION 'AiWorkflowJob only supports the one-way PLANNED to BLOCKED safety transition'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJob_block_only" BEFORE UPDATE ON "AiWorkflowJob"
FOR EACH ROW EXECUTE FUNCTION "protect_ai_workflow_job_lifecycle"();

CREATE FUNCTION "reject_ai_workflow_queue_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only and cannot be mutated', TG_TABLE_NAME; END;
$$;

CREATE TRIGGER "AiWorkflowJob_immutable_delete" BEFORE DELETE ON "AiWorkflowJob"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_queue_mutation"();
CREATE TRIGGER "AiWorkflowJobOutboxEvent_immutable_update" BEFORE UPDATE ON "AiWorkflowJobOutboxEvent"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_queue_mutation"();
CREATE TRIGGER "AiWorkflowJobOutboxEvent_immutable_delete" BEFORE DELETE ON "AiWorkflowJobOutboxEvent"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_queue_mutation"();

COMMIT;
