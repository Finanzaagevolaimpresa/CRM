-- AI Orchestrator Result & Artifact Contract Foundation v1 (additive, fail-closed).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AiWorkflowJobRuntime" WHERE "state" = 'SUCCEEDED' AND "resultHash" IS NOT NULL) THEN
    RAISE EXCEPTION 'Preflight failed: existing SUCCEEDED runtimes require canonical results before this migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
    WHERE constraint_row.conname = 'AiOrchestratorSetting_dispatch_disabled_check'
      AND table_row.relname = 'AiOrchestratorSetting'
      AND constraint_row.convalidated = true
      AND pg_get_constraintdef(constraint_row.oid) = 'CHECK (("dispatchEnabled" = false))'
  ) THEN
    RAISE EXCEPTION 'Required dispatch-disabled physical barrier is missing or not exact';
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
CREATE INDEX "AiWorkflowJobArtifact_artifactHash_idx" ON "AiWorkflowJobArtifact"("artifactHash");
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
CREATE FUNCTION "ai_result_artifact_canonical_hash"(p_domain TEXT, p_value JSONB)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT ENCODE(SHA256(CONVERT_TO(p_domain || E'\n' || "canonicalize_ai_workflow_jsonb"(p_value), 'UTF8')), 'hex')
$$;

CREATE FUNCTION "ai_result_artifact_canonical_json_hash"(p_value JSONB)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(p_value), 'UTF8')), 'hex')
$$;

CREATE FUNCTION "validate_ai_workflow_job_result_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE runtime_row "AiWorkflowJobRuntime"%ROWTYPE; attempt_row "AiWorkflowJobAttempt"%ROWTYPE; job_row "AiWorkflowJob"%ROWTYPE;
BEGIN
  SELECT * INTO runtime_row FROM "AiWorkflowJobRuntime" WHERE "id" = NEW."runtimeId";
  SELECT * INTO attempt_row FROM "AiWorkflowJobAttempt" WHERE "id" = NEW."attemptId";
  SELECT * INTO job_row FROM "AiWorkflowJob" WHERE "id" = NEW."jobId";
  IF runtime_row."id" IS NULL OR attempt_row."id" IS NULL OR job_row."id" IS NULL THEN RAISE EXCEPTION 'AiWorkflowJobResult references missing runtime/job/attempt'; END IF;
  IF runtime_row."jobId" <> NEW."jobId" OR attempt_row."runtimeId" <> NEW."runtimeId" OR attempt_row."jobId" <> NEW."jobId" THEN RAISE EXCEPTION 'AiWorkflowJobResult runtime/job/attempt mismatch'; END IF;
  IF attempt_row."attemptSequence" <> NEW."attemptSequence" OR attempt_row."fencingToken" <> NEW."fencingToken" OR attempt_row."workerInstanceId" <> NEW."workerInstanceId" OR attempt_row."workerBuildHash" <> NEW."workerBuildHash" THEN RAISE EXCEPTION 'AiWorkflowJobResult attempt provenance mismatch'; END IF;
  IF runtime_row."runtimePolicyHash" <> NEW."runtimePolicyHash" OR runtime_row."capabilityCode" <> NEW."capabilityCode" OR runtime_row."capabilityVersion" <> NEW."capabilityVersion" OR runtime_row."capabilityHash" <> NEW."capabilityHash" OR runtime_row."handlerCode" <> NEW."handlerCode" OR runtime_row."handlerVersion" <> NEW."handlerVersion" THEN RAISE EXCEPTION 'AiWorkflowJobResult runtime provenance mismatch'; END IF;
  IF job_row."payloadHash" <> NEW."jobPayloadHash" OR job_row."workflowDefinitionHash" <> NEW."workflowDefinitionHash" OR job_row."phaseCode" <> NEW."phaseCode" OR job_row."phaseEntrySequence" <> NEW."phaseEntrySequence" OR job_row."correctionCycle" <> NEW."correctionCycle" OR job_row."executorAgentId" <> NEW."executorAgentId" OR job_row."executorAgentCode" <> NEW."executorAgentCode" OR job_row."executorAgentConfigVersion" <> NEW."executorAgentConfigVersion" OR job_row."executorAgentConfigHash" <> NEW."executorAgentConfigHash" THEN RAISE EXCEPTION 'AiWorkflowJobResult job provenance mismatch'; END IF;
  IF NEW."workflowInstanceId" <> runtime_row."workflowInstanceId" OR NEW."workflowInstanceId" <> job_row."workflowInstanceId" THEN RAISE EXCEPTION 'AiWorkflowJobResult workflow mismatch'; END IF;
  IF NEW."payloadHash" <> "ai_result_artifact_canonical_hash"('ai.payload.v1', NEW."payload") THEN RAISE EXCEPTION 'AiWorkflowJobResult payloadHash mismatch'; END IF;
  IF NEW."retentionPolicyHash" <> "ai_result_artifact_canonical_json_hash"(JSONB_BUILD_OBJECT('domain','ai.retentionPolicy.v1','policyCode',NEW."retentionPolicyCode",'policyVersion',NEW."retentionPolicyVersion",'retentionClass',NEW."retentionClass",'retainUntil',CASE WHEN NEW."retainUntil" IS NULL THEN NULL ELSE TO_JSONB(TO_CHAR(NEW."retainUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)) THEN RAISE EXCEPTION 'AiWorkflowJobResult retentionPolicyHash mismatch'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "validate_ai_workflow_job_artifact_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE result_row "AiWorkflowJobResult"%ROWTYPE;
BEGIN
  SELECT * INTO result_row FROM "AiWorkflowJobResult" WHERE "id" = NEW."resultId";
  IF result_row."id" IS NULL THEN RAISE EXCEPTION 'AiWorkflowJobArtifact result missing'; END IF;
  IF result_row."artifactCount" <= NEW."ordinal" THEN RAISE EXCEPTION 'AiWorkflowJobArtifact ordinal exceeds result artifactCount'; END IF;
  IF NEW."payloadHash" <> "ai_result_artifact_canonical_hash"('ai.payload.v1', NEW."payload") THEN RAISE EXCEPTION 'AiWorkflowJobArtifact payloadHash mismatch'; END IF;
  IF NEW."payloadBytes" <> OCTET_LENGTH(CONVERT_TO("canonicalize_ai_workflow_jsonb"(NEW."payload"), 'UTF8')) THEN RAISE EXCEPTION 'AiWorkflowJobArtifact payloadBytes mismatch'; END IF;
  IF NEW."artifactHash" <> "ai_result_artifact_canonical_json_hash"(JSONB_BUILD_OBJECT('domain','ai.artifact.v1','artifactType',NEW."artifactType",'ordinal',NEW."ordinal",'slotCode',NEW."slotCode",'logicalKey',NEW."logicalKey",'artifactVersion',NEW."artifactVersion",'mediaType',NEW."mediaType",'artifactSchemaHash',NEW."artifactSchemaHash",'payloadHash',NEW."payloadHash",'supersedesArtifactId',NEW."supersedesArtifactId")) THEN RAISE EXCEPTION 'AiWorkflowJobArtifact artifactHash mismatch'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "validate_ai_workflow_job_source_artifact_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row "AiWorkflowJobArtifact"%ROWTYPE; source_result "AiWorkflowJobResult"%ROWTYPE; target_result "AiWorkflowJobResult"%ROWTYPE;
BEGIN
  SELECT * INTO source_row FROM "AiWorkflowJobArtifact" WHERE "id" = NEW."sourceArtifactId";
  SELECT * INTO target_result FROM "AiWorkflowJobResult" WHERE "id" = NEW."resultId";
  IF source_row."id" IS NULL OR target_result."id" IS NULL THEN RAISE EXCEPTION 'AiWorkflowJobSourceArtifact missing source or result'; END IF;
  SELECT * INTO source_result FROM "AiWorkflowJobResult" WHERE "id" = source_row."resultId";
  IF source_row."artifactHash" <> NEW."sourceArtifactHash" THEN RAISE EXCEPTION 'AiWorkflowJobSourceArtifact source hash mismatch'; END IF;
  IF source_result."workflowInstanceId" <> target_result."workflowInstanceId" THEN RAISE EXCEPTION 'AiWorkflowJobSourceArtifact cross-workflow lineage forbidden'; END IF;
  IF source_result."createdAt" > target_result."createdAt" OR source_row."id" = NEW."sourceArtifactId" AND source_row."resultId" = NEW."resultId" THEN RAISE EXCEPTION 'AiWorkflowJobSourceArtifact causal self/future reference forbidden'; END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER "AiWorkflowJobResult_validate_insert" AFTER INSERT ON "AiWorkflowJobResult" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_result_insert"();
CREATE CONSTRAINT TRIGGER "AiWorkflowJobArtifact_validate_insert" AFTER INSERT ON "AiWorkflowJobArtifact" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_artifact_insert"();
CREATE CONSTRAINT TRIGGER "AiWorkflowJobSourceArtifact_validate_insert" AFTER INSERT ON "AiWorkflowJobSourceArtifact" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_source_artifact_insert"();


CREATE FUNCTION "verify_ai_workflow_result_final_consistency"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE runtime_row "AiWorkflowJobRuntime"%ROWTYPE; attempt_row "AiWorkflowJobAttempt"%ROWTYPE; result_row "AiWorkflowJobResult"%ROWTYPE; artifact_count INTEGER; source_count INTEGER; artifact_bytes INTEGER; succeeded_event_count INTEGER;
BEGIN
  SELECT * INTO runtime_row FROM "AiWorkflowJobRuntime" WHERE "id" = COALESCE(NEW."runtimeId", OLD."runtimeId");
  IF runtime_row."id" IS NULL OR runtime_row."state" <> 'SUCCEEDED' THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT * INTO result_row FROM "AiWorkflowJobResult" WHERE "runtimeId" = runtime_row."id" AND "resultHash" = runtime_row."resultHash";
  IF result_row."id" IS NULL THEN RAISE EXCEPTION 'SUCCEEDED runtime requires canonical result'; END IF;
  SELECT * INTO attempt_row FROM "AiWorkflowJobAttempt" WHERE "id" = result_row."attemptId";
  IF attempt_row."outcome" <> 'SUCCEEDED' OR attempt_row."resultHash" <> result_row."resultHash" OR attempt_row."fencingToken" <> result_row."fencingToken" OR attempt_row."attemptSequence" <> result_row."attemptSequence" THEN RAISE EXCEPTION 'SUCCEEDED runtime attempt/result mismatch'; END IF;
  SELECT COUNT(*), COALESCE(SUM("payloadBytes"),0) INTO artifact_count, artifact_bytes FROM "AiWorkflowJobArtifact" WHERE "resultId" = result_row."id";
  SELECT COUNT(*) INTO source_count FROM "AiWorkflowJobSourceArtifact" WHERE "resultId" = result_row."id";
  IF artifact_count <> result_row."artifactCount" THEN RAISE EXCEPTION 'AiWorkflowJobResult artifactCount mismatch'; END IF;
  IF result_row."totalPayloadBytes" <> artifact_bytes + OCTET_LENGTH(CONVERT_TO("canonicalize_ai_workflow_jsonb"(result_row."payload"), 'UTF8')) THEN RAISE EXCEPTION 'AiWorkflowJobResult totalPayloadBytes mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM GENERATE_SERIES(0, result_row."artifactCount" - 1) ordinal WHERE NOT EXISTS (SELECT 1 FROM "AiWorkflowJobArtifact" artifact WHERE artifact."resultId" = result_row."id" AND artifact."ordinal" = ordinal)) THEN RAISE EXCEPTION 'AiWorkflowJobArtifact ordinals are not contiguous'; END IF;
  IF source_count > 0 AND EXISTS (SELECT 1 FROM GENERATE_SERIES(0, source_count - 1) ordinal WHERE NOT EXISTS (SELECT 1 FROM "AiWorkflowJobSourceArtifact" source_ref WHERE source_ref."resultId" = result_row."id" AND source_ref."ordinal" = ordinal)) THEN RAISE EXCEPTION 'AiWorkflowJobSourceArtifact ordinals are not contiguous'; END IF;
  SELECT COUNT(*) INTO succeeded_event_count FROM "AiWorkflowJobRuntimeEvent" event WHERE event."runtimeId" = runtime_row."id" AND event."eventType" = 'SUCCEEDED' AND event."payload"->>'resultHash' = result_row."resultHash" AND event."payload"->>'manifestHash' = result_row."manifestHash" AND event."payload"->>'resultId' = result_row."id" AND (event."payload"->>'artifactCount')::INTEGER = result_row."artifactCount";
  IF succeeded_event_count <> 1 THEN RAISE EXCEPTION 'SUCCEEDED runtime event/result mismatch'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE CONSTRAINT TRIGGER "AiWorkflowJobRuntime_result_final_consistency" AFTER INSERT OR UPDATE ON "AiWorkflowJobRuntime" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_result_final_consistency"();
CREATE CONSTRAINT TRIGGER "AiWorkflowJobAttempt_result_final_consistency" AFTER INSERT OR UPDATE ON "AiWorkflowJobAttempt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_result_final_consistency"();
CREATE CONSTRAINT TRIGGER "AiWorkflowJobRuntimeEvent_result_final_consistency" AFTER INSERT ON "AiWorkflowJobRuntimeEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_result_final_consistency"();
CREATE CONSTRAINT TRIGGER "AiWorkflowJobResult_final_consistency" AFTER INSERT ON "AiWorkflowJobResult" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_result_final_consistency"();
CREATE CONSTRAINT TRIGGER "AiWorkflowJobArtifact_final_consistency" AFTER INSERT ON "AiWorkflowJobArtifact" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_result_final_consistency"();
CREATE CONSTRAINT TRIGGER "AiWorkflowJobSourceArtifact_final_consistency" AFTER INSERT ON "AiWorkflowJobSourceArtifact" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_ai_workflow_result_final_consistency"();

CREATE TRIGGER "AiWorkflowJobResult_no_update" BEFORE UPDATE ON "AiWorkflowJobResult" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"();
CREATE TRIGGER "AiWorkflowJobResult_no_delete" BEFORE DELETE ON "AiWorkflowJobResult" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_delete"();
CREATE TRIGGER "AiWorkflowJobArtifact_no_update" BEFORE UPDATE ON "AiWorkflowJobArtifact" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"();
CREATE TRIGGER "AiWorkflowJobArtifact_no_delete" BEFORE DELETE ON "AiWorkflowJobArtifact" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_delete"();
CREATE TRIGGER "AiWorkflowJobSourceArtifact_no_update" BEFORE UPDATE ON "AiWorkflowJobSourceArtifact" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_append_only_mutation"();
CREATE TRIGGER "AiWorkflowJobSourceArtifact_no_delete" BEFORE DELETE ON "AiWorkflowJobSourceArtifact" FOR EACH ROW EXECUTE FUNCTION "reject_ai_workflow_runtime_delete"();
