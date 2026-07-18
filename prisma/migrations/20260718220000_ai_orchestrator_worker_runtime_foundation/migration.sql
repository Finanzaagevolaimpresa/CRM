-- AI Orchestrator Worker Runtime Foundation v1.
--
-- This migration adds a dormant, synthetic-only runtime contract around the
-- immutable PR75 job and outbox records. It creates no worker, performs no
-- backfill and enables no production setting.

BEGIN;

-- PR74 deliberately made dispatch physically impossible. The runtime
-- foundation keeps the default and deployed value false but permits an
-- explicitly audited future/test transition to true. Every runtime write has
-- additional independent gates below.
ALTER TABLE "AiOrchestratorSetting"
  DROP CONSTRAINT "AiOrchestratorSetting_dispatch_disabled_check";

CREATE TABLE "AiWorkflowJobRuntime" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "workflowInstanceId" TEXT NOT NULL,
  "runtimePolicyCode" TEXT NOT NULL,
  "runtimePolicyVersion" TEXT NOT NULL,
  "runtimePolicyHash" TEXT NOT NULL,
  "capabilityCode" TEXT NOT NULL,
  "capabilityVersion" TEXT NOT NULL,
  "capabilityHash" TEXT NOT NULL,
  "handlerCode" TEXT NOT NULL,
  "handlerVersion" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'AVAILABLE',
  "effectiveAvailableAt" TIMESTAMP(3) NOT NULL,
  "attemptSequence" INTEGER NOT NULL DEFAULT 0,
  "retryFailureCount" INTEGER NOT NULL DEFAULT 0,
  "fencingToken" BIGINT NOT NULL DEFAULT 0,
  "leaseOwnerId" TEXT,
  "leaseTokenHash" TEXT,
  "leaseClaimedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "leaseMaxExpiresAt" TIMESTAMP(3),
  "terminalAt" TIMESTAMP(3),
  "terminalReasonCode" TEXT,
  "resultHash" TEXT,
  "lastFailureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiWorkflowJobRuntime_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowJobRuntime_policy_check" CHECK (
    "runtimePolicyCode" = 'FAI-AUDIT-WORKER-RUNTIME-POLICY'
    AND "runtimePolicyVersion" = '1.0'
    AND "runtimePolicyHash" = '1d23eae02bdaa6eab422b600b95a50b690e6d7bed518669a811bcfc9ed8bcb4b'
    AND "capabilityVersion" = '1.0'
    AND "handlerVersion" = '1.0'
  ),
  CONSTRAINT "AiWorkflowJobRuntime_hashes_check" CHECK (
    "runtimePolicyHash" ~ '^[0-9a-f]{64}$'
    AND "capabilityHash" ~ '^[0-9a-f]{64}$'
    AND ("leaseTokenHash" IS NULL OR "leaseTokenHash" ~ '^[0-9a-f]{64}$')
    AND ("resultHash" IS NULL OR "resultHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "AiWorkflowJobRuntime_counters_check" CHECK (
    "attemptSequence" >= 0 AND "retryFailureCount" >= 0
    AND "retryFailureCount" <= 3
    AND "fencingToken" = "attemptSequence"::BIGINT
  ),
  CONSTRAINT "AiWorkflowJobRuntime_reason_check" CHECK (
    ("terminalReasonCode" IS NULL OR "terminalReasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$')
    AND ("lastFailureCode" IS NULL OR "lastFailureCode" ~ '^[A-Z][A-Z0-9_]{2,63}$')
  ),
  CONSTRAINT "AiWorkflowJobRuntime_state_check" CHECK (
    (
      "state" IN ('AVAILABLE', 'RETRY_WAIT')
      AND "leaseOwnerId" IS NULL AND "leaseTokenHash" IS NULL
      AND "leaseClaimedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseMaxExpiresAt" IS NULL
      AND "terminalAt" IS NULL AND "terminalReasonCode" IS NULL AND "resultHash" IS NULL
    ) OR (
      "state" = 'LEASED'
      AND "leaseOwnerId" IS NOT NULL AND LENGTH(BTRIM("leaseOwnerId")) BETWEEN 1 AND 200
      AND "leaseTokenHash" IS NOT NULL AND "leaseClaimedAt" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL AND "leaseMaxExpiresAt" IS NOT NULL
      AND "leaseClaimedAt" < "leaseExpiresAt" AND "leaseExpiresAt" <= "leaseMaxExpiresAt"
      AND "terminalAt" IS NULL AND "terminalReasonCode" IS NULL AND "resultHash" IS NULL
    ) OR (
      "state" = 'SUCCEEDED'
      AND "leaseOwnerId" IS NULL AND "leaseTokenHash" IS NULL
      AND "leaseClaimedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseMaxExpiresAt" IS NULL
      AND "terminalAt" IS NOT NULL AND "terminalReasonCode" = 'SUCCEEDED'
      AND "resultHash" IS NOT NULL AND "lastFailureCode" IS NULL
    ) OR (
      "state" IN ('FAILED_TERMINAL', 'SUPERSEDED')
      AND "leaseOwnerId" IS NULL AND "leaseTokenHash" IS NULL
      AND "leaseClaimedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseMaxExpiresAt" IS NULL
      AND "terminalAt" IS NOT NULL AND "terminalReasonCode" IS NOT NULL AND "resultHash" IS NULL
    )
  ),
  CONSTRAINT "AiWorkflowJobRuntime_timestamps_check" CHECK (
    "updatedAt" >= "createdAt"
    AND ("terminalAt" IS NULL OR "terminalAt" >= "createdAt")
  )
);

CREATE TABLE "AiWorkflowJobAttempt" (
  "id" TEXT NOT NULL,
  "runtimeId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "attemptSequence" INTEGER NOT NULL,
  "fencingToken" BIGINT NOT NULL,
  "workerInstanceId" TEXT NOT NULL,
  "workerBuildHash" TEXT NOT NULL,
  "leaseTokenHash" TEXT NOT NULL,
  "claimedAt" TIMESTAMP(3) NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "leaseMaxExpiresAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "outcome" TEXT,
  "failureCode" TEXT,
  "retryable" BOOLEAN,
  "retryBudgetConsumed" BOOLEAN,
  "nextAvailableAt" TIMESTAMP(3),
  "resultHash" TEXT,
  "runtimePolicyHash" TEXT NOT NULL,
  "capabilityHash" TEXT NOT NULL,
  "handlerCode" TEXT NOT NULL,
  "handlerVersion" TEXT NOT NULL,
  "workflowDefinitionHash" TEXT NOT NULL,
  "phaseCode" TEXT NOT NULL,
  "phaseEntrySequence" INTEGER NOT NULL,
  "correctionCycle" INTEGER NOT NULL,
  "executorAgentId" TEXT NOT NULL,
  "executorAgentConfigVersion" INTEGER NOT NULL,
  "executorAgentConfigHash" TEXT NOT NULL,
  "jobPayloadHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiWorkflowJobAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowJobAttempt_identity_check" CHECK (
    "attemptSequence" >= 1 AND "fencingToken" = "attemptSequence"::BIGINT
    AND LENGTH(BTRIM("workerInstanceId")) BETWEEN 1 AND 200
    AND "phaseEntrySequence" >= 1 AND "correctionCycle" >= 0
    AND "executorAgentConfigVersion" >= 1
    AND "handlerVersion" = '1.0'
  ),
  CONSTRAINT "AiWorkflowJobAttempt_hashes_check" CHECK (
    "workerBuildHash" ~ '^[0-9a-f]{64}$' AND "leaseTokenHash" ~ '^[0-9a-f]{64}$'
    AND "runtimePolicyHash" = '1d23eae02bdaa6eab422b600b95a50b690e6d7bed518669a811bcfc9ed8bcb4b'
    AND "capabilityHash" ~ '^[0-9a-f]{64}$'
    AND "workflowDefinitionHash" ~ '^[0-9a-f]{64}$'
    AND "executorAgentConfigHash" ~ '^[0-9a-f]{64}$'
    AND "jobPayloadHash" ~ '^[0-9a-f]{64}$'
    AND ("resultHash" IS NULL OR "resultHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "AiWorkflowJobAttempt_lease_check" CHECK (
    "claimedAt" < "leaseExpiresAt" AND "leaseExpiresAt" <= "leaseMaxExpiresAt"
  ),
  CONSTRAINT "AiWorkflowJobAttempt_outcome_check" CHECK (
    (
      "finishedAt" IS NULL AND "outcome" IS NULL AND "failureCode" IS NULL
      AND "retryable" IS NULL AND "retryBudgetConsumed" IS NULL
      AND "nextAvailableAt" IS NULL AND "resultHash" IS NULL
    ) OR (
      "finishedAt" IS NOT NULL AND "finishedAt" >= "claimedAt"
      AND "outcome" IN ('SUCCEEDED', 'RETRY_SCHEDULED', 'FAILED_TERMINAL', 'SURRENDERED', 'SUPERSEDED')
      AND "retryable" IS NOT NULL AND "retryBudgetConsumed" IS NOT NULL
      AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{2,63}$')
      AND ("outcome" <> 'SUCCEEDED' OR ("resultHash" IS NOT NULL AND "failureCode" IS NULL))
      AND ("outcome" = 'SUCCEEDED' OR "resultHash" IS NULL)
      AND ("outcome" <> 'RETRY_SCHEDULED' OR "nextAvailableAt" IS NOT NULL)
      AND ("outcome" = 'RETRY_SCHEDULED' OR "nextAvailableAt" IS NULL)
    )
  )
);

CREATE TABLE "AiWorkflowOutboxConsumption" (
  "id" TEXT NOT NULL,
  "outboxEventId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "runtimeId" TEXT NOT NULL,
  "consumerCode" TEXT NOT NULL,
  "consumerVersion" TEXT NOT NULL,
  "runtimePolicyHash" TEXT NOT NULL,
  "capabilityHash" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eventPayloadHash" TEXT NOT NULL,
  "jobDedupeKey" TEXT NOT NULL,
  "jobPayloadHash" TEXT NOT NULL,
  "workflowDefinitionHash" TEXT NOT NULL,
  "phaseCode" TEXT NOT NULL,
  "phaseEntrySequence" INTEGER NOT NULL,
  "correctionCycle" INTEGER NOT NULL,
  "executorAgentId" TEXT NOT NULL,
  "executorAgentConfigVersion" INTEGER NOT NULL,
  "executorAgentConfigHash" TEXT NOT NULL,
  "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiWorkflowOutboxConsumption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowOutboxConsumption_contract_check" CHECK (
    "consumerCode" = 'AI_ORCHESTRATOR_JOB_PLANNED_CONSUMER'
    AND "consumerVersion" = '1.0'
    AND "runtimePolicyHash" = '1d23eae02bdaa6eab422b600b95a50b690e6d7bed518669a811bcfc9ed8bcb4b'
    AND "phaseEntrySequence" >= 1 AND "correctionCycle" >= 0
    AND "executorAgentConfigVersion" >= 1
  ),
  CONSTRAINT "AiWorkflowOutboxConsumption_hashes_check" CHECK (
    "capabilityHash" ~ '^[0-9a-f]{64}$' AND "eventKey" ~ '^[0-9a-f]{64}$'
    AND "eventPayloadHash" ~ '^[0-9a-f]{64}$' AND "jobDedupeKey" ~ '^[0-9a-f]{64}$'
    AND "jobPayloadHash" ~ '^[0-9a-f]{64}$' AND "workflowDefinitionHash" ~ '^[0-9a-f]{64}$'
    AND "executorAgentConfigHash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "AiWorkflowJobRuntimeEvent" (
  "id" TEXT NOT NULL,
  "runtimeId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "workflowInstanceId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "attemptSequence" INTEGER,
  "fencingToken" BIGINT,
  "reasonCode" TEXT,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "previousEventHash" TEXT,
  "eventHash" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiWorkflowJobRuntimeEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowJobRuntimeEvent_contract_check" CHECK (
    "sequence" >= 1
    AND "eventType" IN (
      'ADMITTED', 'CLAIMED', 'RETRY_SCHEDULED', 'FAILED_TERMINAL',
      'SURRENDERED', 'SUCCEEDED', 'SUPERSEDED', 'LEASE_RECOVERED'
    )
    AND ("attemptSequence" IS NULL OR "attemptSequence" >= 1)
    AND ("fencingToken" IS NULL OR "fencingToken" >= 1)
    AND ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$')
    AND JSONB_TYPEOF("payload") = 'object'
  ),
  CONSTRAINT "AiWorkflowJobRuntimeEvent_hashes_check" CHECK (
    "payloadHash" ~ '^[0-9a-f]{64}$' AND "eventHash" ~ '^[0-9a-f]{64}$'
    AND ("previousEventHash" IS NULL OR "previousEventHash" ~ '^[0-9a-f]{64}$')
  )
);

CREATE UNIQUE INDEX "AiWorkflowJobRuntime_jobId_key" ON "AiWorkflowJobRuntime"("jobId");
CREATE INDEX "AiWorkflowJobRuntime_state_effectiveAvailableAt_idx"
  ON "AiWorkflowJobRuntime"("state", "effectiveAvailableAt");
CREATE INDEX "AiWorkflowJobRuntime_state_leaseExpiresAt_idx"
  ON "AiWorkflowJobRuntime"("state", "leaseExpiresAt");
CREATE INDEX "AiWorkflowJobRuntime_workflowInstanceId_state_effectiveAvailableAt_idx"
  ON "AiWorkflowJobRuntime"("workflowInstanceId", "state", "effectiveAvailableAt");

CREATE UNIQUE INDEX "AiWorkflowJobAttempt_runtimeId_attemptSequence_key"
  ON "AiWorkflowJobAttempt"("runtimeId", "attemptSequence");
CREATE UNIQUE INDEX "AiWorkflowJobAttempt_runtimeId_fencingToken_key"
  ON "AiWorkflowJobAttempt"("runtimeId", "fencingToken");
CREATE INDEX "AiWorkflowJobAttempt_jobId_attemptSequence_idx"
  ON "AiWorkflowJobAttempt"("jobId", "attemptSequence");
CREATE INDEX "AiWorkflowJobAttempt_outcome_finishedAt_idx"
  ON "AiWorkflowJobAttempt"("outcome", "finishedAt");
CREATE INDEX "AiWorkflowJobAttempt_leaseExpiresAt_idx" ON "AiWorkflowJobAttempt"("leaseExpiresAt");

CREATE UNIQUE INDEX "AiWorkflowOutboxConsumption_outboxEventId_key"
  ON "AiWorkflowOutboxConsumption"("outboxEventId");
CREATE UNIQUE INDEX "AiWorkflowOutboxConsumption_runtimeId_key"
  ON "AiWorkflowOutboxConsumption"("runtimeId");
CREATE UNIQUE INDEX "AiWorkflowOutboxConsumption_jobId_key"
  ON "AiWorkflowOutboxConsumption"("jobId");
CREATE INDEX "AiWorkflowOutboxConsumption_consumerCode_consumerVersion_consumedAt_idx"
  ON "AiWorkflowOutboxConsumption"("consumerCode", "consumerVersion", "consumedAt");
CREATE INDEX "AiWorkflowOutboxConsumption_consumedAt_idx"
  ON "AiWorkflowOutboxConsumption"("consumedAt");

CREATE UNIQUE INDEX "AiWorkflowJobRuntimeEvent_eventHash_key"
  ON "AiWorkflowJobRuntimeEvent"("eventHash");
CREATE UNIQUE INDEX "AiWorkflowJobRuntimeEvent_runtimeId_sequence_key"
  ON "AiWorkflowJobRuntimeEvent"("runtimeId", "sequence");
CREATE UNIQUE INDEX "AiWorkflowJobRuntimeEvent_runtimeId_eventHash_key"
  ON "AiWorkflowJobRuntimeEvent"("runtimeId", "eventHash");
CREATE INDEX "AiWorkflowJobRuntimeEvent_jobId_occurredAt_idx"
  ON "AiWorkflowJobRuntimeEvent"("jobId", "occurredAt");
CREATE INDEX "AiWorkflowJobRuntimeEvent_workflowInstanceId_occurredAt_idx"
  ON "AiWorkflowJobRuntimeEvent"("workflowInstanceId", "occurredAt");
CREATE INDEX "AiWorkflowJobRuntimeEvent_eventType_occurredAt_idx"
  ON "AiWorkflowJobRuntimeEvent"("eventType", "occurredAt");

ALTER TABLE "AiWorkflowJobRuntime" ADD CONSTRAINT "AiWorkflowJobRuntime_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "AiWorkflowJob"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobRuntime" ADD CONSTRAINT "AiWorkflowJobRuntime_workflowInstanceId_fkey"
  FOREIGN KEY ("workflowInstanceId") REFERENCES "AiWorkflowInstance"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobAttempt" ADD CONSTRAINT "AiWorkflowJobAttempt_runtimeId_fkey"
  FOREIGN KEY ("runtimeId") REFERENCES "AiWorkflowJobRuntime"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobAttempt" ADD CONSTRAINT "AiWorkflowJobAttempt_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "AiWorkflowJob"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowOutboxConsumption" ADD CONSTRAINT "AiWorkflowOutboxConsumption_outboxEventId_fkey"
  FOREIGN KEY ("outboxEventId") REFERENCES "AiWorkflowJobOutboxEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowOutboxConsumption" ADD CONSTRAINT "AiWorkflowOutboxConsumption_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "AiWorkflowJob"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowOutboxConsumption" ADD CONSTRAINT "AiWorkflowOutboxConsumption_runtimeId_fkey"
  FOREIGN KEY ("runtimeId") REFERENCES "AiWorkflowJobRuntime"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobRuntimeEvent" ADD CONSTRAINT "AiWorkflowJobRuntimeEvent_runtimeId_fkey"
  FOREIGN KEY ("runtimeId") REFERENCES "AiWorkflowJobRuntime"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobRuntimeEvent" ADD CONSTRAINT "AiWorkflowJobRuntimeEvent_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "AiWorkflowJob"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobRuntimeEvent" ADD CONSTRAINT "AiWorkflowJobRuntimeEvent_workflowInstanceId_fkey"
  FOREIGN KEY ("workflowInstanceId") REFERENCES "AiWorkflowInstance"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Versioned SQL mirror of the TypeScript runtime capability catalog.
CREATE FUNCTION "expected_ai_workflow_worker_capability"(p_job_code TEXT)
RETURNS TABLE (
  "capabilityCode" TEXT,
  "capabilityHash" TEXT,
  "handlerCode" TEXT,
  "jobDefinitionHash" TEXT,
  "executorAgentCode" TEXT,
  "executorAgentConfigVersion" INTEGER,
  "executorAgentConfigHash" TEXT
)
LANGUAGE sql IMMUTABLE AS $$
  SELECT mapping."capabilityCode", mapping."capabilityHash", mapping."handlerCode",
    mapping."jobDefinitionHash", mapping."executorAgentCode",
    mapping."executorAgentConfigVersion", mapping."executorAgentConfigHash"
  FROM (VALUES
    ('DOCUMENT_INGESTION',      'FAI_AUDIT_DOCUMENT_INGESTION_MOCK',      'c86fe9b75bab580425a4c64a2796bc36eb6dc0af5847a4d24d07dae5ceacea66', 'FAI_AUDIT_DOCUMENT_INGESTION_MOCK_HANDLER',      'c5139e8658ca552640247b18ae97b5331168777a69a52d6f533694d9b1fc3166', 'verifica_ai_preliminare_fai',      1, '99ae44b882e1cd1f52c04b8ec2ab5aa4ef2e54cb09ae0b2aecdd16587c0b4f67'),
    ('DOCUMENT_CLASSIFICATION', 'FAI_AUDIT_DOCUMENT_CLASSIFICATION_MOCK', 'f1d4a3201866752fd173575620da1270275671b9f562beaca864c0b8bcce8215', 'FAI_AUDIT_DOCUMENT_CLASSIFICATION_MOCK_HANDLER', 'd53bd449976ccba3c69b59d9c98d6cd1765594249e4576495d1f713fbd3984ec', 'verifica_ai_preliminare_fai',      1, '99ae44b882e1cd1f52c04b8ec2ab5aa4ef2e54cb09ae0b2aecdd16587c0b4f67'),
    ('EVIDENCE_EXTRACTION',     'FAI_AUDIT_EVIDENCE_EXTRACTION_MOCK',     '360c4f5048b14b5cb0f0357810e6c19da1cc158a6dafa5387629f9843194750f', 'FAI_AUDIT_EVIDENCE_EXTRACTION_MOCK_HANDLER',     '5c2d6e98c89204b585ab346b3ff514295502c124666d9f86f2af975bc1f8015e', 'pre_analisi_ai_ammissibilita_fai', 1, '3b5902fb767a64e7710d5bd71cc283102d0df3a4a6184d8786e6a5f06510ef5c'),
    ('FINANCIAL_ANALYSIS',      'FAI_AUDIT_FINANCIAL_ANALYSIS_MOCK',      '7cc24905832b8a810726b12719f02e337a19c2692873102b921cb8d6b9ed3289', 'FAI_AUDIT_FINANCIAL_ANALYSIS_MOCK_HANDLER',      '401f38a8b56f036257e983e9e7942c1fabbc90482d0bc00587704b12cdd3c87d', 'business_plan_fai',                1, '48baa1112ed62a6cba09f35dea87557adf43df7304feefb5693f9379a8340e3e'),
    ('CREDIT_ANALYSIS',         'FAI_AUDIT_CREDIT_ANALYSIS_MOCK',         'de27b0bfcefb4e24b4c832b1eb87824801633d7241758e53effd90b3dcd3ca9c', 'FAI_AUDIT_CREDIT_ANALYSIS_MOCK_HANDLER',         '0880d19f715b47030ca52e441fa697da336b60dc5f8476a0dbee573e5a592e18', 'audit_ai_bancabilita_fai',         1, 'e575e630bbd7daeb92e281619a374fff8afd064c18adb5d833af177fe7ebbb4c'),
    ('CALCULATIONS',            'FAI_AUDIT_CALCULATIONS_MOCK',            '7c08dadcd96b29b230c39f7f263caed4abd17bd8b88d9c81af0e62fcc512235c', 'FAI_AUDIT_CALCULATIONS_MOCK_HANDLER',            'ff1538c4129cc4b14aeed626d255f8910a565261741c1efbe645c668227bd378', 'business_plan_fai',                1, '48baa1112ed62a6cba09f35dea87557adf43df7304feefb5693f9379a8340e3e'),
    ('FINDINGS_DRAFTING',       'FAI_AUDIT_FINDINGS_DRAFTING_MOCK',       '7b2f4fe2f6d3cb1f131c34ec647c2ee9123db87c3873950a34ff999827a4a274', 'FAI_AUDIT_FINDINGS_DRAFTING_MOCK_HANDLER',       'cedaf856b21a00f0b3f5edb92148f3c3a49e72d1faf6487aac28c772d7d351fd', 'pre_analisi_ai_ammissibilita_fai', 1, '3b5902fb767a64e7710d5bd71cc283102d0df3a4a6184d8786e6a5f06510ef5c'),
    ('REPORT_COMPOSITION',      'FAI_AUDIT_REPORT_COMPOSITION_MOCK',      '77ed235277c1e1e7c712c2d7ddbefc6ea49c2bb01d6aceec8026e32d478f05ad', 'FAI_AUDIT_REPORT_COMPOSITION_MOCK_HANDLER',      '9ca22ddbd6e664433b6caa4cf7aa4f298c0f332e771f2dca9c6d9dc922b61233', 'dossier_strategico_fai',           1, 'd9c6dc5418e2beb0ac1468770cfa7f629b870ef2312df2f8ca20f53f5135af49'),
    ('SCHEMA_REVIEW',           'FAI_AUDIT_SCHEMA_REVIEW_MOCK',           '1f7176fb2e6ac7257db8fb0b9db43f02f91b132834ec4b113d5bef54285928c6', 'FAI_AUDIT_SCHEMA_REVIEW_MOCK_HANDLER',           'e9bed22d8af15be8ebe834cdc9fc470272cb923c56dc36e23379a4f1e4473893', 'revisore_ai_fai',                  1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('NUMERIC_REVIEW',          'FAI_AUDIT_NUMERIC_REVIEW_MOCK',          '9bef59450e23cff1ae877ebdf733ddbb37584a55c7ba070597994068b49fb0e3', 'FAI_AUDIT_NUMERIC_REVIEW_MOCK_HANDLER',          'af7cb1aeb637b894949a1bffd9302b80e885f4166537996455554b02461210ca', 'revisore_ai_fai',                  1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('SOURCE_REVIEW',           'FAI_AUDIT_SOURCE_REVIEW_MOCK',           'dd1eff51eb7cb6165aaaa721482e1f3c52d15995baefb208646cacd8d998bcbf', 'FAI_AUDIT_SOURCE_REVIEW_MOCK_HANDLER',           'a44a71297b6db68ffdfb219a88eda66bf7ad8d2a8c8472f76e793f798f582207', 'revisore_ai_fai',                  1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('RED_TEAM_REVIEW',         'FAI_AUDIT_RED_TEAM_REVIEW_MOCK',         '5402fa8682537a9e8958a78b9aabd73a758e536c677027008507c7c261ade6f1', 'FAI_AUDIT_RED_TEAM_REVIEW_MOCK_HANDLER',         'ecacd1eba32c78a0e7868d2b6683fc3f136c84e402105fd8e35dd0c9e96d1e0a', 'revisore_ai_fai',                  1, '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
    ('CORRECTION',              'FAI_AUDIT_CORRECTION_MOCK',              'ac2d461909c8cf44e518dc92581c37e9e8d3bee9acafd57aa1a26d6d0114017c', 'FAI_AUDIT_CORRECTION_MOCK_HANDLER',              '304f384f455ff396dc3a4b90b674da428ee19461623cb6b669d180135989ed6f', 'ottimizzazione_ai_progetto_fai',    1, '2b213d8a828c55a16eb14be27b18a90812e530ecd522a073576d8e36e33a58ff')
  ) AS mapping(
    "jobCode", "capabilityCode", "capabilityHash", "handlerCode", "jobDefinitionHash",
    "executorAgentCode", "executorAgentConfigVersion", "executorAgentConfigHash"
  )
  WHERE mapping."jobCode" = p_job_code;
$$;

CREATE FUNCTION "ai_orchestrator_runtime_gates_open"()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "AiOrchestratorSetting"
    WHERE "id" = 'global' AND "stateMachineEnabled" = true AND "dispatchEnabled" = true
      AND "syntheticDataOnly" = true AND "provider" = 'mock'
  ) AND EXISTS (
    SELECT 1 FROM "AiControlSetting"
    WHERE "id" = 'global' AND "externalProvidersEnabled" = false
  );
$$;

CREATE FUNCTION "ai_workflow_runtime_job_is_current"(p_job_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "AiWorkflowJob" job
    JOIN "AiWorkflowInstance" instance ON instance."id" = job."workflowInstanceId"
    WHERE job."id" = p_job_id
      AND job."status" = 'PLANNED' AND job."provider" = 'mock'
      AND job."dataMode" = 'synthetic' AND job."automaticDispatchAllowed" = false
      AND instance."definitionHash" = job."workflowDefinitionHash"
      AND instance."currentState" = job."phaseCode"
      AND instance."correctionCycle" = job."correctionCycle"
      AND job."phaseEntrySequence" = (
        SELECT MAX(entry."sequence")
        FROM "AiWorkflowTransition" entry
        WHERE entry."workflowInstanceId" = job."workflowInstanceId"
          AND entry."toState" = job."phaseCode" AND entry."fromState" <> entry."toState"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "AiWorkflowTransition" stop_transition
        WHERE stop_transition."workflowInstanceId" = job."workflowInstanceId"
          AND stop_transition."toState" = 'HUMAN_APPROVAL'
      )
  );
$$;

CREATE FUNCTION "ai_workflow_runtime_executor_is_valid"(p_job_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "AiWorkflowJob" job
    JOIN "AiAgent" agent ON agent."id" = job."executorAgentId"
    JOIN "AiAgentConfigVersion" config
      ON config."agentId" = job."executorAgentId"
      AND config."version" = job."executorAgentConfigVersion"
    WHERE job."id" = p_job_id
      AND agent."code" = job."executorAgentCode" AND agent."active" = true AND agent."provider" = 'mock'
      AND config."code" = job."executorAgentCode" AND config."active" = true
      AND config."provider" = 'mock' AND config."model" IS NULL
      AND "ai_agent_config_snapshot_hash"(config) = job."executorAgentConfigHash"
  );
$$;

CREATE FUNCTION "validate_ai_workflow_job_runtime_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row "AiWorkflowJob"%ROWTYPE;
  expected RECORD;
BEGIN
  SELECT * INTO job_row FROM "AiWorkflowJob" WHERE "id" = NEW."jobId";
  SELECT * INTO expected FROM "expected_ai_workflow_worker_capability"(job_row."jobCode");
  IF job_row."id" IS NULL OR expected."capabilityCode" IS NULL
    OR NEW."workflowInstanceId" IS DISTINCT FROM job_row."workflowInstanceId"
    OR NEW."state" <> 'AVAILABLE' OR NEW."effectiveAvailableAt" IS DISTINCT FROM job_row."availableAt"
    OR NEW."attemptSequence" <> 0 OR NEW."retryFailureCount" <> 0 OR NEW."fencingToken" <> 0
    OR NEW."capabilityCode" IS DISTINCT FROM expected."capabilityCode"
    OR NEW."capabilityHash" IS DISTINCT FROM expected."capabilityHash"
    OR NEW."handlerCode" IS DISTINCT FROM expected."handlerCode"
    OR job_row."jobDefinitionHash" IS DISTINCT FROM expected."jobDefinitionHash"
    OR job_row."executorAgentCode" IS DISTINCT FROM expected."executorAgentCode"
    OR job_row."executorAgentConfigVersion" IS DISTINCT FROM expected."executorAgentConfigVersion"
    OR job_row."executorAgentConfigHash" IS DISTINCT FROM expected."executorAgentConfigHash"
    OR NOT "ai_orchestrator_runtime_gates_open"()
    OR NOT "ai_workflow_runtime_job_is_current"(NEW."jobId")
    OR NOT "ai_workflow_runtime_executor_is_valid"(NEW."jobId")
  THEN RAISE EXCEPTION 'AiWorkflowJobRuntime admission contract is invalid or disabled'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJobRuntime_validate_insert"
BEFORE INSERT ON "AiWorkflowJobRuntime"
FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_runtime_insert"();

CREATE FUNCTION "validate_ai_workflow_outbox_consumption_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_row "AiWorkflowJobOutboxEvent"%ROWTYPE;
  job_row "AiWorkflowJob"%ROWTYPE;
  runtime_row "AiWorkflowJobRuntime"%ROWTYPE;
BEGIN
  SELECT * INTO event_row FROM "AiWorkflowJobOutboxEvent" WHERE "id" = NEW."outboxEventId";
  SELECT * INTO job_row FROM "AiWorkflowJob" WHERE "id" = NEW."jobId";
  SELECT * INTO runtime_row FROM "AiWorkflowJobRuntime" WHERE "id" = NEW."runtimeId";
  IF event_row."id" IS NULL OR job_row."id" IS NULL OR runtime_row."id" IS NULL
    OR event_row."jobId" IS DISTINCT FROM NEW."jobId"
    OR event_row."eventType" <> 'AI_JOB_PLANNED' OR event_row."eventVersion" <> 1
    OR event_row."deliveryState" <> 'PENDING'
    OR runtime_row."jobId" IS DISTINCT FROM NEW."jobId"
    OR NEW."eventKey" IS DISTINCT FROM event_row."eventKey"
    OR NEW."eventPayloadHash" IS DISTINCT FROM event_row."payloadHash"
    OR NEW."jobDedupeKey" IS DISTINCT FROM job_row."dedupeKey"
    OR NEW."jobPayloadHash" IS DISTINCT FROM job_row."payloadHash"
    OR NEW."workflowDefinitionHash" IS DISTINCT FROM job_row."workflowDefinitionHash"
    OR NEW."phaseCode" IS DISTINCT FROM job_row."phaseCode"
    OR NEW."phaseEntrySequence" IS DISTINCT FROM job_row."phaseEntrySequence"
    OR NEW."correctionCycle" IS DISTINCT FROM job_row."correctionCycle"
    OR NEW."executorAgentId" IS DISTINCT FROM job_row."executorAgentId"
    OR NEW."executorAgentConfigVersion" IS DISTINCT FROM job_row."executorAgentConfigVersion"
    OR NEW."executorAgentConfigHash" IS DISTINCT FROM job_row."executorAgentConfigHash"
    OR NEW."runtimePolicyHash" IS DISTINCT FROM runtime_row."runtimePolicyHash"
    OR NEW."capabilityHash" IS DISTINCT FROM runtime_row."capabilityHash"
    OR NOT "ai_orchestrator_runtime_gates_open"()
    OR NOT "ai_workflow_runtime_job_is_current"(NEW."jobId")
    OR NOT "ai_workflow_runtime_executor_is_valid"(NEW."jobId")
  THEN RAISE EXCEPTION 'AiWorkflowOutboxConsumption canonical admission is invalid or disabled'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowOutboxConsumption_validate_insert"
BEFORE INSERT ON "AiWorkflowOutboxConsumption"
FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_outbox_consumption_insert"();

CREATE FUNCTION "verify_ai_workflow_runtime_consumption"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AiWorkflowOutboxConsumption"
    WHERE "runtimeId" = NEW."id" AND "jobId" = NEW."jobId"
  ) THEN RAISE EXCEPTION 'AiWorkflowJobRuntime has no canonical outbox consumption'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiWorkflowJobRuntime_requires_consumption"
AFTER INSERT ON "AiWorkflowJobRuntime" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_runtime_consumption"();

CREATE FUNCTION "protect_ai_workflow_job_runtime_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."jobId" IS DISTINCT FROM NEW."jobId"
    OR OLD."workflowInstanceId" IS DISTINCT FROM NEW."workflowInstanceId"
    OR OLD."runtimePolicyCode" IS DISTINCT FROM NEW."runtimePolicyCode"
    OR OLD."runtimePolicyVersion" IS DISTINCT FROM NEW."runtimePolicyVersion"
    OR OLD."runtimePolicyHash" IS DISTINCT FROM NEW."runtimePolicyHash"
    OR OLD."capabilityCode" IS DISTINCT FROM NEW."capabilityCode"
    OR OLD."capabilityVersion" IS DISTINCT FROM NEW."capabilityVersion"
    OR OLD."capabilityHash" IS DISTINCT FROM NEW."capabilityHash"
    OR OLD."handlerCode" IS DISTINCT FROM NEW."handlerCode"
    OR OLD."handlerVersion" IS DISTINCT FROM NEW."handlerVersion"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN RAISE EXCEPTION 'AiWorkflowJobRuntime identity and policy are immutable'; END IF;

  IF NEW."state" = 'LEASED' AND OLD."state" IN ('AVAILABLE', 'RETRY_WAIT') THEN
    IF NEW."attemptSequence" <> OLD."attemptSequence" + 1
      OR NEW."fencingToken" <> OLD."fencingToken" + 1
      OR NEW."retryFailureCount" <> OLD."retryFailureCount"
      OR NEW."leaseClaimedAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      OR NEW."leaseClaimedAt" < (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '5 seconds'
      OR NEW."leaseExpiresAt" IS DISTINCT FROM NEW."leaseClaimedAt" + INTERVAL '120 seconds'
      OR NEW."leaseMaxExpiresAt" IS DISTINCT FROM NEW."leaseClaimedAt" + INTERVAL '600 seconds'
      OR NOT "ai_orchestrator_runtime_gates_open"()
      OR NOT "ai_workflow_runtime_job_is_current"(NEW."jobId")
      OR NOT "ai_workflow_runtime_executor_is_valid"(NEW."jobId")
    THEN RAISE EXCEPTION 'AiWorkflowJobRuntime claim is invalid or disabled'; END IF;
  ELSIF NEW."state" = 'LEASED' AND OLD."state" = 'LEASED' THEN
    IF NEW."attemptSequence" <> OLD."attemptSequence" OR NEW."fencingToken" <> OLD."fencingToken"
      OR NEW."leaseOwnerId" IS DISTINCT FROM OLD."leaseOwnerId"
      OR NEW."leaseTokenHash" IS DISTINCT FROM OLD."leaseTokenHash"
      OR NEW."leaseClaimedAt" IS DISTINCT FROM OLD."leaseClaimedAt"
      OR NEW."leaseMaxExpiresAt" IS DISTINCT FROM OLD."leaseMaxExpiresAt"
      OR NEW."leaseExpiresAt" <= OLD."leaseExpiresAt"
      OR OLD."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
      OR NOT "ai_orchestrator_runtime_gates_open"()
      OR NOT "ai_workflow_runtime_job_is_current"(NEW."jobId")
      OR NOT "ai_workflow_runtime_executor_is_valid"(NEW."jobId")
    THEN RAISE EXCEPTION 'AiWorkflowJobRuntime heartbeat is invalid or disabled'; END IF;
  ELSIF OLD."state" = 'LEASED' AND NEW."state" IN ('RETRY_WAIT', 'SUCCEEDED', 'FAILED_TERMINAL', 'SUPERSEDED') THEN
    IF NEW."attemptSequence" <> OLD."attemptSequence" OR NEW."fencingToken" <> OLD."fencingToken"
      OR (
        OLD."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
        AND NEW."lastFailureCode" IS DISTINCT FROM 'LEASE_EXPIRED'
        AND NOT (NEW."state" = 'SUPERSEDED' AND NEW."terminalReasonCode" = 'PHASE_SUPERSEDED')
      )
      OR (NEW."state" = 'SUCCEEDED' AND (
        NOT "ai_orchestrator_runtime_gates_open"()
        OR NOT "ai_workflow_runtime_job_is_current"(NEW."jobId")
        OR NOT "ai_workflow_runtime_executor_is_valid"(NEW."jobId")
      ))
    THEN RAISE EXCEPTION 'AiWorkflowJobRuntime terminal transition is invalid'; END IF;
  ELSIF OLD."state" IN ('AVAILABLE', 'RETRY_WAIT') AND NEW."state" = 'SUPERSEDED' THEN
    IF NEW."attemptSequence" <> OLD."attemptSequence" OR NEW."fencingToken" <> OLD."fencingToken"
    THEN RAISE EXCEPTION 'AiWorkflowJobRuntime supersession is invalid'; END IF;
  ELSE
    RAISE EXCEPTION 'AiWorkflowJobRuntime lifecycle transition is not allowed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJobRuntime_protect_update"
BEFORE UPDATE ON "AiWorkflowJobRuntime"
FOR EACH ROW EXECUTE FUNCTION "protect_ai_workflow_job_runtime_update"();

CREATE FUNCTION "validate_ai_workflow_job_attempt_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  runtime_row "AiWorkflowJobRuntime"%ROWTYPE;
  job_row "AiWorkflowJob"%ROWTYPE;
BEGIN
  SELECT * INTO runtime_row FROM "AiWorkflowJobRuntime" WHERE "id" = NEW."runtimeId";
  SELECT * INTO job_row FROM "AiWorkflowJob" WHERE "id" = NEW."jobId";
  IF runtime_row."id" IS NULL OR job_row."id" IS NULL OR runtime_row."state" <> 'LEASED'
    OR runtime_row."jobId" IS DISTINCT FROM NEW."jobId"
    OR NEW."attemptSequence" IS DISTINCT FROM runtime_row."attemptSequence"
    OR NEW."fencingToken" IS DISTINCT FROM runtime_row."fencingToken"
    OR NEW."leaseTokenHash" IS DISTINCT FROM runtime_row."leaseTokenHash"
    OR NEW."claimedAt" IS DISTINCT FROM runtime_row."leaseClaimedAt"
    OR NEW."leaseExpiresAt" IS DISTINCT FROM runtime_row."leaseExpiresAt"
    OR NEW."leaseMaxExpiresAt" IS DISTINCT FROM runtime_row."leaseMaxExpiresAt"
    OR NEW."runtimePolicyHash" IS DISTINCT FROM runtime_row."runtimePolicyHash"
    OR NEW."capabilityHash" IS DISTINCT FROM runtime_row."capabilityHash"
    OR NEW."handlerCode" IS DISTINCT FROM runtime_row."handlerCode"
    OR NEW."handlerVersion" IS DISTINCT FROM runtime_row."handlerVersion"
    OR NEW."workflowDefinitionHash" IS DISTINCT FROM job_row."workflowDefinitionHash"
    OR NEW."phaseCode" IS DISTINCT FROM job_row."phaseCode"
    OR NEW."phaseEntrySequence" IS DISTINCT FROM job_row."phaseEntrySequence"
    OR NEW."correctionCycle" IS DISTINCT FROM job_row."correctionCycle"
    OR NEW."executorAgentId" IS DISTINCT FROM job_row."executorAgentId"
    OR NEW."executorAgentConfigVersion" IS DISTINCT FROM job_row."executorAgentConfigVersion"
    OR NEW."executorAgentConfigHash" IS DISTINCT FROM job_row."executorAgentConfigHash"
    OR NEW."jobPayloadHash" IS DISTINCT FROM job_row."payloadHash"
  THEN RAISE EXCEPTION 'AiWorkflowJobAttempt does not match the fenced runtime claim'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJobAttempt_validate_insert"
BEFORE INSERT ON "AiWorkflowJobAttempt"
FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_attempt_insert"();

CREATE FUNCTION "protect_ai_workflow_job_attempt_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."runtimeId" IS DISTINCT FROM NEW."runtimeId"
    OR OLD."jobId" IS DISTINCT FROM NEW."jobId"
    OR OLD."attemptSequence" IS DISTINCT FROM NEW."attemptSequence"
    OR OLD."fencingToken" IS DISTINCT FROM NEW."fencingToken"
    OR OLD."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId"
    OR OLD."workerBuildHash" IS DISTINCT FROM NEW."workerBuildHash"
    OR OLD."leaseTokenHash" IS DISTINCT FROM NEW."leaseTokenHash"
    OR OLD."claimedAt" IS DISTINCT FROM NEW."claimedAt"
    OR OLD."leaseMaxExpiresAt" IS DISTINCT FROM NEW."leaseMaxExpiresAt"
    OR OLD."runtimePolicyHash" IS DISTINCT FROM NEW."runtimePolicyHash"
    OR OLD."capabilityHash" IS DISTINCT FROM NEW."capabilityHash"
    OR OLD."handlerCode" IS DISTINCT FROM NEW."handlerCode"
    OR OLD."handlerVersion" IS DISTINCT FROM NEW."handlerVersion"
    OR OLD."workflowDefinitionHash" IS DISTINCT FROM NEW."workflowDefinitionHash"
    OR OLD."phaseCode" IS DISTINCT FROM NEW."phaseCode"
    OR OLD."phaseEntrySequence" IS DISTINCT FROM NEW."phaseEntrySequence"
    OR OLD."correctionCycle" IS DISTINCT FROM NEW."correctionCycle"
    OR OLD."executorAgentId" IS DISTINCT FROM NEW."executorAgentId"
    OR OLD."executorAgentConfigVersion" IS DISTINCT FROM NEW."executorAgentConfigVersion"
    OR OLD."executorAgentConfigHash" IS DISTINCT FROM NEW."executorAgentConfigHash"
    OR OLD."jobPayloadHash" IS DISTINCT FROM NEW."jobPayloadHash"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN RAISE EXCEPTION 'AiWorkflowJobAttempt identity and claim are immutable'; END IF;
  IF OLD."finishedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'AiWorkflowJobAttempt is already terminal';
  END IF;
  IF NEW."finishedAt" IS NULL THEN
    IF NEW."leaseExpiresAt" <= OLD."leaseExpiresAt" OR NEW."outcome" IS NOT NULL THEN
      RAISE EXCEPTION 'AiWorkflowJobAttempt heartbeat is invalid';
    END IF;
  ELSIF NEW."leaseExpiresAt" < OLD."leaseExpiresAt" THEN
    RAISE EXCEPTION 'AiWorkflowJobAttempt terminalization cannot shorten its recorded lease';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJobAttempt_protect_update"
BEFORE UPDATE ON "AiWorkflowJobAttempt"
FOR EACH ROW EXECUTE FUNCTION "protect_ai_workflow_job_attempt_update"();

CREATE FUNCTION "validate_ai_workflow_runtime_event_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  runtime_row "AiWorkflowJobRuntime"%ROWTYPE;
  previous_row "AiWorkflowJobRuntimeEvent"%ROWTYPE;
  expected_event_hash TEXT;
BEGIN
  SELECT * INTO runtime_row FROM "AiWorkflowJobRuntime" WHERE "id" = NEW."runtimeId";
  SELECT * INTO previous_row FROM "AiWorkflowJobRuntimeEvent"
    WHERE "runtimeId" = NEW."runtimeId" ORDER BY "sequence" DESC LIMIT 1;
  expected_event_hash := ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(
    JSONB_BUILD_OBJECT(
      'schemaVersion', 1,
      'runtimeId', NEW."runtimeId",
      'jobId', NEW."jobId",
      'workflowInstanceId', NEW."workflowInstanceId",
      'sequence', NEW."sequence",
      'eventType', NEW."eventType",
      'attemptSequence', NEW."attemptSequence",
      'fencingToken', CASE WHEN NEW."fencingToken" IS NULL THEN NULL ELSE NEW."fencingToken"::TEXT END,
      'reasonCode', NEW."reasonCode",
      'payloadHash', NEW."payloadHash",
      'previousEventHash', NEW."previousEventHash",
      'occurredAt', TO_CHAR(NEW."occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  ), 'UTF8')), 'hex');
  IF runtime_row."id" IS NULL OR runtime_row."jobId" IS DISTINCT FROM NEW."jobId"
    OR runtime_row."workflowInstanceId" IS DISTINCT FROM NEW."workflowInstanceId"
    OR NEW."payloadHash" IS DISTINCT FROM ENCODE(SHA256(CONVERT_TO(
      "canonicalize_ai_workflow_jsonb"(NEW."payload"), 'UTF8')), 'hex')
    OR NEW."eventHash" IS DISTINCT FROM expected_event_hash
    OR (previous_row."id" IS NULL AND (NEW."sequence" <> 1 OR NEW."previousEventHash" IS NOT NULL))
    OR (previous_row."id" IS NOT NULL AND (
      NEW."sequence" <> previous_row."sequence" + 1
      OR NEW."previousEventHash" IS DISTINCT FROM previous_row."eventHash"
    ))
  THEN RAISE EXCEPTION 'AiWorkflowJobRuntimeEvent hash chain or binding is invalid'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiWorkflowJobRuntimeEvent_validate_insert"
BEFORE INSERT ON "AiWorkflowJobRuntimeEvent"
FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_runtime_event_insert"();

CREATE FUNCTION "reject_ai_workflow_runtime_delete"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% cannot be deleted', TG_TABLE_NAME; END;
$$;

CREATE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;

CREATE TRIGGER "AiWorkflowJobRuntime_immutable_delete" BEFORE DELETE ON "AiWorkflowJobRuntime"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_delete"();
CREATE TRIGGER "AiWorkflowJobAttempt_immutable_delete" BEFORE DELETE ON "AiWorkflowJobAttempt"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_delete"();
CREATE TRIGGER "AiWorkflowOutboxConsumption_immutable_update" BEFORE UPDATE ON "AiWorkflowOutboxConsumption"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"();
CREATE TRIGGER "AiWorkflowOutboxConsumption_immutable_delete" BEFORE DELETE ON "AiWorkflowOutboxConsumption"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"();
CREATE TRIGGER "AiWorkflowJobRuntimeEvent_immutable_update" BEFORE UPDATE ON "AiWorkflowJobRuntimeEvent"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"();
CREATE TRIGGER "AiWorkflowJobRuntimeEvent_immutable_delete" BEFORE DELETE ON "AiWorkflowJobRuntimeEvent"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"();

COMMIT;
