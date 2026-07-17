-- AI Orchestrator State Machine Foundation v1.1.
--
-- This migration is strictly additive. It introduces a fail-closed singleton,
-- idempotent workflow creation and commands, and an immutable transition
-- ledger. It does not enqueue or execute work and it leaves every existing CRM
-- table and row unchanged.

BEGIN;

CREATE TABLE "AiOrchestratorSetting" (
  "id" TEXT NOT NULL DEFAULT 'global',
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

-- The row exists immediately after deployment, but dispatch remains disabled.
-- The database contract permits only synthetic data and the mock provider.
INSERT INTO "AiOrchestratorSetting" (
  "id",
  "dispatchEnabled",
  "syntheticDataOnly",
  "provider",
  "version",
  "updatedAt"
) VALUES (
  'global',
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
        'RELEASE_DUAL_CONTROL_FAILED'
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
        ('WF-017', 'HUMAN_APPROVAL'),
        ('WF-018', 'APPROVED'),
        ('WF-019', 'NEEDS_CORRECTION'),
        ('WF-020', 'RELEASED'),
        ('WF-021', 'SUPERSEDED'),
        ('WF-022', 'CLOSED'),
        ('WF-023', 'DELETION_PENDING')
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
  "metadata" JSONB,
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
      "metadata" IS NULL
      OR JSONB_TYPEOF("metadata") = 'object'
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
BEGIN
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
BEGIN
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
