BEGIN;

CREATE TABLE "AiWorkflowJob" (
  "id" TEXT NOT NULL,
  "workflowInstanceId" TEXT NOT NULL,
  "sourceTransitionId" TEXT NOT NULL,
  "sourceTransitionCode" TEXT NOT NULL,
  "sourceTransitionSequence" INTEGER NOT NULL,
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
  "blockedAt" TIMESTAMP(3),
  "blockedReasonCode" TEXT,

  CONSTRAINT "AiWorkflowJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowJob_catalog_policy_check" CHECK (
    "catalogCode" = 'FAI-AUDIT-JOB-CATALOG'
    AND "catalogVersion" = '1.0'
    AND "catalogHash" = 'eca7f4174ab8a188ef21df6758ab6cfd081dd51a126f47097f6a3706ec7bbb9e'
  ),
  CONSTRAINT "AiWorkflowJob_hashes_check" CHECK (
    "catalogHash" ~ '^[0-9a-f]{64}$'
    AND "jobDefinitionHash" ~ '^[0-9a-f]{64}$'
    AND "bundleKey" ~ '^[0-9a-f]{64}$'
    AND "dedupeKey" ~ '^[0-9a-f]{64}$'
    AND "payloadHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AiWorkflowJob_status_check" CHECK (
    (
      "status" = 'PLANNED'
      AND "blockedAt" IS NULL
      AND "blockedReasonCode" IS NULL
    )
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
  CONSTRAINT "AiWorkflowJob_completion_mode_check" CHECK (
    "completionMode" IN ('SINGLE', 'ALL_OF_BUNDLE')
  ),
  CONSTRAINT "AiWorkflowJob_sequence_check" CHECK ("sourceTransitionSequence" >= 1),
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
    "eventType" = 'AI_JOB_PLANNED'
    AND "eventVersion" = 1
    AND "deliveryState" = 'PENDING'
  ),
  CONSTRAINT "AiWorkflowJobOutboxEvent_hashes_check" CHECK (
    "eventKey" ~ '^[0-9a-f]{64}$'
    AND "payloadHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AiWorkflowJobOutboxEvent_payload_object_check" CHECK (JSONB_TYPEOF("payload") = 'object')
);

CREATE UNIQUE INDEX "AiWorkflowJob_dedupeKey_key" ON "AiWorkflowJob"("dedupeKey");
CREATE UNIQUE INDEX "AiWorkflowJob_sourceTransitionId_jobCode_jobVersion_slotKey_key"
  ON "AiWorkflowJob"("sourceTransitionId", "jobCode", "jobVersion", "slotKey");
CREATE INDEX "AiWorkflowJob_workflowInstanceId_status_plannedAt_idx"
  ON "AiWorkflowJob"("workflowInstanceId", "status", "plannedAt");
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

ALTER TABLE "AiWorkflowJob"
  ADD CONSTRAINT "AiWorkflowJob_workflowInstanceId_fkey"
  FOREIGN KEY ("workflowInstanceId") REFERENCES "AiWorkflowInstance"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiWorkflowJob"
  ADD CONSTRAINT "AiWorkflowJob_sourceTransitionId_fkey"
  FOREIGN KEY ("sourceTransitionId") REFERENCES "AiWorkflowTransition"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiWorkflowJobOutboxEvent"
  ADD CONSTRAINT "AiWorkflowJobOutboxEvent_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "AiWorkflowJob"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiWorkflowJobOutboxEvent"
  ADD CONSTRAINT "AiWorkflowJobOutboxEvent_workflowInstanceId_fkey"
  FOREIGN KEY ("workflowInstanceId") REFERENCES "AiWorkflowInstance"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiWorkflowJobOutboxEvent"
  ADD CONSTRAINT "AiWorkflowJobOutboxEvent_sourceTransitionId_fkey"
  FOREIGN KEY ("sourceTransitionId") REFERENCES "AiWorkflowTransition"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The versioned SQL mapping mirrors FAI-AUDIT-JOB-CATALOG@1.0. It is used by
-- database guards so a direct insert cannot invent, omit or reorder jobs.
CREATE FUNCTION "expected_ai_workflow_jobs"(p_transition_code TEXT)
RETURNS TABLE (
  "jobCode" TEXT,
  "jobVersion" TEXT,
  "jobDefinitionHash" TEXT,
  "completionTransitionCode" TEXT,
  "completionMode" TEXT,
  "slotKey" TEXT,
  "bundleCode" TEXT
)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    mapping."jobCode",
    mapping."jobVersion",
    mapping."jobDefinitionHash",
    mapping."completionTransitionCode",
    mapping."completionMode",
    mapping."slotKey",
    mapping."bundleCode"
  FROM (VALUES
    ('WF-004', 'DOCUMENT_INGESTION',      '1.0', '012e5f676a2e4e06f863f23e7f59fe921d6d848f3c5648753f6ba3867d9b87f1', 'WF-005', 'SINGLE',        '01:DOCUMENT_INGESTION',      'DOCUMENT_PIPELINE'),
    ('WF-005', 'DOCUMENT_CLASSIFICATION', '1.0', '6bd0bb40c5b1f060b4cc715beea7e027e1234737706c566a9573d7b8e59003ef', 'WF-006', 'SINGLE',        '01:DOCUMENT_CLASSIFICATION', 'DOCUMENT_PIPELINE'),
    ('WF-006', 'EVIDENCE_EXTRACTION',     '1.0', 'e7b02e77b2e3b65b073aa8b4f53fdc041d065384e20788b74a9912c0620737d2', 'WF-007', 'SINGLE',        '01:EVIDENCE_EXTRACTION',     'DOCUMENT_PIPELINE'),
    ('WF-009', 'DOCUMENT_INGESTION',      '1.0', '012e5f676a2e4e06f863f23e7f59fe921d6d848f3c5648753f6ba3867d9b87f1', 'WF-005', 'SINGLE',        '01:DOCUMENT_INGESTION',      'DOCUMENT_PIPELINE'),
    ('WF-010', 'FINANCIAL_ANALYSIS',      '1.0', '31ba8cdd82054ba27c2e2492185979984a7dc4a3db55ad13a9b7a7bf828fd6f0', 'WF-011', 'ALL_OF_BUNDLE', '01:FINANCIAL_ANALYSIS',      'ANALYSIS_BUNDLE'),
    ('WF-010', 'CREDIT_ANALYSIS',         '1.0', 'b7e16d8279a391c1b52ddba7adfaa215ed6feb0fa8961b0dc5fa912c7145f2ce', 'WF-011', 'ALL_OF_BUNDLE', '02:CREDIT_ANALYSIS',         'ANALYSIS_BUNDLE'),
    ('WF-010', 'CALCULATIONS',            '1.0', '3d2d5a02060182b574923747b3d5dcd82f8f9e539a2f67fceae703801338a17b', 'WF-011', 'ALL_OF_BUNDLE', '03:CALCULATIONS',            'ANALYSIS_BUNDLE'),
    ('WF-011', 'FINDINGS_DRAFTING',       '1.0', '157a6311b9cb8281a6f6e464fb5d0289834aa46aee83905e186c784e08aa042b', 'WF-012', 'SINGLE',        '01:FINDINGS_DRAFTING',       'DRAFTING_PIPELINE'),
    ('WF-012', 'REPORT_COMPOSITION',      '1.0', 'e6c1da431c2c828a97ff70aea8b19b0e08f4949845114f62119d8cdc8ca02499', 'WF-013', 'SINGLE',        '01:REPORT_COMPOSITION',      'DRAFTING_PIPELINE'),
    ('WF-013', 'SCHEMA_REVIEW',           '1.0', 'f8031a32267411d43ce43c1f960c201d8f5e2466a1b5ff302f2dea009c43b3e6', 'WF-014', 'ALL_OF_BUNDLE', '01:SCHEMA_REVIEW',           'REVIEW_BUNDLE'),
    ('WF-013', 'NUMERIC_REVIEW',          '1.0', 'ab14e99492dfe0741b355700d57c8ec5b73e997e73c65dbe1711d65ce75aeae2', 'WF-014', 'ALL_OF_BUNDLE', '02:NUMERIC_REVIEW',          'REVIEW_BUNDLE'),
    ('WF-013', 'SOURCE_REVIEW',           '1.0', '5bc4ba2e2769cf3422e20545bfacfa55877c8c08ee4070414b855e525919c2e2', 'WF-014', 'ALL_OF_BUNDLE', '03:SOURCE_REVIEW',           'REVIEW_BUNDLE'),
    ('WF-013', 'RED_TEAM_REVIEW',         '1.0', '4522bad91b19e260ff6e382925595631c662a20c1ee64149fc2254eb7c39e831', 'WF-014', 'ALL_OF_BUNDLE', '04:RED_TEAM_REVIEW',         'REVIEW_BUNDLE'),
    ('WF-015', 'CORRECTION',              '1.0', 'da40a0bd921a417aec0f3ae38313b31a78a4fa4fc67165c3a6ac01d3bb885963', 'WF-016', 'SINGLE',        '01:CORRECTION',              'CORRECTION_PIPELINE'),
    ('WF-016', 'SCHEMA_REVIEW',           '1.0', 'f8031a32267411d43ce43c1f960c201d8f5e2466a1b5ff302f2dea009c43b3e6', 'WF-014', 'ALL_OF_BUNDLE', '01:SCHEMA_REVIEW',           'REVIEW_BUNDLE'),
    ('WF-016', 'NUMERIC_REVIEW',          '1.0', 'ab14e99492dfe0741b355700d57c8ec5b73e997e73c65dbe1711d65ce75aeae2', 'WF-014', 'ALL_OF_BUNDLE', '02:NUMERIC_REVIEW',          'REVIEW_BUNDLE'),
    ('WF-016', 'SOURCE_REVIEW',           '1.0', '5bc4ba2e2769cf3422e20545bfacfa55877c8c08ee4070414b855e525919c2e2', 'WF-014', 'ALL_OF_BUNDLE', '03:SOURCE_REVIEW',           'REVIEW_BUNDLE'),
    ('WF-016', 'RED_TEAM_REVIEW',         '1.0', '4522bad91b19e260ff6e382925595631c662a20c1ee64149fc2254eb7c39e831', 'WF-014', 'ALL_OF_BUNDLE', '04:RED_TEAM_REVIEW',         'REVIEW_BUNDLE')
  ) AS mapping(
    "sourceTransitionCode",
    "jobCode",
    "jobVersion",
    "jobDefinitionHash",
    "completionTransitionCode",
    "completionMode",
    "slotKey",
    "bundleCode"
  )
  WHERE mapping."sourceTransitionCode" = p_transition_code
  ORDER BY mapping."slotKey";
$$;

CREATE FUNCTION "validate_ai_workflow_job_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_row "AiWorkflowTransition"%ROWTYPE;
  command_row "AiWorkflowCommand"%ROWTYPE;
  instance_row "AiWorkflowInstance"%ROWTYPE;
  expected RECORD;
  expected_bundle_key TEXT;
  expected_dedupe_key TEXT;
  top_level_key_count INTEGER;
  workflow_key_count INTEGER;
  source_transition_key_count INTEGER;
  job_key_count INTEGER;
BEGIN
  IF NEW."status" <> 'PLANNED'
    OR NEW."blockedAt" IS NOT NULL
    OR NEW."blockedReasonCode" IS NOT NULL
  THEN
    RAISE EXCEPTION 'AiWorkflowJob must be inserted as PLANNED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "AiOrchestratorSetting"
    WHERE "id" = 'global'
      AND "stateMachineEnabled" = true
      AND "dispatchEnabled" = false
      AND "syntheticDataOnly" = true
      AND "provider" = 'mock'
  ) OR NOT EXISTS (
    SELECT 1 FROM "AiControlSetting"
    WHERE "id" = 'global' AND "externalProvidersEnabled" = false
  ) THEN
    RAISE EXCEPTION 'Persistent Job Queue Foundation is not in a safe state';
  END IF;

  SELECT * INTO transition_row
  FROM "AiWorkflowTransition"
  WHERE "id" = NEW."sourceTransitionId";
  IF NOT FOUND
    OR transition_row."workflowInstanceId" IS DISTINCT FROM NEW."workflowInstanceId"
    OR transition_row."transitionCode" IS DISTINCT FROM NEW."sourceTransitionCode"
    OR transition_row."sequence" IS DISTINCT FROM NEW."sourceTransitionSequence"
    OR transition_row."correlationId" IS DISTINCT FROM NEW."correlationId"
  THEN
    RAISE EXCEPTION 'AiWorkflowJob source transition binding is invalid';
  END IF;

  SELECT * INTO command_row
  FROM "AiWorkflowCommand"
  WHERE "id" = transition_row."commandId"
    AND "workflowInstanceId" = NEW."workflowInstanceId";
  SELECT * INTO instance_row
  FROM "AiWorkflowInstance"
  WHERE "id" = NEW."workflowInstanceId";
  IF command_row."id" IS NULL OR instance_row."id" IS NULL THEN
    RAISE EXCEPTION 'AiWorkflowJob source command or workflow is missing';
  END IF;

  SELECT * INTO expected
  FROM "expected_ai_workflow_jobs"(transition_row."transitionCode") AS expected_jobs
  WHERE expected_jobs."jobCode" = NEW."jobCode"
    AND expected_jobs."slotKey" = NEW."slotKey";
  IF NOT FOUND
    OR expected."jobVersion" IS DISTINCT FROM NEW."jobVersion"
    OR expected."jobDefinitionHash" IS DISTINCT FROM NEW."jobDefinitionHash"
    OR expected."completionTransitionCode" IS DISTINCT FROM NEW."completionTransitionCode"
    OR expected."completionMode" IS DISTINCT FROM NEW."completionMode"
    OR expected."bundleCode" IS DISTINCT FROM NEW."bundleCode"
  THEN
    RAISE EXCEPTION 'AiWorkflowJob does not match the canonical catalog mapping';
  END IF;

  IF transition_row."metadata" -> 'jobPlanning' ->> 'catalogKey'
      IS DISTINCT FROM 'FAI-AUDIT-JOB-CATALOG@1.0'
    OR transition_row."metadata" -> 'jobPlanning' ->> 'catalogHash'
      IS DISTINCT FROM 'eca7f4174ab8a188ef21df6758ab6cfd081dd51a126f47097f6a3706ec7bbb9e'
    OR transition_row."metadata" -> 'jobPlanning' -> 'automaticDispatchAllowed'
      IS DISTINCT FROM 'false'::JSONB
  THEN
    RAISE EXCEPTION 'AiWorkflowJob transition planning metadata is invalid';
  END IF;

  expected_bundle_key := ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(
    JSONB_BUILD_OBJECT(
      'schemaVersion', 1,
      'catalogKey', 'FAI-AUDIT-JOB-CATALOG@1.0',
      'catalogHash', 'eca7f4174ab8a188ef21df6758ab6cfd081dd51a126f47097f6a3706ec7bbb9e',
      'workflowInstanceId', NEW."workflowInstanceId",
      'sourceCommandIdempotencyKey', command_row."idempotencyKey",
      'sourceTransitionCode', NEW."sourceTransitionCode",
      'sourceTransitionSequence', NEW."sourceTransitionSequence",
      'correctionCycle', instance_row."correctionCycle",
      'bundleCode', NEW."bundleCode"
    )
  ), 'UTF8')), 'hex');
  expected_dedupe_key := ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(
    JSONB_BUILD_OBJECT(
      'schemaVersion', 1,
      'catalogKey', 'FAI-AUDIT-JOB-CATALOG@1.0',
      'catalogHash', 'eca7f4174ab8a188ef21df6758ab6cfd081dd51a126f47097f6a3706ec7bbb9e',
      'workflowInstanceId', NEW."workflowInstanceId",
      'sourceCommandIdempotencyKey', command_row."idempotencyKey",
      'sourceTransitionCode', NEW."sourceTransitionCode",
      'sourceTransitionSequence', NEW."sourceTransitionSequence",
      'correctionCycle', instance_row."correctionCycle",
      'jobKey', NEW."jobCode" || '@' || NEW."jobVersion",
      'slotKey', NEW."slotKey"
    )
  ), 'UTF8')), 'hex');
  IF NEW."bundleKey" IS DISTINCT FROM expected_bundle_key
    OR NEW."dedupeKey" IS DISTINCT FROM expected_dedupe_key
  THEN
    RAISE EXCEPTION 'AiWorkflowJob canonical dedupe identity is invalid';
  END IF;

  SELECT COUNT(*) INTO top_level_key_count FROM JSONB_OBJECT_KEYS(NEW."payload");
  SELECT COUNT(*) INTO workflow_key_count FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'workflow');
  SELECT COUNT(*) INTO source_transition_key_count
  FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'sourceTransition');
  SELECT COUNT(*) INTO job_key_count FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'job');
  IF top_level_key_count IS DISTINCT FROM 6
    OR workflow_key_count IS DISTINCT FROM 4
    OR source_transition_key_count IS DISTINCT FROM 7
    OR job_key_count IS DISTINCT FROM 10
    OR NEW."payload" ->> 'schemaVersion' IS DISTINCT FROM '1'
    OR NEW."payload" ->> 'catalogKey' IS DISTINCT FROM 'FAI-AUDIT-JOB-CATALOG@1.0'
    OR NEW."payload" ->> 'catalogHash' IS DISTINCT FROM NEW."catalogHash"
    OR NEW."payload" -> 'workflow' ->> 'workflowInstanceId' IS DISTINCT FROM NEW."workflowInstanceId"
    OR NEW."payload" -> 'workflow' ->> 'workflowCode' IS DISTINCT FROM instance_row."workflowCode"
    OR NEW."payload" -> 'workflow' ->> 'workflowVersion' IS DISTINCT FROM instance_row."workflowVersion"
    OR NEW."payload" -> 'workflow' ->> 'dataMode' IS DISTINCT FROM 'synthetic'
    OR NEW."payload" -> 'sourceTransition' ->> 'transitionCode' IS DISTINCT FROM NEW."sourceTransitionCode"
    OR (NEW."payload" -> 'sourceTransition' ->> 'sequence')::INTEGER
      IS DISTINCT FROM NEW."sourceTransitionSequence"
    OR NEW."payload" -> 'sourceTransition' ->> 'idempotencyKey'
      IS DISTINCT FROM command_row."idempotencyKey"
    OR NEW."payload" -> 'sourceTransition' ->> 'correlationId' IS DISTINCT FROM NEW."correlationId"
    OR NEW."payload" -> 'sourceTransition' ->> 'fromState' IS DISTINCT FROM transition_row."fromState"
    OR NEW."payload" -> 'sourceTransition' ->> 'toState' IS DISTINCT FROM transition_row."toState"
    OR (NEW."payload" -> 'sourceTransition' ->> 'correctionCycle')::INTEGER
      IS DISTINCT FROM instance_row."correctionCycle"
    OR NEW."payload" -> 'job' ->> 'jobCode' IS DISTINCT FROM NEW."jobCode"
    OR NEW."payload" -> 'job' ->> 'jobVersion' IS DISTINCT FROM NEW."jobVersion"
    OR NEW."payload" -> 'job' ->> 'jobDefinitionHash' IS DISTINCT FROM NEW."jobDefinitionHash"
    OR NEW."payload" -> 'job' ->> 'completionTransitionCode'
      IS DISTINCT FROM NEW."completionTransitionCode"
    OR NEW."payload" -> 'job' ->> 'completionMode' IS DISTINCT FROM NEW."completionMode"
    OR NEW."payload" -> 'job' ->> 'slotKey' IS DISTINCT FROM NEW."slotKey"
    OR NEW."payload" -> 'job' ->> 'bundleCode' IS DISTINCT FROM NEW."bundleCode"
    OR NEW."payload" -> 'job' ->> 'bundleKey' IS DISTINCT FROM NEW."bundleKey"
    OR NEW."payload" -> 'job' ->> 'provider' IS DISTINCT FROM 'mock'
    OR NEW."payload" -> 'job' -> 'automaticDispatchAllowed' IS DISTINCT FROM 'false'::JSONB
    OR NEW."payloadHash" IS DISTINCT FROM ENCODE(SHA256(CONVERT_TO(
      "canonicalize_ai_workflow_jsonb"(NEW."payload"), 'UTF8'
    )), 'hex')
  THEN
    RAISE EXCEPTION 'AiWorkflowJob payload or persisted payload hash is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJob_validate_insert"
BEFORE INSERT ON "AiWorkflowJob"
FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_insert"();

CREATE FUNCTION "validate_ai_workflow_job_outbox_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  job_row "AiWorkflowJob"%ROWTYPE;
  expected_event_key TEXT;
  top_level_key_count INTEGER;
  job_key_count INTEGER;
BEGIN
  SELECT * INTO job_row FROM "AiWorkflowJob" WHERE "id" = NEW."jobId";
  IF NOT FOUND
    OR job_row."workflowInstanceId" IS DISTINCT FROM NEW."workflowInstanceId"
    OR job_row."sourceTransitionId" IS DISTINCT FROM NEW."sourceTransitionId"
    OR job_row."status" IS DISTINCT FROM 'PLANNED'
  THEN
    RAISE EXCEPTION 'AiWorkflowJobOutboxEvent job binding is invalid';
  END IF;

  expected_event_key := ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(
    JSONB_BUILD_OBJECT(
      'schemaVersion', 1,
      'eventType', 'AI_JOB_PLANNED',
      'eventVersion', 1,
      'jobDedupeKey', job_row."dedupeKey"
    )
  ), 'UTF8')), 'hex');
  SELECT COUNT(*) INTO top_level_key_count FROM JSONB_OBJECT_KEYS(NEW."payload");
  SELECT COUNT(*) INTO job_key_count FROM JSONB_OBJECT_KEYS(NEW."payload" -> 'job');
  IF top_level_key_count IS DISTINCT FROM 9
    OR job_key_count IS DISTINCT FROM 10
    OR NEW."eventKey" IS DISTINCT FROM expected_event_key
    OR NEW."payload" ->> 'schemaVersion' IS DISTINCT FROM '1'
    OR NEW."payload" ->> 'eventType' IS DISTINCT FROM 'AI_JOB_PLANNED'
    OR NEW."payload" ->> 'eventVersion' IS DISTINCT FROM '1'
    OR NEW."payload" ->> 'workflowInstanceId' IS DISTINCT FROM NEW."workflowInstanceId"
    OR NEW."payload" ->> 'sourceTransitionId' IS DISTINCT FROM NEW."sourceTransitionId"
    OR NEW."payload" ->> 'sourceTransitionCode' IS DISTINCT FROM job_row."sourceTransitionCode"
    OR (NEW."payload" ->> 'sourceTransitionSequence')::INTEGER
      IS DISTINCT FROM job_row."sourceTransitionSequence"
    OR NEW."payload" -> 'job' ->> 'id' IS DISTINCT FROM NEW."jobId"
    OR NEW."payload" -> 'job' ->> 'jobCode' IS DISTINCT FROM job_row."jobCode"
    OR NEW."payload" -> 'job' ->> 'jobVersion' IS DISTINCT FROM job_row."jobVersion"
    OR NEW."payload" -> 'job' ->> 'dedupeKey' IS DISTINCT FROM job_row."dedupeKey"
    OR NEW."payload" -> 'job' ->> 'bundleKey' IS DISTINCT FROM job_row."bundleKey"
    OR NEW."payload" -> 'job' ->> 'status' IS DISTINCT FROM 'PLANNED'
    OR NEW."payload" -> 'job' ->> 'provider' IS DISTINCT FROM 'mock'
    OR NEW."payload" -> 'job' ->> 'dataMode' IS DISTINCT FROM 'synthetic'
    OR NEW."payload" -> 'job' -> 'automaticDispatchAllowed' IS DISTINCT FROM 'false'::JSONB
    OR NEW."payload" -> 'job' ->> 'payloadHash' IS DISTINCT FROM job_row."payloadHash"
    OR ((NEW."payload" ->> 'occurredAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
      IS DISTINCT FROM NEW."occurredAt"
    OR NEW."payloadHash" IS DISTINCT FROM ENCODE(SHA256(CONVERT_TO(
      "canonicalize_ai_workflow_jsonb"(NEW."payload"), 'UTF8'
    )), 'hex')
  THEN
    RAISE EXCEPTION 'AiWorkflowJobOutboxEvent canonical identity or payload is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJobOutboxEvent_validate_insert"
BEFORE INSERT ON "AiWorkflowJobOutboxEvent"
FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_outbox_insert"();

CREATE FUNCTION "verify_ai_workflow_transition_job_plan"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_count INTEGER;
  actual_job_count INTEGER;
  actual_outbox_count INTEGER;
  expected_plan_hash TEXT;
  command_row "AiWorkflowCommand"%ROWTYPE;
  instance_row "AiWorkflowInstance"%ROWTYPE;
BEGIN
  SELECT COUNT(*) INTO expected_count
  FROM "expected_ai_workflow_jobs"(NEW."transitionCode");
  IF JSONB_TYPEOF(NEW."metadata" -> 'jobPlanning') IS DISTINCT FROM 'object'
    OR NEW."metadata" -> 'jobPlanning' ->> 'schemaVersion' IS DISTINCT FROM '1'
    OR NEW."metadata" -> 'jobPlanning' ->> 'catalogKey'
      IS DISTINCT FROM 'FAI-AUDIT-JOB-CATALOG@1.0'
    OR NEW."metadata" -> 'jobPlanning' ->> 'catalogHash'
      IS DISTINCT FROM 'eca7f4174ab8a188ef21df6758ab6cfd081dd51a126f47097f6a3706ec7bbb9e'
    OR NEW."metadata" -> 'jobPlanning' ->> 'planHash' IS NULL
    OR NEW."metadata" -> 'jobPlanning' ->> 'planHash' !~ '^[0-9a-f]{64}$'
    OR JSONB_TYPEOF(NEW."metadata" -> 'jobPlanning' -> 'plannedJobCount') IS DISTINCT FROM 'number'
    OR (NEW."metadata" -> 'jobPlanning' ->> 'plannedJobCount')::INTEGER IS DISTINCT FROM expected_count
    OR NEW."metadata" -> 'jobPlanning' -> 'automaticDispatchAllowed' IS DISTINCT FROM 'false'::JSONB
  THEN
    RAISE EXCEPTION 'AiWorkflowTransition job planning metadata is incomplete or invalid';
  END IF;

  SELECT COUNT(*) INTO actual_job_count
  FROM "AiWorkflowJob"
  WHERE "sourceTransitionId" = NEW."id"
    AND "workflowInstanceId" = NEW."workflowInstanceId";
  SELECT COUNT(*) INTO actual_outbox_count
  FROM "AiWorkflowJobOutboxEvent"
  WHERE "sourceTransitionId" = NEW."id"
    AND "workflowInstanceId" = NEW."workflowInstanceId"
    AND "eventType" = 'AI_JOB_PLANNED'
    AND "deliveryState" = 'PENDING';
  IF actual_job_count <> expected_count OR actual_outbox_count <> expected_count THEN
    RAISE EXCEPTION 'AiWorkflowTransition does not own the exact transactional job plan and outbox';
  END IF;

  SELECT * INTO command_row FROM "AiWorkflowCommand" WHERE "id" = NEW."commandId";
  SELECT * INTO instance_row FROM "AiWorkflowInstance" WHERE "id" = NEW."workflowInstanceId";
  IF command_row."id" IS NULL OR instance_row."id" IS NULL THEN
    RAISE EXCEPTION 'AiWorkflowTransition job plan identity cannot be resolved';
  END IF;
  SELECT ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(
    JSONB_BUILD_OBJECT(
      'schemaVersion', 1,
      'catalogKey', 'FAI-AUDIT-JOB-CATALOG@1.0',
      'catalogHash', 'eca7f4174ab8a188ef21df6758ab6cfd081dd51a126f47097f6a3706ec7bbb9e',
      'workflowInstanceId', NEW."workflowInstanceId",
      'sourceCommandIdempotencyKey', command_row."idempotencyKey",
      'sourceTransitionCode', NEW."transitionCode",
      'sourceTransitionSequence', NEW."sequence",
      'correctionCycle', instance_row."correctionCycle",
      'jobs', COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
        'jobCode', queue_job."jobCode",
        'jobVersion', queue_job."jobVersion",
        'jobDefinitionHash', queue_job."jobDefinitionHash",
        'slotKey', queue_job."slotKey",
        'bundleKey', queue_job."bundleKey",
        'dedupeKey', queue_job."dedupeKey",
        'payloadHash', queue_job."payloadHash"
      ) ORDER BY queue_job."slotKey"), '[]'::JSONB)
    )
  ), 'UTF8')), 'hex') INTO expected_plan_hash
  FROM "AiWorkflowJob" AS queue_job
  WHERE queue_job."sourceTransitionId" = NEW."id"
    AND queue_job."workflowInstanceId" = NEW."workflowInstanceId";
  IF NEW."metadata" -> 'jobPlanning' ->> 'planHash' IS DISTINCT FROM expected_plan_hash THEN
    RAISE EXCEPTION 'AiWorkflowTransition canonical job plan hash is invalid';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiWorkflowTransition_requires_job_plan"
AFTER INSERT ON "AiWorkflowTransition"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_transition_job_plan"();

CREATE FUNCTION "verify_ai_workflow_job_outbox"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AiWorkflowJobOutboxEvent"
    WHERE "jobId" = NEW."id"
      AND "workflowInstanceId" = NEW."workflowInstanceId"
      AND "sourceTransitionId" = NEW."sourceTransitionId"
      AND "eventType" = 'AI_JOB_PLANNED'
      AND "deliveryState" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'AiWorkflowJob has no matching transactional outbox event';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiWorkflowJob_requires_outbox"
AFTER INSERT ON "AiWorkflowJob"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_job_outbox"();

CREATE FUNCTION "protect_ai_workflow_job_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."workflowInstanceId" IS DISTINCT FROM NEW."workflowInstanceId"
    OR OLD."sourceTransitionId" IS DISTINCT FROM NEW."sourceTransitionId"
    OR OLD."sourceTransitionCode" IS DISTINCT FROM NEW."sourceTransitionCode"
    OR OLD."sourceTransitionSequence" IS DISTINCT FROM NEW."sourceTransitionSequence"
    OR OLD."catalogCode" IS DISTINCT FROM NEW."catalogCode"
    OR OLD."catalogVersion" IS DISTINCT FROM NEW."catalogVersion"
    OR OLD."catalogHash" IS DISTINCT FROM NEW."catalogHash"
    OR OLD."jobCode" IS DISTINCT FROM NEW."jobCode"
    OR OLD."jobVersion" IS DISTINCT FROM NEW."jobVersion"
    OR OLD."jobDefinitionHash" IS DISTINCT FROM NEW."jobDefinitionHash"
    OR OLD."completionTransitionCode" IS DISTINCT FROM NEW."completionTransitionCode"
    OR OLD."completionMode" IS DISTINCT FROM NEW."completionMode"
    OR OLD."slotKey" IS DISTINCT FROM NEW."slotKey"
    OR OLD."bundleCode" IS DISTINCT FROM NEW."bundleCode"
    OR OLD."bundleKey" IS DISTINCT FROM NEW."bundleKey"
    OR OLD."dedupeKey" IS DISTINCT FROM NEW."dedupeKey"
    OR OLD."provider" IS DISTINCT FROM NEW."provider"
    OR OLD."dataMode" IS DISTINCT FROM NEW."dataMode"
    OR OLD."automaticDispatchAllowed" IS DISTINCT FROM NEW."automaticDispatchAllowed"
    OR OLD."payload" IS DISTINCT FROM NEW."payload"
    OR OLD."payloadHash" IS DISTINCT FROM NEW."payloadHash"
    OR OLD."correlationId" IS DISTINCT FROM NEW."correlationId"
    OR OLD."plannedAt" IS DISTINCT FROM NEW."plannedAt"
  THEN
    RAISE EXCEPTION 'AiWorkflowJob identity and payload are immutable';
  END IF;
  IF OLD."status" <> 'PLANNED'
    OR NEW."status" <> 'BLOCKED'
    OR NEW."blockedAt" IS NULL
    OR NEW."blockedReasonCode" !~ '^[A-Z][A-Z0-9_]{2,63}$'
  THEN
    RAISE EXCEPTION 'AiWorkflowJob only supports the one-way PLANNED to BLOCKED safety transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJob_block_only"
BEFORE UPDATE ON "AiWorkflowJob"
FOR EACH ROW EXECUTE FUNCTION "protect_ai_workflow_job_lifecycle"();

CREATE FUNCTION "reject_ai_workflow_queue_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and cannot be mutated', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "AiWorkflowJob_immutable_delete"
BEFORE DELETE ON "AiWorkflowJob"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_queue_mutation"();

CREATE TRIGGER "AiWorkflowJobOutboxEvent_immutable_update"
BEFORE UPDATE ON "AiWorkflowJobOutboxEvent"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_queue_mutation"();

CREATE TRIGGER "AiWorkflowJobOutboxEvent_immutable_delete"
BEFORE DELETE ON "AiWorkflowJobOutboxEvent"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_queue_mutation"();

COMMIT;
