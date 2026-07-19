-- AI Orchestrator Result & Artifact Contract Foundation v1 (additive, fail-closed).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AiWorkflowJobRuntime" WHERE "state" = 'SUCCEEDED' AND "resultHash" IS NOT NULL) THEN
    RAISE EXCEPTION 'Preflight failed: existing SUCCEEDED runtimes require canonical results before this migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiOrchestratorSetting_dispatch_disabled_check') THEN
    RAISE EXCEPTION 'Required dispatch-disabled physical barrier is missing';
  END IF;
END $$;

CREATE TABLE "AiWorkflowJobResult" (
  "id" TEXT NOT NULL, "runtimeId" TEXT NOT NULL, "jobId" TEXT NOT NULL, "attemptId" TEXT NOT NULL, "attemptSequence" INTEGER NOT NULL,
  "fencingToken" BIGINT NOT NULL, "workerInstanceId" TEXT NOT NULL, "workerBuildHash" TEXT NOT NULL, "runtimePolicyHash" TEXT NOT NULL,
  "capabilityCode" TEXT NOT NULL, "capabilityVersion" TEXT NOT NULL, "capabilityHash" TEXT NOT NULL, "handlerCode" TEXT NOT NULL, "handlerVersion" TEXT NOT NULL,
  "resultContractCode" TEXT NOT NULL, "resultContractVersion" TEXT NOT NULL, "resultContractHash" TEXT NOT NULL, "jobPayloadHash" TEXT NOT NULL,
  "workflowInstanceId" TEXT NOT NULL, "workflowDefinitionHash" TEXT NOT NULL, "phaseCode" TEXT NOT NULL, "phaseEntrySequence" INTEGER NOT NULL, "correctionCycle" INTEGER NOT NULL,
  "executorAgentId" TEXT NOT NULL, "executorAgentCode" TEXT NOT NULL, "executorAgentConfigVersion" INTEGER NOT NULL, "executorAgentConfigHash" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'mock', "dataMode" TEXT NOT NULL DEFAULT 'synthetic', "payload" JSONB NOT NULL, "payloadHash" TEXT NOT NULL,
  "manifestHash" TEXT NOT NULL, "resultHash" TEXT NOT NULL, "artifactCount" INTEGER NOT NULL, "totalPayloadBytes" INTEGER NOT NULL,
  "retentionPolicyCode" TEXT NOT NULL, "retentionPolicyVersion" TEXT NOT NULL, "retentionPolicyHash" TEXT NOT NULL, "retentionClass" TEXT NOT NULL, "retainUntil" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiWorkflowJobResult_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowJobResult_hash_check" CHECK ("workerBuildHash" ~ '^[0-9a-f]{64}$' AND "runtimePolicyHash" ~ '^[0-9a-f]{64}$' AND "capabilityHash" ~ '^[0-9a-f]{64}$' AND "resultContractHash" ~ '^[0-9a-f]{64}$' AND "jobPayloadHash" ~ '^[0-9a-f]{64}$' AND "payloadHash" ~ '^[0-9a-f]{64}$' AND "manifestHash" ~ '^[0-9a-f]{64}$' AND "resultHash" ~ '^[0-9a-f]{64}$' AND "retentionPolicyHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AiWorkflowJobResult_boundary_check" CHECK ("provider" = 'mock' AND "dataMode" = 'synthetic' AND JSONB_TYPEOF("payload") = 'object' AND "artifactCount" BETWEEN 1 AND 8 AND "totalPayloadBytes" BETWEEN 1 AND 65536)
);
CREATE TABLE "AiWorkflowJobArtifact" (
  "id" TEXT NOT NULL, "resultId" TEXT NOT NULL, "ordinal" INTEGER NOT NULL, "slotCode" TEXT NOT NULL, "logicalKey" TEXT NOT NULL, "artifactType" TEXT NOT NULL,
  "artifactSchemaCode" TEXT NOT NULL, "artifactSchemaVersion" TEXT NOT NULL, "artifactSchemaHash" TEXT NOT NULL, "artifactVersion" TEXT NOT NULL, "mediaType" TEXT NOT NULL DEFAULT 'application/json',
  "payload" JSONB NOT NULL, "payloadHash" TEXT NOT NULL, "artifactHash" TEXT NOT NULL, "payloadBytes" INTEGER NOT NULL, "supersedesArtifactId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiWorkflowJobArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowJobArtifact_hash_check" CHECK ("artifactSchemaHash" ~ '^[0-9a-f]{64}$' AND "payloadHash" ~ '^[0-9a-f]{64}$' AND "artifactHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AiWorkflowJobArtifact_payload_check" CHECK ("mediaType" = 'application/json' AND JSONB_TYPEOF("payload") = 'object' AND "ordinal" BETWEEN 0 AND 7 AND "payloadBytes" BETWEEN 1 AND 16384)
);
CREATE TABLE "AiWorkflowJobSourceArtifact" ("id" TEXT NOT NULL, "resultId" TEXT NOT NULL, "sourceArtifactId" TEXT NOT NULL, "sourceArtifactHash" TEXT NOT NULL, "role" TEXT NOT NULL, "ordinal" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AiWorkflowJobSourceArtifact_pkey" PRIMARY KEY ("id"), CONSTRAINT "AiWorkflowJobSourceArtifact_check" CHECK ("sourceArtifactHash" ~ '^[0-9a-f]{64}$' AND "ordinal" BETWEEN 0 AND 15));
CREATE UNIQUE INDEX "AiWorkflowJobResult_attemptId_key" ON "AiWorkflowJobResult"("attemptId");
CREATE UNIQUE INDEX "AiWorkflowJobResult_resultHash_key" ON "AiWorkflowJobResult"("resultHash");
CREATE UNIQUE INDEX "AiWorkflowJobResult_runtimeId_jobId_attemptSequence_key" ON "AiWorkflowJobResult"("runtimeId", "jobId", "attemptSequence");
CREATE INDEX "AiWorkflowJobResult_runtimeId_resultHash_idx" ON "AiWorkflowJobResult"("runtimeId", "resultHash");
CREATE INDEX "AiWorkflowJobResult_jobId_createdAt_idx" ON "AiWorkflowJobResult"("jobId", "createdAt");
CREATE INDEX "AiWorkflowJobResult_workflowInstanceId_createdAt_idx" ON "AiWorkflowJobResult"("workflowInstanceId", "createdAt");
CREATE UNIQUE INDEX "AiWorkflowJobArtifact_artifactHash_key" ON "AiWorkflowJobArtifact"("artifactHash");
CREATE UNIQUE INDEX "AiWorkflowJobArtifact_resultId_ordinal_key" ON "AiWorkflowJobArtifact"("resultId", "ordinal");
CREATE UNIQUE INDEX "AiWorkflowJobArtifact_resultId_slotCode_key" ON "AiWorkflowJobArtifact"("resultId", "slotCode");
CREATE INDEX "AiWorkflowJobArtifact_resultId_idx" ON "AiWorkflowJobArtifact"("resultId");
CREATE INDEX "AiWorkflowJobArtifact_artifactType_artifactHash_idx" ON "AiWorkflowJobArtifact"("artifactType", "artifactHash");
CREATE UNIQUE INDEX "AiWorkflowJobSourceArtifact_resultId_ordinal_key" ON "AiWorkflowJobSourceArtifact"("resultId", "ordinal");
CREATE UNIQUE INDEX "AiWorkflowJobSourceArtifact_resultId_sourceArtifactId_role_key" ON "AiWorkflowJobSourceArtifact"("resultId", "sourceArtifactId", "role");
CREATE INDEX "AiWorkflowJobSourceArtifact_sourceArtifactId_idx" ON "AiWorkflowJobSourceArtifact"("sourceArtifactId");
ALTER TABLE "AiWorkflowJobResult" ADD CONSTRAINT "AiWorkflowJobResult_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "AiWorkflowJobRuntime"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobResult" ADD CONSTRAINT "AiWorkflowJobResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiWorkflowJob"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobResult" ADD CONSTRAINT "AiWorkflowJobResult_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "AiWorkflowJobAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobArtifact" ADD CONSTRAINT "AiWorkflowJobArtifact_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "AiWorkflowJobResult"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobArtifact" ADD CONSTRAINT "AiWorkflowJobArtifact_supersedesArtifactId_fkey" FOREIGN KEY ("supersedesArtifactId") REFERENCES "AiWorkflowJobArtifact"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobSourceArtifact" ADD CONSTRAINT "AiWorkflowJobSourceArtifact_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "AiWorkflowJobResult"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobSourceArtifact" ADD CONSTRAINT "AiWorkflowJobSourceArtifact_sourceArtifactId_fkey" FOREIGN KEY ("sourceArtifactId") REFERENCES "AiWorkflowJobArtifact"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER "AiWorkflowJobResult_no_update" BEFORE UPDATE ON "AiWorkflowJobResult" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"();
CREATE TRIGGER "AiWorkflowJobResult_no_delete" BEFORE DELETE ON "AiWorkflowJobResult" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_delete"();
CREATE TRIGGER "AiWorkflowJobArtifact_no_update" BEFORE UPDATE ON "AiWorkflowJobArtifact" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"();
CREATE TRIGGER "AiWorkflowJobArtifact_no_delete" BEFORE DELETE ON "AiWorkflowJobArtifact" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_delete"();
CREATE TRIGGER "AiWorkflowJobSourceArtifact_no_update" BEFORE UPDATE ON "AiWorkflowJobSourceArtifact" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"();
CREATE TRIGGER "AiWorkflowJobSourceArtifact_no_delete" BEFORE DELETE ON "AiWorkflowJobSourceArtifact" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_delete"();
