-- AI Orchestrator State Machine Foundation v1.1.
--
-- This migration is strictly additive. It introduces a fail-closed singleton,
-- idempotent workflow creation and commands, and an immutable transition
-- ledger. It does not enqueue or execute work and it leaves every existing CRM
-- table and row unchanged.

BEGIN;

CREATE TABLE "AiOrchestratorSetting" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "stateMachineEnabled" BOOLEAN NOT NULL DEFAULT false,
  "dispatchEnabled" BOOLEAN NOT NULL DEFAULT false,
  "syntheticDataOnly" BOOLEAN NOT NULL DEFAULT true,
  "provider" TEXT NOT NULL DEFAULT 'mock',
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiOrchestratorSetting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiOrchestratorSetting_singleton_check"
    CHECK ("id" = 'global'),
  CONSTRAINT "AiOrchestratorSetting_dispatch_disabled_check"
    CHECK ("dispatchEnabled" = false),
  CONSTRAINT "AiOrchestratorSetting_synthetic_only_check"
    CHECK ("syntheticDataOnly" = true),
  CONSTRAINT "AiOrchestratorSetting_mock_provider_check"
    CHECK ("provider" = 'mock'),
  CONSTRAINT "AiOrchestratorSetting_version_check"
    CHECK ("version" >= 1)
);

CREATE INDEX "AiOrchestratorSetting_updatedById_idx"
  ON "AiOrchestratorSetting"("updatedById");

ALTER TABLE "AiOrchestratorSetting"
  ADD CONSTRAINT "AiOrchestratorSetting_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The row exists immediately after deployment, but both the state machine and
-- dispatch remain disabled. The database contract permits only synthetic data
-- and the mock provider; dispatch cannot be enabled by this foundation.
INSERT INTO "AiOrchestratorSetting" (
  "id",
  "stateMachineEnabled",
  "dispatchEnabled",
  "syntheticDataOnly",
  "provider",
  "version",
  "updatedAt"
) VALUES (
  'global',
  false,
  false,
  true,
  'mock',
  1,
  CURRENT_TIMESTAMP
);

CREATE TABLE "AiWorkflowInstance" (
  "id" TEXT NOT NULL,
  "creationKey" TEXT NOT NULL,
  "creationRequestHash" TEXT NOT NULL,
  "workflowCode" TEXT NOT NULL,
  "workflowVersion" TEXT NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "dataMode" TEXT NOT NULL DEFAULT 'synthetic',
  "clientId" TEXT,
  "companyId" TEXT,
  "projectId" TEXT,
  "clientServiceId" TEXT,
  "currentState" TEXT NOT NULL DEFAULT 'CREATED',
  "stateVersion" INTEGER NOT NULL DEFAULT 1,
  "correctionCycle" INTEGER NOT NULL DEFAULT 0,
  "lastTransitionAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiWorkflowInstance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowInstance_creationKey_format_check"
    CHECK (
      "creationKey" ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "AiWorkflowInstance_creationRequestHash_format_check"
    CHECK ("creationRequestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AiWorkflowInstance_definition_contract_check"
    CHECK (
      "workflowCode" = 'FAI-AUDIT-WORKFLOW'
      AND "workflowVersion" = '1.1'
      AND "definitionHash" = '6b31ebbe050314afe397ccf61b8fc6a2c1ca8620cb08cb9cdb37c42a62a5024c'
    ),
  CONSTRAINT "AiWorkflowInstance_data_mode_check"
    CHECK (
      "dataMode" = 'synthetic'
      AND "clientId" IS NULL
      AND "companyId" IS NULL
      AND "projectId" IS NULL
      AND "clientServiceId" IS NULL
    ),
  CONSTRAINT "AiWorkflowInstance_state_check"
    CHECK (
      "currentState" IN (
        'CREATED',
        'WAITING_FOR_PAYMENT',
        'WAITING_FOR_AUTHORITY',
        'NEEDS_DOCUMENTS',
        'DATA_VALIDATION',
        'READY_FOR_ANALYSIS',
        'AI_DRAFT',
        'INDEPENDENT_REVIEW',
        'NEEDS_CORRECTION',
        'NEEDS_CLARIFICATION',
        'HUMAN_APPROVAL',
        'APPROVED',
        'RELEASED',
        'SUPERSEDED',
        'CLOSED',
        'DELETION_PENDING'
      )
    ),
  CONSTRAINT "AiWorkflowInstance_state_version_check"
    CHECK ("stateVersion" >= 1),
  CONSTRAINT "AiWorkflowInstance_correction_cycle_check"
    CHECK ("correctionCycle" BETWEEN 0 AND 2),
  CONSTRAINT "AiWorkflowInstance_initial_state_check"
    CHECK (
      (
        "stateVersion" = 1
        AND "currentState" = 'CREATED'
        AND "correctionCycle" = 0
        AND "lastTransitionAt" IS NULL
      )
      OR (
        "stateVersion" > 1
        AND "currentState" <> 'CREATED'
        AND "lastTransitionAt" IS NOT NULL
        AND "lastTransitionAt" >= "createdAt"
      )
    )
);

CREATE UNIQUE INDEX "AiWorkflowInstance_creationKey_key"
  ON "AiWorkflowInstance"("creationKey");
CREATE INDEX "AiWorkflowInstance_workflowCode_workflowVersion_idx"
  ON "AiWorkflowInstance"("workflowCode", "workflowVersion");
CREATE INDEX "AiWorkflowInstance_currentState_updatedAt_idx"
  ON "AiWorkflowInstance"("currentState", "updatedAt");
CREATE INDEX "AiWorkflowInstance_clientId_idx"
  ON "AiWorkflowInstance"("clientId");
CREATE INDEX "AiWorkflowInstance_companyId_idx"
  ON "AiWorkflowInstance"("companyId");
CREATE INDEX "AiWorkflowInstance_projectId_idx"
  ON "AiWorkflowInstance"("projectId");
CREATE INDEX "AiWorkflowInstance_clientServiceId_idx"
  ON "AiWorkflowInstance"("clientServiceId");
CREATE INDEX "AiWorkflowInstance_createdById_idx"
  ON "AiWorkflowInstance"("createdById");

ALTER TABLE "AiWorkflowInstance"
  ADD CONSTRAINT "AiWorkflowInstance_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiWorkflowInstance_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiWorkflowInstance_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiWorkflowInstance_clientServiceId_fkey"
  FOREIGN KEY ("clientServiceId") REFERENCES "ClientService"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiWorkflowInstance_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "AiWorkflowCommand" (
  "id" TEXT NOT NULL,
  "workflowInstanceId" TEXT NOT NULL,
  "transitionCode" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "expectedState" TEXT NOT NULL,
  "expectedStateVersion" INTEGER NOT NULL,
  "actorKind" TEXT NOT NULL,
  "requestedByUserId" TEXT,
  "requestedByAgentId" TEXT,
  "requestedByAgentConfigVersion" INTEGER,
  "requestedBySystemCode" TEXT,
  "correlationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "resultState" TEXT,
  "resultStateVersion" INTEGER,
  "rejectionCode" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiWorkflowCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowCommand_transition_contract_check"
    CHECK (
      ("transitionCode", "eventType", "expectedState") IN (
        ('WF-001', 'CASE_STARTED', 'CREATED'),
        ('WF-002', 'PAYMENT_VERIFIED', 'WAITING_FOR_PAYMENT'),
        ('WF-003', 'AUTHORITY_VERIFIED', 'WAITING_FOR_AUTHORITY'),
        ('WF-004', 'CHECKLIST_RESOLVED', 'NEEDS_DOCUMENTS'),
        ('WF-005', 'DOCUMENT_INGESTED', 'DATA_VALIDATION'),
        ('WF-006', 'DOCUMENT_CLASSIFIED', 'DATA_VALIDATION'),
        ('WF-007', 'EVIDENCE_EXTRACTED', 'DATA_VALIDATION'),
        ('WF-008', 'BLOCKING_CONFLICT_DETECTED', 'DATA_VALIDATION'),
        ('WF-009', 'CLARIFICATION_RESOLVED', 'NEEDS_CLARIFICATION'),
        ('WF-010', 'DATASET_READY', 'DATA_VALIDATION'),
        ('WF-011', 'ANALYSIS_BUNDLE_COMPLETED', 'READY_FOR_ANALYSIS'),
        ('WF-012', 'FINDINGS_DRAFTED', 'AI_DRAFT'),
        ('WF-013', 'REPORT_DRAFTED', 'AI_DRAFT'),
        ('WF-014', 'REVIEW_BUNDLE_COMPLETED', 'INDEPENDENT_REVIEW'),
        ('WF-015', 'CORRECTION_OPENED', 'INDEPENDENT_REVIEW'),
        ('WF-016', 'CORRECTION_COMPLETED', 'NEEDS_CORRECTION'),
        ('WF-017', 'REVIEW_GATE_PASSED', 'INDEPENDENT_REVIEW'),
        ('WF-018', 'REPORT_APPROVED', 'HUMAN_APPROVAL'),
        ('WF-019', 'APPROVAL_CHANGES_REQUESTED', 'HUMAN_APPROVAL'),
        ('WF-020', 'DELIVERABLE_RELEASED', 'APPROVED'),
        ('WF-021', 'VERSION_SUPERSEDED', 'APPROVED'),
        ('WF-022', 'CASE_CLOSED', 'RELEASED'),
        ('WF-023', 'DELETION_REQUESTED', 'CLOSED')
      )
    ),
  CONSTRAINT "AiWorkflowCommand_idempotency_key_format_check"
    CHECK (
      "idempotencyKey" ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "AiWorkflowCommand_hashes_format_check"
    CHECK (
      "requestHash" ~ '^[0-9a-f]{64}$'
      AND "definitionHash" = '6b31ebbe050314afe397ccf61b8fc6a2c1ca8620cb08cb9cdb37c42a62a5024c'
    ),
  CONSTRAINT "AiWorkflowCommand_expected_version_check"
    CHECK ("expectedStateVersion" >= 1),
  CONSTRAINT "AiWorkflowCommand_actor_check"
    CHECK (
      (
        "actorKind" = 'HUMAN'
        AND "requestedByUserId" IS NOT NULL
        AND "requestedByAgentId" IS NULL
        AND "requestedByAgentConfigVersion" IS NULL
        AND "requestedBySystemCode" IS NULL
      )
      OR (
        "actorKind" = 'AGENT'
        AND "requestedByUserId" IS NULL
        AND "requestedByAgentId" IS NOT NULL
        AND "requestedByAgentConfigVersion" IS NOT NULL
        AND "requestedByAgentConfigVersion" >= 1
        AND "requestedBySystemCode" IS NULL
      )
      OR (
        "actorKind" = 'SYSTEM'
        AND "requestedByUserId" IS NULL
        AND "requestedByAgentId" IS NULL
        AND "requestedByAgentConfigVersion" IS NULL
        AND "requestedBySystemCode" IS NOT NULL
        AND "requestedBySystemCode" = 'AI_ORCHESTRATOR'
      )
    ),
  CONSTRAINT "AiWorkflowCommand_actor_transition_check"
    CHECK (
      (
        "actorKind" = 'HUMAN'
        AND "transitionCode" IN (
          'WF-001', 'WF-002', 'WF-003', 'WF-004', 'WF-009', 'WF-010',
          'WF-017', 'WF-018', 'WF-019', 'WF-020', 'WF-021', 'WF-022', 'WF-023'
        )
      )
      OR (
        "actorKind" = 'AGENT'
        AND "transitionCode" IN ('WF-005', 'WF-006', 'WF-007', 'WF-012', 'WF-013', 'WF-016')
      )
      OR (
        "actorKind" = 'SYSTEM'
        AND "transitionCode" IN ('WF-008', 'WF-011', 'WF-014', 'WF-015')
      )
    ),
  CONSTRAINT "AiWorkflowCommand_correlation_id_format_check"
    CHECK (
      "correlationId" ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "AiWorkflowCommand_status_check"
    CHECK ("status" IN ('PENDING', 'APPLIED', 'REJECTED')),
  CONSTRAINT "AiWorkflowCommand_result_state_check"
    CHECK (
      "resultState" IS NULL
      OR "resultState" IN (
        'CREATED',
        'WAITING_FOR_PAYMENT',
        'WAITING_FOR_AUTHORITY',
        'NEEDS_DOCUMENTS',
        'DATA_VALIDATION',
        'READY_FOR_ANALYSIS',
        'AI_DRAFT',
        'INDEPENDENT_REVIEW',
        'NEEDS_CORRECTION',
        'NEEDS_CLARIFICATION',
        'HUMAN_APPROVAL',
        'APPROVED',
        'RELEASED',
        'SUPERSEDED',
        'CLOSED',
        'DELETION_PENDING'
      )
    ),
  CONSTRAINT "AiWorkflowCommand_result_contract_check"
    CHECK (
      (
        "status" = 'PENDING'
        AND "resultState" IS NULL
        AND "resultStateVersion" IS NULL
        AND "rejectionCode" IS NULL
        AND "resolvedAt" IS NULL
      )
      OR (
        "status" = 'APPLIED'
        AND "resultState" IS NOT NULL
        AND "resultStateVersion" IS NOT NULL
        AND "resultStateVersion" = "expectedStateVersion" + 1
        AND "rejectionCode" IS NULL
        AND "resolvedAt" IS NOT NULL
        AND "resolvedAt" >= "createdAt"
      )
      OR (
        "status" = 'REJECTED'
        AND "resultState" IS NULL
        AND "resultStateVersion" IS NULL
        AND "rejectionCode" IS NOT NULL
        AND "rejectionCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'
        AND "resolvedAt" IS NOT NULL
        AND "resolvedAt" >= "createdAt"
      )
    ),
  CONSTRAINT "AiWorkflowCommand_rejection_code_allowlist_check"
    CHECK (
      "status" <> 'REJECTED'
      OR "rejectionCode" IN (
        'WORKFLOW_ID_MISMATCH',
        'WORKFLOW_VERSION_MISMATCH',
        'DEFINITION_HASH_MISMATCH',
        'UNKNOWN_STATE',
        'UNKNOWN_TRANSITION',
        'STATE_MISMATCH',
        'ACTOR_REQUIRED',
        'UNKNOWN_ACTOR_KIND',
        'ACTOR_NOT_ALLOWED',
        'ACTOR_CONTEXT_INVALID',
        'WORKER_STOP_REQUIRED',
        'PERMISSION_NOT_GRANTED',
        'GATE_NOT_PASSED',
        'PRECONDITION_NOT_MET',
        'EXTERNAL_PROVIDER_STATUS_UNKNOWN',
        'EXTERNAL_PROVIDERS_ENABLED',
        'MOCK_PROVIDER_REQUIRED',
        'CORRECTION_CYCLE_INVALID',
        'CORRECTION_LIMIT_REACHED',
        'REASON_CODE_REQUIRED',
        'MANUAL_RELEASE_REQUIRED',
        'INVALID_INPUT',
        'ACTOR_NOT_FOUND',
        'ACTOR_POLICY_DENIED',
        'PERMISSION_DENIED',
        'ORCHESTRATOR_DISABLED',
        'EXTERNAL_PROVIDERS_MUST_BE_DISABLED',
        'SYNTHETIC_CONTEXT_REQUIRED',
        'WORKFLOW_NOT_FOUND',
        'DEFINITION_MISMATCH',
        'IDEMPOTENCY_CONFLICT',
        'COMMAND_IN_PROGRESS',
        'STATE_VERSION_MISMATCH',
        'LEDGER_INTEGRITY_ERROR',
        'APPROVER_SEPARATION_FAILED',
        'RELEASE_DUAL_CONTROL_FAILED',
        'FOUNDATION_SCOPE_LIMIT',
        'MILESTONE_NOT_COMPLETED',
        'MILESTONE_OUT_OF_ORDER',
        'MILESTONE_DUPLICATE'
      )
    ),
  CONSTRAINT "AiWorkflowCommand_applied_transition_check"
    CHECK (
      "status" <> 'APPLIED'
      OR ("transitionCode", "resultState") IN (
        ('WF-001', 'WAITING_FOR_PAYMENT'),
        ('WF-002', 'WAITING_FOR_AUTHORITY'),
        ('WF-003', 'NEEDS_DOCUMENTS'),
        ('WF-004', 'DATA_VALIDATION'),
        ('WF-005', 'DATA_VALIDATION'),
        ('WF-006', 'DATA_VALIDATION'),
        ('WF-007', 'DATA_VALIDATION'),
        ('WF-008', 'NEEDS_CLARIFICATION'),
        ('WF-009', 'DATA_VALIDATION'),
        ('WF-010', 'READY_FOR_ANALYSIS'),
        ('WF-011', 'AI_DRAFT'),
        ('WF-012', 'AI_DRAFT'),
        ('WF-013', 'INDEPENDENT_REVIEW'),
        ('WF-014', 'INDEPENDENT_REVIEW'),
        ('WF-015', 'NEEDS_CORRECTION'),
        ('WF-016', 'INDEPENDENT_REVIEW'),
        ('WF-017', 'HUMAN_APPROVAL')
      )
    )
);

CREATE UNIQUE INDEX "AiWorkflowCommand_workflowInstanceId_idempotencyKey_key"
  ON "AiWorkflowCommand"("workflowInstanceId", "idempotencyKey");
CREATE UNIQUE INDEX "AiWorkflowCommand_id_workflowInstanceId_key"
  ON "AiWorkflowCommand"("id", "workflowInstanceId");
CREATE INDEX "AiWorkflowCommand_workflowInstanceId_status_createdAt_idx"
  ON "AiWorkflowCommand"("workflowInstanceId", "status", "createdAt");
CREATE INDEX "AiWorkflowCommand_requestedByUserId_idx"
  ON "AiWorkflowCommand"("requestedByUserId");
CREATE INDEX "AiWorkflowCommand_agentConfig_idx"
  ON "AiWorkflowCommand"("requestedByAgentId", "requestedByAgentConfigVersion");
CREATE INDEX "AiWorkflowCommand_correlationId_idx"
  ON "AiWorkflowCommand"("correlationId");

ALTER TABLE "AiWorkflowCommand"
  ADD CONSTRAINT "AiWorkflowCommand_workflowInstanceId_fkey"
  FOREIGN KEY ("workflowInstanceId") REFERENCES "AiWorkflowInstance"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiWorkflowCommand_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiWorkflowCommand_requestedByAgentConfig_fkey"
  FOREIGN KEY ("requestedByAgentId", "requestedByAgentConfigVersion")
  REFERENCES "AiAgentConfigVersion"("agentId", "version")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Canonical JSON used to verify the guard snapshot hash at the database
-- boundary. Object keys use C ordering, matching the ASCII keys emitted by the
-- application canonicalizer; array order and scalar JSON representations are
-- preserved. Foundation snapshots accept only integer numeric fields.
CREATE FUNCTION "canonicalize_ai_workflow_jsonb"(input_json JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  canonical TEXT;
BEGIN
  CASE JSONB_TYPEOF(input_json)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        STRING_AGG(
          TO_JSONB(object_key)::TEXT || ':' || "canonicalize_ai_workflow_jsonb"(object_value),
          ',' ORDER BY object_key COLLATE "C"
        ),
        ''
      ) || '}'
      INTO canonical
      FROM JSONB_EACH(input_json) AS object_entry(object_key, object_value);
      RETURN canonical;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(
        STRING_AGG(
          "canonicalize_ai_workflow_jsonb"(array_value),
          ',' ORDER BY array_position
        ),
        ''
      ) || ']'
      INTO canonical
      FROM JSONB_ARRAY_ELEMENTS(input_json) WITH ORDINALITY
        AS array_entry(array_value, array_position);
      RETURN canonical;
    ELSE
      RETURN input_json::TEXT;
  END CASE;
END;
$$;

CREATE FUNCTION "count_ai_workflow_jsonb_keys"(input_json JSONB)
RETURNS INTEGER
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT COUNT(*)::INTEGER FROM JSONB_OBJECT_KEYS(input_json);
$$;

-- Enforce the complete minimized decision shape. Exact object key counts make
-- unexpected payloads (including client data, prompts, outputs and secrets)
-- invalid rather than silently retained in the immutable ledger.
CREATE FUNCTION "validate_ai_workflow_guard_snapshot"(
  snapshot JSONB,
  row_transition_code TEXT,
  row_actor_kind TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  actor_snapshot JSONB;
  permission_snapshot JSONB;
  setting_snapshot JSONB;
  provider_policy JSONB;
  foundation_policy JSONB;
  gate_snapshot JSONB;
  milestone_snapshot JSONB;
  separation_snapshot JSONB;
  array_key TEXT;
  expected_actor_kind TEXT;
  expected_permission TEXT;
  expected_gate TEXT;
  expected_precondition_codes JSONB;
  actual_precondition_codes JSONB;
  expected_milestone_phase TEXT;
  expected_milestone_canonical JSONB;
  expected_milestone_required JSONB;
  expected_separation JSONB;
BEGIN
  expected_actor_kind := CASE
    WHEN row_transition_code IN (
      'WF-001', 'WF-002', 'WF-003', 'WF-004', 'WF-009', 'WF-010', 'WF-017'
    ) THEN 'HUMAN'
    WHEN row_transition_code IN (
      'WF-005', 'WF-006', 'WF-007', 'WF-012', 'WF-013', 'WF-016'
    ) THEN 'AGENT'
    WHEN row_transition_code IN ('WF-008', 'WF-011', 'WF-014', 'WF-015') THEN 'SYSTEM'
    ELSE NULL
  END;
  expected_permission := CASE
    WHEN row_transition_code IN ('WF-001', 'WF-002', 'WF-003', 'WF-004', 'WF-009', 'WF-010') THEN 'ai.run'
    WHEN row_transition_code = 'WF-017' THEN 'ai.review'
    ELSE NULL
  END;
  expected_gate := CASE row_transition_code
    WHEN 'WF-001' THEN 'G0_ORDER'
    WHEN 'WF-002' THEN 'G0_PAYMENT'
    WHEN 'WF-003' THEN 'G1_AUTHORITY'
    WHEN 'WF-004' THEN 'G2_COMPLETENESS'
    WHEN 'WF-005' THEN 'G3_INGEST'
    WHEN 'WF-006' THEN 'G4_CLASSIFY'
    WHEN 'WF-007' THEN 'G4_EXTRACT'
    WHEN 'WF-008' THEN 'G5_DATA_CONFLICT'
    WHEN 'WF-009' THEN 'G5_CLARIFICATION'
    WHEN 'WF-010' THEN 'G5_DATA_QUALITY'
    WHEN 'WF-011' THEN 'G6_ANALYSIS_JOIN'
    WHEN 'WF-012' THEN 'G6_FINDINGS'
    WHEN 'WF-013' THEN 'G6_COMPOSE'
    WHEN 'WF-014' THEN 'G7_REVIEW_JOIN'
    WHEN 'WF-015' THEN 'G7_CORRECTION_REQUIRED'
    WHEN 'WF-016' THEN 'G7_CORRECT'
    WHEN 'WF-017' THEN 'G7_PASS'
    ELSE NULL
  END;
  expected_precondition_codes := CASE row_transition_code
    WHEN 'WF-001' THEN '["ORDER_ACTIVE", "CONTRACT_COHERENT"]'::JSONB
    WHEN 'WF-002' THEN '["PAYMENT_CONFIRMED"]'::JSONB
    WHEN 'WF-003' THEN '["AUTHORITY_VALID", "AI_USE_AUTHORIZED", "DATA_SCOPE_VALID"]'::JSONB
    WHEN 'WF-004' THEN '["CORE_DOCUMENTS_COMPLETE", "CONDITIONAL_DOCUMENTS_RESOLVED"]'::JSONB
    WHEN 'WF-005' THEN '["FILES_SAFE", "FILES_READABLE", "CHECKSUMS_RECORDED"]'::JSONB
    WHEN 'WF-006' THEN '["DOCUMENT_TYPES_CONFIRMED", "SUBJECTS_CONFIRMED", "PERIODS_CONFIRMED", "DATA_ZONES_CONFIRMED"]'::JSONB
    WHEN 'WF-007' THEN '["SOURCE_ANCHORS_PRESENT", "EXTRACTION_TYPED"]'::JSONB
    WHEN 'WF-008' THEN '["MATERIAL_CONFLICT_PRESENT"]'::JSONB
    WHEN 'WF-009' THEN '["CLARIFICATION_RESOLVED"]'::JSONB
    WHEN 'WF-010' THEN '["IDENTITY_RECONCILED", "PERIODS_RECONCILED", "UNITS_RECONCILED", "CORE_DATA_COMPLETE"]'::JSONB
    WHEN 'WF-011' THEN '["FINANCIAL_ANALYSIS_COMPLETE", "CREDIT_ANALYSIS_COMPLETE", "CALCULATIONS_COMPLETE"]'::JSONB
    WHEN 'WF-012' THEN '["CLAIMS_HAVE_EVIDENCE", "NO_SINGLE_SCORE"]'::JSONB
    WHEN 'WF-013' THEN '["REPORT_SECTIONS_COMPLETE", "LIMITATIONS_EXPLICIT", "DISCLAIMER_PRESENT"]'::JSONB
    WHEN 'WF-014' THEN '["SCHEMA_REVIEW_COMPLETE", "NUMERIC_REVIEW_COMPLETE", "SOURCE_REVIEW_COMPLETE", "RED_TEAM_REVIEW_COMPLETE"]'::JSONB
    WHEN 'WF-015' THEN '["OPEN_CRITICAL_OR_MAJOR_FINDINGS"]'::JSONB
    WHEN 'WF-016' THEN '["NEW_ARTIFACT_VERSION_CREATED", "FINDINGS_LINKED", "SOURCES_IMMUTABLE"]'::JSONB
    WHEN 'WF-017' THEN '["ZERO_OPEN_CRITICAL_MAJOR", "ALL_REVIEWS_PASS", "TARGET_VERSION_HASHED"]'::JSONB
    ELSE NULL
  END;
  expected_milestone_phase := CASE
    WHEN row_transition_code IN ('WF-005', 'WF-006', 'WF-007', 'WF-010') THEN 'DATA_VALIDATION'
    WHEN row_transition_code IN ('WF-012', 'WF-013') THEN 'AI_DRAFT'
    WHEN row_transition_code IN ('WF-014', 'WF-015', 'WF-017') THEN 'INDEPENDENT_REVIEW'
    ELSE NULL
  END;
  expected_milestone_canonical := CASE expected_milestone_phase
    WHEN 'DATA_VALIDATION' THEN '["WF-005", "WF-006", "WF-007"]'::JSONB
    WHEN 'AI_DRAFT' THEN '["WF-012"]'::JSONB
    WHEN 'INDEPENDENT_REVIEW' THEN '["WF-014"]'::JSONB
    ELSE '[]'::JSONB
  END;
  expected_milestone_required := CASE row_transition_code
    WHEN 'WF-006' THEN '["WF-005"]'::JSONB
    WHEN 'WF-007' THEN '["WF-005", "WF-006"]'::JSONB
    WHEN 'WF-010' THEN '["WF-005", "WF-006", "WF-007"]'::JSONB
    WHEN 'WF-013' THEN '["WF-012"]'::JSONB
    WHEN 'WF-015' THEN '["WF-014"]'::JSONB
    WHEN 'WF-017' THEN '["WF-014"]'::JSONB
    ELSE '[]'::JSONB
  END;
  expected_separation := CASE
    WHEN row_transition_code = 'WF-017' THEN '[
      {"code":"HUMAN_REVIEW_BOUNDARY","applied":true,"result":"PASSED"},
      {"code":"REVIEWER_APPROVER_SEPARATION","applied":false,"result":"NOT_APPLICABLE_FOUNDATION_SCOPE"},
      {"code":"APPROVER_RELEASE_SEPARATION","applied":false,"result":"NOT_APPLICABLE_FOUNDATION_SCOPE"}
    ]'::JSONB
    ELSE '[
      {"code":"HUMAN_REVIEW_BOUNDARY","applied":false,"result":"NOT_APPLICABLE"},
      {"code":"REVIEWER_APPROVER_SEPARATION","applied":false,"result":"NOT_APPLICABLE_FOUNDATION_SCOPE"},
      {"code":"APPROVER_RELEASE_SEPARATION","applied":false,"result":"NOT_APPLICABLE_FOUNDATION_SCOPE"}
    ]'::JSONB
  END;

  IF expected_gate IS NULL
    OR expected_actor_kind IS NULL
    OR expected_precondition_codes IS NULL
    OR row_actor_kind IS DISTINCT FROM expected_actor_kind
  THEN
    RETURN false;
  END IF;

  IF JSONB_TYPEOF(snapshot) IS DISTINCT FROM 'object'
    OR "count_ai_workflow_jsonb_keys"(snapshot) IS DISTINCT FROM 11
    OR (snapshot ?& ARRAY[
      'schemaVersion', 'actor', 'permission', 'correctionCycle',
      'orchestratorSetting', 'providerPolicy', 'foundationPolicy', 'gate',
      'preconditions', 'milestone', 'separationChecks'
    ]) IS DISTINCT FROM true
    OR JSONB_TYPEOF(snapshot -> 'schemaVersion') IS DISTINCT FROM 'number'
    OR snapshot ->> 'schemaVersion' IS DISTINCT FROM '1'
    OR JSONB_TYPEOF(snapshot -> 'correctionCycle') IS DISTINCT FROM 'number'
    OR (snapshot ->> 'correctionCycle' ~ '^[0-2]$') IS DISTINCT FROM true
  THEN
    RETURN false;
  END IF;

  actor_snapshot := snapshot -> 'actor';
  IF JSONB_TYPEOF(actor_snapshot) IS DISTINCT FROM 'object'
    OR "count_ai_workflow_jsonb_keys"(actor_snapshot) IS DISTINCT FROM 2
    OR (actor_snapshot ?& ARRAY['kind', 'humanRole']) IS DISTINCT FROM true
    OR actor_snapshot ->> 'kind' IS DISTINCT FROM row_actor_kind
  THEN
    RETURN false;
  END IF;
  IF row_actor_kind = 'HUMAN' THEN
    IF actor_snapshot ->> 'humanRole' IS NULL
      OR actor_snapshot ->> 'humanRole' NOT IN (
        'admin', 'direzione', 'commerciale', 'consulente', 'revisore',
        'backoffice', 'amministrazione', 'collaboratore_limitato'
      )
    THEN
      RETURN false;
    END IF;
  ELSIF actor_snapshot -> 'humanRole' IS DISTINCT FROM 'null'::JSONB THEN
    RETURN false;
  END IF;

  permission_snapshot := snapshot -> 'permission';
  IF JSONB_TYPEOF(permission_snapshot) IS DISTINCT FROM 'object'
    OR "count_ai_workflow_jsonb_keys"(permission_snapshot) IS DISTINCT FROM 3
    OR (permission_snapshot ?& ARRAY['required', 'granted', 'source']) IS DISTINCT FROM true
    OR permission_snapshot -> 'granted' IS DISTINCT FROM 'true'::JSONB
  THEN
    RETURN false;
  END IF;
  IF expected_permission IS NULL THEN
    IF permission_snapshot -> 'required' IS DISTINCT FROM 'null'::JSONB
      OR permission_snapshot ->> 'source' IS DISTINCT FROM 'NOT_REQUIRED'
    THEN
      RETURN false;
    END IF;
  ELSIF permission_snapshot ->> 'required' IS DISTINCT FROM expected_permission
    OR permission_snapshot ->> 'source' IS NULL
    OR permission_snapshot ->> 'source' NOT IN ('ADMIN', 'OVERRIDE', 'ROLE')
  THEN
    RETURN false;
  END IF;

  setting_snapshot := snapshot -> 'orchestratorSetting';
  IF JSONB_TYPEOF(setting_snapshot) IS DISTINCT FROM 'object'
    OR "count_ai_workflow_jsonb_keys"(setting_snapshot) IS DISTINCT FROM 7
    OR (setting_snapshot ?& ARRAY[
      'id', 'stateMachineEnabled', 'dispatchEnabled', 'provider',
      'syntheticDataOnly', 'version', 'updatedAt'
    ]) IS DISTINCT FROM true
    OR setting_snapshot ->> 'id' IS DISTINCT FROM 'global'
    OR setting_snapshot -> 'stateMachineEnabled' IS DISTINCT FROM 'true'::JSONB
    OR setting_snapshot -> 'dispatchEnabled' IS DISTINCT FROM 'false'::JSONB
    OR setting_snapshot ->> 'provider' IS DISTINCT FROM 'mock'
    OR setting_snapshot -> 'syntheticDataOnly' IS DISTINCT FROM 'true'::JSONB
    OR JSONB_TYPEOF(setting_snapshot -> 'version') IS DISTINCT FROM 'number'
    OR (setting_snapshot ->> 'version' ~ '^[1-9][0-9]*$') IS DISTINCT FROM true
    OR (setting_snapshot ->> 'version')::INTEGER < 1
    OR JSONB_TYPEOF(setting_snapshot -> 'updatedAt') IS DISTINCT FROM 'string'
    OR (
      setting_snapshot ->> 'updatedAt'
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    ) IS DISTINCT FROM true
  THEN
    RETURN false;
  END IF;

  provider_policy := snapshot -> 'providerPolicy';
  IF JSONB_TYPEOF(provider_policy) IS DISTINCT FROM 'object'
    OR "count_ai_workflow_jsonb_keys"(provider_policy) IS DISTINCT FROM 3
    OR (provider_policy ?& ARRAY[
      'databaseExternalProvidersEnabled',
      'environmentExternalProvidersEnabled',
      'effectiveExternalProvidersEnabled'
    ]) IS DISTINCT FROM true
    OR provider_policy -> 'databaseExternalProvidersEnabled' IS DISTINCT FROM 'false'::JSONB
    OR provider_policy -> 'environmentExternalProvidersEnabled' IS DISTINCT FROM 'false'::JSONB
    OR provider_policy -> 'effectiveExternalProvidersEnabled' IS DISTINCT FROM 'false'::JSONB
  THEN
    RETURN false;
  END IF;

  foundation_policy := snapshot -> 'foundationPolicy';
  IF JSONB_TYPEOF(foundation_policy) IS DISTINCT FROM 'object'
    OR "count_ai_workflow_jsonb_keys"(foundation_policy) IS DISTINCT FROM 2
    OR (foundation_policy ?& ARRAY['transitionInScope', 'automaticDispatchAllowed']) IS DISTINCT FROM true
    OR foundation_policy -> 'transitionInScope' IS DISTINCT FROM 'true'::JSONB
    OR foundation_policy -> 'automaticDispatchAllowed' IS DISTINCT FROM 'false'::JSONB
  THEN
    RETURN false;
  END IF;

  gate_snapshot := snapshot -> 'gate';
  IF JSONB_TYPEOF(gate_snapshot) IS DISTINCT FROM 'object'
    OR "count_ai_workflow_jsonb_keys"(gate_snapshot) IS DISTINCT FROM 3
    OR (gate_snapshot ?& ARRAY['code', 'result', 'passed']) IS DISTINCT FROM true
    OR gate_snapshot ->> 'code' IS DISTINCT FROM expected_gate
    OR gate_snapshot ->> 'result' IS DISTINCT FROM 'PASS'
    OR gate_snapshot -> 'passed' IS DISTINCT FROM 'true'::JSONB
  THEN
    RETURN false;
  END IF;

  IF JSONB_TYPEOF(snapshot -> 'preconditions') IS DISTINCT FROM 'array'
    OR JSONB_ARRAY_LENGTH(snapshot -> 'preconditions') IS DISTINCT FROM JSONB_ARRAY_LENGTH(expected_precondition_codes)
    OR EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(snapshot -> 'preconditions') AS precondition(item)
      WHERE JSONB_TYPEOF(item) IS DISTINCT FROM 'object'
        OR "count_ai_workflow_jsonb_keys"(item) IS DISTINCT FROM 3
        OR (item ?& ARRAY['code', 'result', 'passed']) IS DISTINCT FROM true
        OR JSONB_TYPEOF(item -> 'code') IS DISTINCT FROM 'string'
        OR item -> 'result' IS DISTINCT FROM 'true'::JSONB
        OR item -> 'passed' IS DISTINCT FROM 'true'::JSONB
    )
  THEN
    RETURN false;
  END IF;
  SELECT COALESCE(JSONB_AGG(item -> 'code' ORDER BY array_position), '[]'::JSONB)
    INTO actual_precondition_codes
  FROM JSONB_ARRAY_ELEMENTS(snapshot -> 'preconditions') WITH ORDINALITY
    AS precondition(item, array_position);
  IF actual_precondition_codes IS DISTINCT FROM expected_precondition_codes THEN
    RETURN false;
  END IF;

  milestone_snapshot := snapshot -> 'milestone';
  IF JSONB_TYPEOF(milestone_snapshot) IS DISTINCT FROM 'object'
    OR "count_ai_workflow_jsonb_keys"(milestone_snapshot) IS DISTINCT FROM 6
    OR (milestone_snapshot ?& ARRAY[
      'phase', 'phaseEntrySequence', 'canonicalTransitionCodes',
      'requiredTransitionCodes', 'completedTransitionCodes', 'decision'
    ]) IS DISTINCT FROM true
  THEN
    RETURN false;
  END IF;

  FOREACH array_key IN ARRAY ARRAY[
    'canonicalTransitionCodes', 'requiredTransitionCodes', 'completedTransitionCodes'
  ] LOOP
    IF JSONB_TYPEOF(milestone_snapshot -> array_key) IS DISTINCT FROM 'array'
      OR EXISTS (
        SELECT 1
        FROM JSONB_ARRAY_ELEMENTS(milestone_snapshot -> array_key) AS milestone_code(value)
        WHERE JSONB_TYPEOF(value) IS DISTINCT FROM 'string'
          OR (value #>> '{}' ~ '^WF-0(05|06|07|12|14)$') IS DISTINCT FROM true
      )
    THEN
      RETURN false;
    END IF;
  END LOOP;

  IF expected_milestone_phase IS NULL THEN
    IF milestone_snapshot ->> 'decision' IS DISTINCT FROM 'NOT_REQUIRED'
      OR milestone_snapshot -> 'phase' IS DISTINCT FROM 'null'::JSONB
      OR milestone_snapshot -> 'phaseEntrySequence' IS DISTINCT FROM 'null'::JSONB
      OR milestone_snapshot -> 'canonicalTransitionCodes' IS DISTINCT FROM '[]'::JSONB
      OR milestone_snapshot -> 'requiredTransitionCodes' IS DISTINCT FROM '[]'::JSONB
      OR milestone_snapshot -> 'completedTransitionCodes' IS DISTINCT FROM '[]'::JSONB
    THEN
      RETURN false;
    END IF;
  ELSE
    IF milestone_snapshot ->> 'decision' IS DISTINCT FROM 'SATISFIED'
      OR milestone_snapshot ->> 'phase' IS DISTINCT FROM expected_milestone_phase
      OR JSONB_TYPEOF(milestone_snapshot -> 'phaseEntrySequence') IS DISTINCT FROM 'number'
      OR (milestone_snapshot ->> 'phaseEntrySequence' ~ '^[1-9][0-9]*$') IS DISTINCT FROM true
      OR (milestone_snapshot ->> 'phaseEntrySequence')::INTEGER < 1
      OR milestone_snapshot -> 'canonicalTransitionCodes' IS DISTINCT FROM expected_milestone_canonical
      OR milestone_snapshot -> 'requiredTransitionCodes' IS DISTINCT FROM expected_milestone_required
      OR milestone_snapshot -> 'completedTransitionCodes' IS DISTINCT FROM expected_milestone_required
    THEN
      RETURN false;
    END IF;
  END IF;

  separation_snapshot := snapshot -> 'separationChecks';
  IF JSONB_TYPEOF(separation_snapshot) IS DISTINCT FROM 'array'
    OR separation_snapshot IS DISTINCT FROM expected_separation
  THEN
    RETURN false;
  END IF;

  RETURN true;
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$$;

CREATE TABLE "AiWorkflowTransition" (
  "id" TEXT NOT NULL,
  "workflowInstanceId" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "transitionCode" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "fromState" TEXT NOT NULL,
  "toState" TEXT NOT NULL,
  "fromVersion" INTEGER NOT NULL,
  "toVersion" INTEGER NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "guardSnapshot" JSONB NOT NULL,
  "guardSnapshotHash" TEXT NOT NULL,
  "previousTransitionHash" TEXT,
  "transitionHash" TEXT NOT NULL,
  "actorKind" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorAgentId" TEXT,
  "actorAgentConfigVersion" INTEGER,
  "actorSystemCode" TEXT,
  "reasonCode" TEXT,
  "correlationId" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiWorkflowTransition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowTransition_contract_check"
    CHECK (
      ("transitionCode", "eventType", "fromState", "toState") IN (
        ('WF-001', 'CASE_STARTED', 'CREATED', 'WAITING_FOR_PAYMENT'),
        ('WF-002', 'PAYMENT_VERIFIED', 'WAITING_FOR_PAYMENT', 'WAITING_FOR_AUTHORITY'),
        ('WF-003', 'AUTHORITY_VERIFIED', 'WAITING_FOR_AUTHORITY', 'NEEDS_DOCUMENTS'),
        ('WF-004', 'CHECKLIST_RESOLVED', 'NEEDS_DOCUMENTS', 'DATA_VALIDATION'),
        ('WF-005', 'DOCUMENT_INGESTED', 'DATA_VALIDATION', 'DATA_VALIDATION'),
        ('WF-006', 'DOCUMENT_CLASSIFIED', 'DATA_VALIDATION', 'DATA_VALIDATION'),
        ('WF-007', 'EVIDENCE_EXTRACTED', 'DATA_VALIDATION', 'DATA_VALIDATION'),
        ('WF-008', 'BLOCKING_CONFLICT_DETECTED', 'DATA_VALIDATION', 'NEEDS_CLARIFICATION'),
        ('WF-009', 'CLARIFICATION_RESOLVED', 'NEEDS_CLARIFICATION', 'DATA_VALIDATION'),
        ('WF-010', 'DATASET_READY', 'DATA_VALIDATION', 'READY_FOR_ANALYSIS'),
        ('WF-011', 'ANALYSIS_BUNDLE_COMPLETED', 'READY_FOR_ANALYSIS', 'AI_DRAFT'),
        ('WF-012', 'FINDINGS_DRAFTED', 'AI_DRAFT', 'AI_DRAFT'),
        ('WF-013', 'REPORT_DRAFTED', 'AI_DRAFT', 'INDEPENDENT_REVIEW'),
        ('WF-014', 'REVIEW_BUNDLE_COMPLETED', 'INDEPENDENT_REVIEW', 'INDEPENDENT_REVIEW'),
        ('WF-015', 'CORRECTION_OPENED', 'INDEPENDENT_REVIEW', 'NEEDS_CORRECTION'),
        ('WF-016', 'CORRECTION_COMPLETED', 'NEEDS_CORRECTION', 'INDEPENDENT_REVIEW'),
        ('WF-017', 'REVIEW_GATE_PASSED', 'INDEPENDENT_REVIEW', 'HUMAN_APPROVAL'),
        ('WF-018', 'REPORT_APPROVED', 'HUMAN_APPROVAL', 'APPROVED'),
        ('WF-019', 'APPROVAL_CHANGES_REQUESTED', 'HUMAN_APPROVAL', 'NEEDS_CORRECTION'),
        ('WF-020', 'DELIVERABLE_RELEASED', 'APPROVED', 'RELEASED'),
        ('WF-021', 'VERSION_SUPERSEDED', 'APPROVED', 'SUPERSEDED'),
        ('WF-022', 'CASE_CLOSED', 'RELEASED', 'CLOSED'),
        ('WF-023', 'DELETION_REQUESTED', 'CLOSED', 'DELETION_PENDING')
      )
    ),
  -- The canonical lifecycle remains defined above, while this foundation can
  -- persist only the vertical slice ending at HUMAN_APPROVAL.
  CONSTRAINT "AiWorkflowTransition_foundation_scope_check"
    CHECK (
      "transitionCode" IN (
        'WF-001', 'WF-002', 'WF-003', 'WF-004', 'WF-005', 'WF-006',
        'WF-007', 'WF-008', 'WF-009', 'WF-010', 'WF-011', 'WF-012',
        'WF-013', 'WF-014', 'WF-015', 'WF-016', 'WF-017'
      )
    ),
  CONSTRAINT "AiWorkflowTransition_version_sequence_check"
    CHECK (
      "sequence" >= 1
      AND "fromVersion" >= 1
      AND "toVersion" = "fromVersion" + 1
      AND "sequence" = "fromVersion"
    ),
  CONSTRAINT "AiWorkflowTransition_hashes_format_check"
    CHECK (
      "definitionHash" = '6b31ebbe050314afe397ccf61b8fc6a2c1ca8620cb08cb9cdb37c42a62a5024c'
      AND "guardSnapshotHash" ~ '^[0-9a-f]{64}$'
      AND (
        "previousTransitionHash" IS NULL
        OR "previousTransitionHash" ~ '^[0-9a-f]{64}$'
      )
      AND "transitionHash" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "AiWorkflowTransition_guard_snapshot_check"
    CHECK (
      (
        "validate_ai_workflow_guard_snapshot"(
          "guardSnapshot",
          "transitionCode",
          "actorKind"
        )
        AND ENCODE(
          SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"("guardSnapshot"), 'UTF8')),
          'hex'
        ) = "guardSnapshotHash"
      ) IS TRUE
    ),
  CONSTRAINT "AiWorkflowTransition_hash_chain_check"
    CHECK (
      ("sequence" = 1 AND "previousTransitionHash" IS NULL)
      OR (
        "sequence" > 1
        AND "previousTransitionHash" IS NOT NULL
        AND "previousTransitionHash" <> "transitionHash"
      )
    ),
  CONSTRAINT "AiWorkflowTransition_actor_check"
    CHECK (
      (
        "actorKind" = 'HUMAN'
        AND "actorUserId" IS NOT NULL
        AND "actorAgentId" IS NULL
        AND "actorAgentConfigVersion" IS NULL
        AND "actorSystemCode" IS NULL
      )
      OR (
        "actorKind" = 'AGENT'
        AND "actorUserId" IS NULL
        AND "actorAgentId" IS NOT NULL
        AND "actorAgentConfigVersion" IS NOT NULL
        AND "actorAgentConfigVersion" >= 1
        AND "actorSystemCode" IS NULL
      )
      OR (
        "actorKind" = 'SYSTEM'
        AND "actorUserId" IS NULL
        AND "actorAgentId" IS NULL
        AND "actorAgentConfigVersion" IS NULL
        AND "actorSystemCode" IS NOT NULL
        AND "actorSystemCode" = 'AI_ORCHESTRATOR'
      )
    ),
  CONSTRAINT "AiWorkflowTransition_actor_transition_check"
    CHECK (
      (
        "actorKind" = 'HUMAN'
        AND "transitionCode" IN (
          'WF-001', 'WF-002', 'WF-003', 'WF-004', 'WF-009', 'WF-010',
          'WF-017', 'WF-018', 'WF-019', 'WF-020', 'WF-021', 'WF-022', 'WF-023'
        )
      )
      OR (
        "actorKind" = 'AGENT'
        AND "transitionCode" IN ('WF-005', 'WF-006', 'WF-007', 'WF-012', 'WF-013', 'WF-016')
      )
      OR (
        "actorKind" = 'SYSTEM'
        AND "transitionCode" IN ('WF-008', 'WF-011', 'WF-014', 'WF-015')
      )
    ),
  CONSTRAINT "AiWorkflowTransition_reason_code_format_check"
    CHECK (
      "reasonCode" IS NULL
      OR "reasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    ),
  CONSTRAINT "AiWorkflowTransition_reason_code_required_check"
    CHECK (
      "transitionCode" NOT IN ('WF-015', 'WF-019', 'WF-021', 'WF-023')
      OR "reasonCode" IS NOT NULL
    ),
  CONSTRAINT "AiWorkflowTransition_correlation_id_format_check"
    CHECK (
      "correlationId" ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "AiWorkflowTransition_metadata_check"
    CHECK (
      (
        JSONB_TYPEOF("metadata") = 'object'
        AND "metadata" ? 'automaticDispatchAllowed'
        AND "metadata" -> 'automaticDispatchAllowed' = 'false'::JSONB
      ) IS TRUE
    )
);

CREATE UNIQUE INDEX "AiWorkflowTransition_commandId_key"
  ON "AiWorkflowTransition"("commandId");
CREATE UNIQUE INDEX "AiWorkflowTransition_commandId_workflowInstanceId_key"
  ON "AiWorkflowTransition"("commandId", "workflowInstanceId");
CREATE UNIQUE INDEX "AiWorkflowTransition_transitionHash_key"
  ON "AiWorkflowTransition"("transitionHash");
CREATE UNIQUE INDEX "AiWorkflowTransition_workflowInstanceId_sequence_key"
  ON "AiWorkflowTransition"("workflowInstanceId", "sequence");
CREATE UNIQUE INDEX "AiWorkflowTransition_workflowInstanceId_transitionHash_key"
  ON "AiWorkflowTransition"("workflowInstanceId", "transitionHash");
CREATE UNIQUE INDEX "AiWorkflowTransition_chain_successor_key"
  ON "AiWorkflowTransition"("workflowInstanceId", "previousTransitionHash")
  WHERE "previousTransitionHash" IS NOT NULL;
CREATE INDEX "AiWorkflowTransition_workflowInstanceId_createdAt_idx"
  ON "AiWorkflowTransition"("workflowInstanceId", "createdAt");
CREATE INDEX "AiWorkflowTransition_transitionCode_createdAt_idx"
  ON "AiWorkflowTransition"("transitionCode", "createdAt");
CREATE INDEX "AiWorkflowTransition_actorUserId_idx"
  ON "AiWorkflowTransition"("actorUserId");
CREATE INDEX "AiWorkflowTransition_agentConfig_idx"
  ON "AiWorkflowTransition"("actorAgentId", "actorAgentConfigVersion");
CREATE INDEX "AiWorkflowTransition_correlationId_idx"
  ON "AiWorkflowTransition"("correlationId");

ALTER TABLE "AiWorkflowTransition"
  ADD CONSTRAINT "AiWorkflowTransition_workflowInstanceId_fkey"
  FOREIGN KEY ("workflowInstanceId") REFERENCES "AiWorkflowInstance"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiWorkflowTransition_commandInstance_fkey"
  FOREIGN KEY ("commandId", "workflowInstanceId")
  REFERENCES "AiWorkflowCommand"("id", "workflowInstanceId")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiWorkflowTransition_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiWorkflowTransition_actorAgentConfig_fkey"
  FOREIGN KEY ("actorAgentId", "actorAgentConfigVersion")
  REFERENCES "AiAgentConfigVersion"("agentId", "version")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiWorkflowTransition_previousTransition_fkey"
  FOREIGN KEY ("workflowInstanceId", "previousTransitionHash")
  REFERENCES "AiWorkflowTransition"("workflowInstanceId", "transitionHash")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Instance identity and idempotency bindings are immutable. State fields may
-- change only when the deferred state/ledger verifier below can match the
-- update to an append-only transition in the same transaction.
CREATE FUNCTION "enforce_ai_workflow_instance_initial_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  orchestrator_setting "AiOrchestratorSetting"%ROWTYPE;
BEGIN
  SELECT * INTO orchestrator_setting
  FROM "AiOrchestratorSetting"
  WHERE "id" = 'global';

  IF NOT FOUND
    OR orchestrator_setting."stateMachineEnabled" IS DISTINCT FROM true
    OR orchestrator_setting."dispatchEnabled" IS DISTINCT FROM false
    OR orchestrator_setting."syntheticDataOnly" IS DISTINCT FROM true
    OR orchestrator_setting."provider" IS DISTINCT FROM 'mock'
  THEN
    RAISE EXCEPTION 'State Machine Foundation must be enabled while dispatch remains disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "AiControlSetting"
    WHERE "id" = 'global'
      AND "externalProvidersEnabled" = false
  ) THEN
    RAISE EXCEPTION 'External AI providers must be explicitly disabled';
  END IF;

  IF NEW."currentState" <> 'CREATED'
    OR NEW."stateVersion" <> 1
    OR NEW."correctionCycle" <> 0
    OR NEW."lastTransitionAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'AiWorkflowInstance must be inserted in its canonical initial state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowInstance_canonical_insert"
BEFORE INSERT ON "AiWorkflowInstance"
FOR EACH ROW EXECUTE FUNCTION "enforce_ai_workflow_instance_initial_insert"();

CREATE FUNCTION "protect_ai_workflow_instance_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."creationKey" IS DISTINCT FROM NEW."creationKey"
    OR OLD."creationRequestHash" IS DISTINCT FROM NEW."creationRequestHash"
    OR OLD."workflowCode" IS DISTINCT FROM NEW."workflowCode"
    OR OLD."workflowVersion" IS DISTINCT FROM NEW."workflowVersion"
    OR OLD."definitionHash" IS DISTINCT FROM NEW."definitionHash"
    OR OLD."dataMode" IS DISTINCT FROM NEW."dataMode"
    OR OLD."clientId" IS DISTINCT FROM NEW."clientId"
    OR OLD."companyId" IS DISTINCT FROM NEW."companyId"
    OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."clientServiceId" IS DISTINCT FROM NEW."clientServiceId"
    OR OLD."createdById" IS DISTINCT FROM NEW."createdById"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'AiWorkflowInstance identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowInstance_immutable_identity"
BEFORE UPDATE ON "AiWorkflowInstance"
FOR EACH ROW EXECUTE FUNCTION "protect_ai_workflow_instance_identity"();

-- A command is create-only while PENDING and may be resolved exactly once.
-- Its request/idempotency identity can never be rewritten after insertion.
CREATE FUNCTION "enforce_ai_workflow_command_pending_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" <> 'PENDING'
    OR NEW."resultState" IS NOT NULL
    OR NEW."resultStateVersion" IS NOT NULL
    OR NEW."rejectionCode" IS NOT NULL
    OR NEW."resolvedAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'AiWorkflowCommand must be inserted as unresolved PENDING';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowCommand_pending_insert"
BEFORE INSERT ON "AiWorkflowCommand"
FOR EACH ROW EXECUTE FUNCTION "enforce_ai_workflow_command_pending_insert"();

CREATE FUNCTION "protect_ai_workflow_command_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."workflowInstanceId" IS DISTINCT FROM NEW."workflowInstanceId"
    OR OLD."transitionCode" IS DISTINCT FROM NEW."transitionCode"
    OR OLD."eventType" IS DISTINCT FROM NEW."eventType"
    OR OLD."idempotencyKey" IS DISTINCT FROM NEW."idempotencyKey"
    OR OLD."requestHash" IS DISTINCT FROM NEW."requestHash"
    OR OLD."definitionHash" IS DISTINCT FROM NEW."definitionHash"
    OR OLD."expectedState" IS DISTINCT FROM NEW."expectedState"
    OR OLD."expectedStateVersion" IS DISTINCT FROM NEW."expectedStateVersion"
    OR OLD."actorKind" IS DISTINCT FROM NEW."actorKind"
    OR OLD."requestedByUserId" IS DISTINCT FROM NEW."requestedByUserId"
    OR OLD."requestedByAgentId" IS DISTINCT FROM NEW."requestedByAgentId"
    OR OLD."requestedByAgentConfigVersion" IS DISTINCT FROM NEW."requestedByAgentConfigVersion"
    OR OLD."requestedBySystemCode" IS DISTINCT FROM NEW."requestedBySystemCode"
    OR OLD."correlationId" IS DISTINCT FROM NEW."correlationId"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'AiWorkflowCommand identity is immutable';
  END IF;

  IF OLD."status" <> 'PENDING' OR NEW."status" NOT IN ('APPLIED', 'REJECTED') THEN
    RAISE EXCEPTION 'AiWorkflowCommand can be resolved from PENDING exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowCommand_resolve_once"
BEFORE UPDATE ON "AiWorkflowCommand"
FOR EACH ROW EXECUTE FUNCTION "protect_ai_workflow_command_lifecycle"();

CREATE FUNCTION "verify_ai_workflow_command_terminal_result"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ledger_row "AiWorkflowTransition"%ROWTYPE;
BEGIN
  IF NEW."status" = 'PENDING' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO ledger_row
  FROM "AiWorkflowTransition"
  WHERE "commandId" = NEW."id"
    AND "workflowInstanceId" = NEW."workflowInstanceId";

  IF NEW."status" = 'REJECTED' THEN
    IF FOUND THEN
      RAISE EXCEPTION 'Rejected AiWorkflowCommand cannot own a transition';
    END IF;
    RETURN NULL;
  END IF;

  IF NOT FOUND
    OR ledger_row."transitionCode" IS DISTINCT FROM NEW."transitionCode"
    OR ledger_row."eventType" IS DISTINCT FROM NEW."eventType"
    OR ledger_row."fromState" IS DISTINCT FROM NEW."expectedState"
    OR ledger_row."fromVersion" IS DISTINCT FROM NEW."expectedStateVersion"
    OR ledger_row."toState" IS DISTINCT FROM NEW."resultState"
    OR ledger_row."toVersion" IS DISTINCT FROM NEW."resultStateVersion"
  THEN
    RAISE EXCEPTION 'Applied AiWorkflowCommand has no matching transition';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiWorkflowCommand_terminal_requires_ledger"
AFTER INSERT OR UPDATE ON "AiWorkflowCommand"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_command_terminal_result"();

-- Validate the immediate predecessor, command binding and already-fenced
-- instance state before accepting a new ledger row.
CREATE FUNCTION "validate_ai_workflow_transition_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor "AiWorkflowTransition"%ROWTYPE;
  command_row "AiWorkflowCommand"%ROWTYPE;
  instance_row "AiWorkflowInstance"%ROWTYPE;
  phase_start_sequence INTEGER;
  phase_milestones TEXT[];
  expected_milestones TEXT[];
  orchestrator_setting "AiOrchestratorSetting"%ROWTYPE;
  actor_role TEXT;
  required_permission TEXT;
  permission_override_allowed BOOLEAN;
  permission_override_found BOOLEAN;
  expected_permission_source TEXT;
BEGIN
  SELECT * INTO orchestrator_setting
  FROM "AiOrchestratorSetting"
  WHERE "id" = 'global';

  IF NOT FOUND
    OR orchestrator_setting."stateMachineEnabled" IS DISTINCT FROM true
    OR orchestrator_setting."dispatchEnabled" IS DISTINCT FROM false
    OR orchestrator_setting."syntheticDataOnly" IS DISTINCT FROM true
    OR orchestrator_setting."provider" IS DISTINCT FROM 'mock'
    OR (NEW."guardSnapshot" -> 'orchestratorSetting' ->> 'version')::INTEGER
      IS DISTINCT FROM orchestrator_setting."version"
  THEN
    RAISE EXCEPTION 'State Machine Foundation must be enabled while dispatch remains disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "AiControlSetting"
    WHERE "id" = 'global'
      AND "externalProvidersEnabled" = false
  ) THEN
    RAISE EXCEPTION 'External AI providers must be explicitly disabled';
  END IF;

  SELECT * INTO command_row
  FROM "AiWorkflowCommand"
  WHERE "id" = NEW."commandId"
    AND "workflowInstanceId" = NEW."workflowInstanceId";

  IF NOT FOUND
    OR command_row."status" <> 'PENDING'
    OR command_row."transitionCode" IS DISTINCT FROM NEW."transitionCode"
    OR command_row."eventType" IS DISTINCT FROM NEW."eventType"
    OR command_row."definitionHash" IS DISTINCT FROM NEW."definitionHash"
    OR command_row."expectedState" IS DISTINCT FROM NEW."fromState"
    OR command_row."expectedStateVersion" IS DISTINCT FROM NEW."fromVersion"
    OR command_row."correlationId" IS DISTINCT FROM NEW."correlationId"
    OR command_row."actorKind" IS DISTINCT FROM NEW."actorKind"
    OR command_row."requestedByUserId" IS DISTINCT FROM NEW."actorUserId"
    OR command_row."requestedByAgentId" IS DISTINCT FROM NEW."actorAgentId"
    OR command_row."requestedByAgentConfigVersion" IS DISTINCT FROM NEW."actorAgentConfigVersion"
    OR command_row."requestedBySystemCode" IS DISTINCT FROM NEW."actorSystemCode"
  THEN
    RAISE EXCEPTION 'AiWorkflowTransition command binding is invalid';
  END IF;

  IF NEW."actorKind" = 'HUMAN' THEN
    SELECT "role"::TEXT INTO actor_role
    FROM "User"
    WHERE "id" = NEW."actorUserId"
      AND "active" = true
      AND "deletedAt" IS NULL;

    IF NOT FOUND
      OR NEW."guardSnapshot" -> 'actor' ->> 'humanRole' IS DISTINCT FROM actor_role
    THEN
      RAISE EXCEPTION 'AiWorkflowTransition human role snapshot is invalid';
    END IF;

    required_permission := NEW."guardSnapshot" -> 'permission' ->> 'required';
    permission_override_found := false;
    SELECT "allowed" INTO permission_override_allowed
    FROM "UserPermissionOverride"
    WHERE "userId" = NEW."actorUserId"
      AND "permission" = required_permission;
    permission_override_found := FOUND;

    IF actor_role = 'admin' THEN
      expected_permission_source := 'ADMIN';
    ELSIF permission_override_found THEN
      IF permission_override_allowed IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'AiWorkflowTransition permission override denies the transition';
      END IF;
      expected_permission_source := 'OVERRIDE';
    ELSE
      IF (required_permission = 'ai.run' AND actor_role NOT IN ('direzione', 'consulente'))
        OR (
          required_permission = 'ai.review'
          AND actor_role NOT IN ('direzione', 'consulente', 'revisore')
        )
      THEN
        RAISE EXCEPTION 'AiWorkflowTransition role does not grant the required permission';
      END IF;
      expected_permission_source := 'ROLE';
    END IF;

    IF NEW."guardSnapshot" -> 'permission' ->> 'source'
      IS DISTINCT FROM expected_permission_source
    THEN
      RAISE EXCEPTION 'AiWorkflowTransition permission source snapshot is invalid';
    END IF;
  END IF;

  SELECT * INTO instance_row
  FROM "AiWorkflowInstance"
  WHERE "id" = NEW."workflowInstanceId";

  IF NOT FOUND
    OR instance_row."definitionHash" IS DISTINCT FROM NEW."definitionHash"
    OR instance_row."currentState" IS DISTINCT FROM NEW."toState"
    OR instance_row."stateVersion" IS DISTINCT FROM NEW."toVersion"
    OR instance_row."lastTransitionAt" IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'AiWorkflowTransition instance fencing is invalid';
  END IF;

  IF (NEW."guardSnapshot" ->> 'correctionCycle')::INTEGER IS DISTINCT FROM (
    instance_row."correctionCycle"
    - CASE WHEN NEW."transitionCode" = 'WF-015' THEN 1 ELSE 0 END
  ) THEN
    RAISE EXCEPTION 'AiWorkflowTransition correction cycle snapshot is invalid';
  END IF;

  IF NEW."sequence" = 1 THEN
    IF NEW."previousTransitionHash" IS NOT NULL OR NEW."fromVersion" <> 1 THEN
      RAISE EXCEPTION 'First AiWorkflowTransition predecessor is invalid';
    END IF;
  ELSE
    SELECT * INTO predecessor
    FROM "AiWorkflowTransition"
    WHERE "workflowInstanceId" = NEW."workflowInstanceId"
      AND "transitionHash" = NEW."previousTransitionHash";

    IF NOT FOUND
      OR predecessor."sequence" <> NEW."sequence" - 1
      OR predecessor."toVersion" IS DISTINCT FROM NEW."fromVersion"
      OR predecessor."toState" IS DISTINCT FROM NEW."fromState"
      OR predecessor."definitionHash" IS DISTINCT FROM NEW."definitionHash"
    THEN
      RAISE EXCEPTION 'AiWorkflowTransition predecessor is not the immediate ledger entry';
    END IF;
  END IF;

  -- DATA_VALIDATION milestones are scoped to the latest entry into the phase.
  -- Returning from NEEDS_CLARIFICATION through WF-009 starts a fresh phase, so
  -- milestones from the earlier phase cannot be reused.
  IF NEW."transitionCode" IN ('WF-005', 'WF-006', 'WF-007', 'WF-010') THEN
    SELECT MAX("sequence") INTO phase_start_sequence
    FROM "AiWorkflowTransition"
    WHERE "workflowInstanceId" = NEW."workflowInstanceId"
      AND "transitionCode" IN ('WF-004', 'WF-009');

    IF phase_start_sequence IS NULL THEN
      RAISE EXCEPTION 'MILESTONE_NOT_COMPLETED: DATA_VALIDATION phase has no persisted entry milestone';
    END IF;
    IF (NEW."guardSnapshot" -> 'milestone' ->> 'phaseEntrySequence')::INTEGER
      IS DISTINCT FROM phase_start_sequence
    THEN
      RAISE EXCEPTION 'AiWorkflowTransition DATA_VALIDATION phase entry snapshot is invalid';
    END IF;

    SELECT COALESCE(
      ARRAY_AGG("transitionCode" ORDER BY "sequence"),
      ARRAY[]::TEXT[]
    ) INTO phase_milestones
    FROM "AiWorkflowTransition"
    WHERE "workflowInstanceId" = NEW."workflowInstanceId"
      AND "sequence" > phase_start_sequence
      AND "transitionCode" IN ('WF-005', 'WF-006', 'WF-007');

    IF NEW."transitionCode" IN ('WF-005', 'WF-006', 'WF-007')
      AND NEW."transitionCode" = ANY(phase_milestones)
    THEN
      RAISE EXCEPTION 'MILESTONE_DUPLICATE: % already completed in the current DATA_VALIDATION phase', NEW."transitionCode";
    END IF;

    expected_milestones := CASE NEW."transitionCode"
      WHEN 'WF-005' THEN ARRAY[]::TEXT[]
      WHEN 'WF-006' THEN ARRAY['WF-005']::TEXT[]
      WHEN 'WF-007' THEN ARRAY['WF-005', 'WF-006']::TEXT[]
      WHEN 'WF-010' THEN ARRAY['WF-005', 'WF-006', 'WF-007']::TEXT[]
    END;

    IF phase_milestones IS DISTINCT FROM expected_milestones THEN
      IF NEW."transitionCode" = 'WF-010'
        AND CARDINALITY(phase_milestones) < CARDINALITY(expected_milestones)
      THEN
        RAISE EXCEPTION 'MILESTONE_NOT_COMPLETED: % lacks ordered DATA_VALIDATION milestones', NEW."transitionCode";
      END IF;
      RAISE EXCEPTION 'MILESTONE_OUT_OF_ORDER: % has invalid DATA_VALIDATION milestone order', NEW."transitionCode";
    END IF;
  END IF;

  -- FINDINGS_DRAFTED may occur once after the current WF-011 entry into
  -- AI_DRAFT, and REPORT_DRAFTED cannot consume a milestone from another phase.
  IF NEW."transitionCode" IN ('WF-012', 'WF-013') THEN
    SELECT MAX("sequence") INTO phase_start_sequence
    FROM "AiWorkflowTransition"
    WHERE "workflowInstanceId" = NEW."workflowInstanceId"
      AND "transitionCode" = 'WF-011';

    IF phase_start_sequence IS NULL THEN
      RAISE EXCEPTION 'MILESTONE_NOT_COMPLETED: AI_DRAFT phase has no persisted entry milestone';
    END IF;
    IF (NEW."guardSnapshot" -> 'milestone' ->> 'phaseEntrySequence')::INTEGER
      IS DISTINCT FROM phase_start_sequence
    THEN
      RAISE EXCEPTION 'AiWorkflowTransition AI_DRAFT phase entry snapshot is invalid';
    END IF;

    SELECT COALESCE(
      ARRAY_AGG("transitionCode" ORDER BY "sequence"),
      ARRAY[]::TEXT[]
    ) INTO phase_milestones
    FROM "AiWorkflowTransition"
    WHERE "workflowInstanceId" = NEW."workflowInstanceId"
      AND "sequence" > phase_start_sequence
      AND "transitionCode" = 'WF-012';

    IF NEW."transitionCode" = 'WF-012' AND 'WF-012' = ANY(phase_milestones) THEN
      RAISE EXCEPTION 'MILESTONE_DUPLICATE: WF-012 already completed in the current AI_DRAFT phase';
    END IF;

    expected_milestones := CASE NEW."transitionCode"
      WHEN 'WF-012' THEN ARRAY[]::TEXT[]
      WHEN 'WF-013' THEN ARRAY['WF-012']::TEXT[]
    END;

    IF phase_milestones IS DISTINCT FROM expected_milestones THEN
      IF CARDINALITY(phase_milestones) < CARDINALITY(expected_milestones) THEN
        RAISE EXCEPTION 'MILESTONE_NOT_COMPLETED: % requires WF-012 in the current AI_DRAFT phase', NEW."transitionCode";
      END IF;
      RAISE EXCEPTION 'MILESTONE_OUT_OF_ORDER: % has invalid AI_DRAFT milestone order', NEW."transitionCode";
    END IF;
  END IF;

  -- Every independent-review cycle starts with WF-013 or WF-016 and owns one
  -- WF-014 milestone. Earlier review cycles cannot satisfy WF-015 or WF-017.
  IF NEW."transitionCode" IN ('WF-014', 'WF-015', 'WF-017') THEN
    SELECT MAX("sequence") INTO phase_start_sequence
    FROM "AiWorkflowTransition"
    WHERE "workflowInstanceId" = NEW."workflowInstanceId"
      AND "transitionCode" IN ('WF-013', 'WF-016');

    IF phase_start_sequence IS NULL THEN
      RAISE EXCEPTION 'MILESTONE_NOT_COMPLETED: review cycle has no persisted entry milestone';
    END IF;
    IF (NEW."guardSnapshot" -> 'milestone' ->> 'phaseEntrySequence')::INTEGER
      IS DISTINCT FROM phase_start_sequence
    THEN
      RAISE EXCEPTION 'AiWorkflowTransition review phase entry snapshot is invalid';
    END IF;

    SELECT COALESCE(
      ARRAY_AGG("transitionCode" ORDER BY "sequence"),
      ARRAY[]::TEXT[]
    ) INTO phase_milestones
    FROM "AiWorkflowTransition"
    WHERE "workflowInstanceId" = NEW."workflowInstanceId"
      AND "sequence" > phase_start_sequence
      AND "transitionCode" = 'WF-014';

    IF NEW."transitionCode" = 'WF-014' AND 'WF-014' = ANY(phase_milestones) THEN
      RAISE EXCEPTION 'MILESTONE_DUPLICATE: WF-014 already completed in the current review cycle';
    END IF;

    expected_milestones := CASE NEW."transitionCode"
      WHEN 'WF-014' THEN ARRAY[]::TEXT[]
      WHEN 'WF-015' THEN ARRAY['WF-014']::TEXT[]
      WHEN 'WF-017' THEN ARRAY['WF-014']::TEXT[]
    END;

    IF phase_milestones IS DISTINCT FROM expected_milestones THEN
      IF CARDINALITY(phase_milestones) < CARDINALITY(expected_milestones) THEN
        RAISE EXCEPTION 'MILESTONE_NOT_COMPLETED: % requires WF-014 in the current review cycle', NEW."transitionCode";
      END IF;
      RAISE EXCEPTION 'MILESTONE_OUT_OF_ORDER: % has invalid review-cycle milestone order', NEW."transitionCode";
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowTransition_validate_insert"
BEFORE INSERT ON "AiWorkflowTransition"
FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_transition_insert"();

-- Every state mutation must have exactly the matching append-only ledger row
-- by commit time. This catches direct state writes that bypass the service.
CREATE FUNCTION "verify_ai_workflow_state_ledger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ledger_row "AiWorkflowTransition"%ROWTYPE;
BEGIN
  IF NEW."stateVersion" <> OLD."stateVersion" + 1 THEN
    RAISE EXCEPTION 'AiWorkflowInstance stateVersion must advance exactly once';
  END IF;

  SELECT * INTO ledger_row
  FROM "AiWorkflowTransition"
  WHERE "workflowInstanceId" = NEW."id"
    AND "sequence" = OLD."stateVersion"
    AND "fromVersion" = OLD."stateVersion"
    AND "toVersion" = NEW."stateVersion";

  IF NOT FOUND
    OR ledger_row."fromState" IS DISTINCT FROM OLD."currentState"
    OR ledger_row."toState" IS DISTINCT FROM NEW."currentState"
    OR ledger_row."createdAt" IS DISTINCT FROM NEW."lastTransitionAt"
  THEN
    RAISE EXCEPTION 'AiWorkflowInstance state update has no matching ledger entry';
  END IF;

  IF ledger_row."transitionCode" IN ('WF-015', 'WF-019') THEN
    IF NEW."correctionCycle" <> OLD."correctionCycle" + 1 THEN
      RAISE EXCEPTION 'AiWorkflowInstance correction cycle increment is invalid';
    END IF;
  ELSIF NEW."correctionCycle" IS DISTINCT FROM OLD."correctionCycle" THEN
    RAISE EXCEPTION 'AiWorkflowInstance correction cycle changed outside a correction transition';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiWorkflowInstance_state_requires_ledger"
AFTER UPDATE ON "AiWorkflowInstance"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD."currentState" IS DISTINCT FROM NEW."currentState"
  OR OLD."stateVersion" IS DISTINCT FROM NEW."stateVersion"
  OR OLD."correctionCycle" IS DISTINCT FROM NEW."correctionCycle"
  OR OLD."lastTransitionAt" IS DISTINCT FROM NEW."lastTransitionAt"
)
EXECUTE FUNCTION "verify_ai_workflow_state_ledger"();

-- Transition creation happens while its command is PENDING; by commit the
-- command must be APPLIED with the exact persisted result.
CREATE FUNCTION "verify_ai_workflow_transition_command_result"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  command_row "AiWorkflowCommand"%ROWTYPE;
BEGIN
  SELECT * INTO command_row
  FROM "AiWorkflowCommand"
  WHERE "id" = NEW."commandId"
    AND "workflowInstanceId" = NEW."workflowInstanceId";

  IF NOT FOUND
    OR command_row."status" <> 'APPLIED'
    OR command_row."resultState" IS DISTINCT FROM NEW."toState"
    OR command_row."resultStateVersion" IS DISTINCT FROM NEW."toVersion"
    OR command_row."resolvedAt" IS NULL
  THEN
    RAISE EXCEPTION 'AiWorkflowTransition command was not applied consistently';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiWorkflowTransition_requires_applied_command"
AFTER INSERT ON "AiWorkflowTransition"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_transition_command_result"();

CREATE FUNCTION "reject_ai_workflow_foundation_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable and cannot be deleted', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "AiWorkflowInstance_immutable_delete"
BEFORE DELETE ON "AiWorkflowInstance"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_foundation_delete"();

CREATE TRIGGER "AiWorkflowCommand_immutable_delete"
BEFORE DELETE ON "AiWorkflowCommand"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_foundation_delete"();

-- Corrections create a new transition; existing transition history can never
-- be rewritten or deleted through normal DML, including cascading deletes.
CREATE FUNCTION "reject_ai_workflow_transition_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AiWorkflowTransition is immutable; append a new transition instead';
END;
$$;

CREATE TRIGGER "AiWorkflowTransition_immutable_update"
BEFORE UPDATE ON "AiWorkflowTransition"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_transition_mutation"();

CREATE TRIGGER "AiWorkflowTransition_immutable_delete"
BEFORE DELETE ON "AiWorkflowTransition"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_transition_mutation"();

COMMIT;
