-- AI Orchestrator Result & Artifact Contract Foundation v1 (additive, fail-closed).

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AiWorkflowJobRuntime" WHERE "state" = 'SUCCEEDED') THEN
    RAISE EXCEPTION 'Preflight failed: existing SUCCEEDED runtimes require canonical results before this migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
    WHERE constraint_row.conname = 'AiOrchestratorSetting_dispatch_disabled_check'
      AND table_row.relname = 'AiOrchestratorSetting'
      AND table_row.relnamespace = TO_REGNAMESPACE(CURRENT_SCHEMA())
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
  CONSTRAINT "AiWorkflowJobResult_boundary_check" CHECK (
    "provider" = 'mock'
    AND "dataMode" = 'synthetic'
    AND JSONB_TYPEOF("payload") = 'object'
    AND "attemptSequence" >= 1
    AND "fencingToken" = "attemptSequence"::BIGINT
    AND "phaseEntrySequence" >= 1
    AND "correctionCycle" >= 0
    AND "executorAgentConfigVersion" >= 1
    AND CHAR_LENGTH("workerInstanceId") BETWEEN 1 AND 200
    AND "capabilityCode" ~ '^[A-Z0-9_]{1,120}$'
    AND "phaseCode" ~ '^[A-Z0-9_]{1,120}$'
    AND "handlerCode" ~ '^[A-Za-z0-9][A-Za-z0-9_.:_-]{0,199}$'
    AND "executorAgentCode" ~ '^[A-Za-z0-9][A-Za-z0-9_.:_-]{0,199}$'
    AND "capabilityVersion" = '1.0'
    AND "handlerVersion" = '1.0'
    AND "resultContractVersion" = '1.0'
    AND "retentionPolicyCode" = 'AI_RESULT_ARTIFACT_RETENTION_V1'
    AND "retentionPolicyVersion" = '1.0'
    AND "retentionClass" IN ('AUDIT_SYNTHETIC', 'TEMPORARY_SYNTHETIC')
    AND "artifactCount" BETWEEN 1 AND 8
    AND "totalPayloadBytes" BETWEEN 1 AND 65536
  )
);
CREATE TABLE "AiWorkflowJobArtifact" (
  "id" TEXT NOT NULL, "resultId" TEXT NOT NULL, "ordinal" INTEGER NOT NULL, "slotCode" TEXT NOT NULL, "logicalKey" TEXT NOT NULL, "artifactType" TEXT NOT NULL,
  "artifactSchemaCode" TEXT NOT NULL, "artifactSchemaVersion" TEXT NOT NULL, "artifactSchemaHash" TEXT NOT NULL, "artifactVersion" TEXT NOT NULL, "mediaType" TEXT NOT NULL DEFAULT 'application/json',
  "payload" JSONB NOT NULL, "payloadHash" TEXT NOT NULL, "artifactHash" TEXT NOT NULL, "payloadBytes" INTEGER NOT NULL, "supersedesArtifactId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiWorkflowJobArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkflowJobArtifact_hash_check" CHECK ("artifactSchemaHash" ~ '^[0-9a-f]{64}$' AND "payloadHash" ~ '^[0-9a-f]{64}$' AND "artifactHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AiWorkflowJobArtifact_payload_check" CHECK (
    "mediaType" = 'application/json'
    AND "artifactSchemaVersion" = '1.0'
    AND "artifactVersion" = '1.0'
    AND "slotCode" ~ '^[A-Z0-9_]{1,120}$'
    AND "artifactType" ~ '^[A-Z0-9_]{1,120}$'
    AND "logicalKey" ~ '^[A-Za-z0-9_.:-]{1,120}$'
    AND JSONB_TYPEOF("payload") = 'object'
    AND "ordinal" BETWEEN 0 AND 7
    AND "payloadBytes" BETWEEN 1 AND 16384
  )
);
CREATE TABLE "AiWorkflowJobSourceArtifact" ("id" TEXT NOT NULL, "resultId" TEXT NOT NULL, "sourceArtifactId" TEXT NOT NULL, "sourceArtifactHash" TEXT NOT NULL, "role" TEXT NOT NULL, "ordinal" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AiWorkflowJobSourceArtifact_pkey" PRIMARY KEY ("id"), CONSTRAINT "AiWorkflowJobSourceArtifact_check" CHECK ("sourceArtifactHash" ~ '^[0-9a-f]{64}$' AND "role" IN ('PRIMARY', 'SUPPORTING', 'SUPERSEDED') AND "ordinal" BETWEEN 0 AND 15));
CREATE UNIQUE INDEX "AiWorkflowJobResult_attemptId_key" ON "AiWorkflowJobResult"("attemptId");
CREATE UNIQUE INDEX "AiWorkflowJobResult_resultHash_key" ON "AiWorkflowJobResult"("resultHash");
CREATE UNIQUE INDEX "AiWorkflowJobResult_runtimeId_jobId_attemptSequence_key" ON "AiWorkflowJobResult"("runtimeId", "jobId", "attemptSequence");
CREATE INDEX "AiWorkflowJobResult_runtimeId_resultHash_idx" ON "AiWorkflowJobResult"("runtimeId", "resultHash");
CREATE INDEX "AiWorkflowJobResult_jobId_createdAt_idx" ON "AiWorkflowJobResult"("jobId", "createdAt");
CREATE INDEX "AiWorkflowJobResult_workflowInstanceId_createdAt_idx" ON "AiWorkflowJobResult"("workflowInstanceId", "createdAt");
CREATE INDEX "AiWorkflowJobArtifact_artifactHash_idx" ON "AiWorkflowJobArtifact"("artifactHash");
CREATE UNIQUE INDEX "AiWorkflowJobArtifact_resultId_ordinal_key" ON "AiWorkflowJobArtifact"("resultId", "ordinal");
CREATE UNIQUE INDEX "AiWorkflowJobArtifact_resultId_slotCode_key" ON "AiWorkflowJobArtifact"("resultId", "slotCode");
CREATE UNIQUE INDEX "AiWorkflowJobArtifact_resultId_logicalKey_key" ON "AiWorkflowJobArtifact"("resultId", "logicalKey");
CREATE INDEX "AiWorkflowJobArtifact_resultId_idx" ON "AiWorkflowJobArtifact"("resultId");
CREATE INDEX "AiWorkflowJobArtifact_artifactType_artifactHash_idx" ON "AiWorkflowJobArtifact"("artifactType", "artifactHash");
CREATE UNIQUE INDEX "AiWorkflowJobSourceArtifact_resultId_ordinal_key" ON "AiWorkflowJobSourceArtifact"("resultId", "ordinal");
CREATE UNIQUE INDEX "AiWorkflowJobSourceArtifact_resultId_sourceArtifactId_key" ON "AiWorkflowJobSourceArtifact"("resultId", "sourceArtifactId");
CREATE INDEX "AiWorkflowJobSourceArtifact_sourceArtifactId_idx" ON "AiWorkflowJobSourceArtifact"("sourceArtifactId");
ALTER TABLE "AiWorkflowJobResult" ADD CONSTRAINT "AiWorkflowJobResult_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "AiWorkflowJobRuntime"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobResult" ADD CONSTRAINT "AiWorkflowJobResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiWorkflowJob"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobResult" ADD CONSTRAINT "AiWorkflowJobResult_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "AiWorkflowJobAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobResult" ADD CONSTRAINT "AiWorkflowJobResult_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "AiWorkflowInstance"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobArtifact" ADD CONSTRAINT "AiWorkflowJobArtifact_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "AiWorkflowJobResult"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobArtifact" ADD CONSTRAINT "AiWorkflowJobArtifact_supersedesArtifactId_fkey" FOREIGN KEY ("supersedesArtifactId") REFERENCES "AiWorkflowJobArtifact"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobSourceArtifact" ADD CONSTRAINT "AiWorkflowJobSourceArtifact_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "AiWorkflowJobResult"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiWorkflowJobSourceArtifact" ADD CONSTRAINT "AiWorkflowJobSourceArtifact_sourceArtifactId_fkey" FOREIGN KEY ("sourceArtifactId") REFERENCES "AiWorkflowJobArtifact"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- PostgreSQL JSONB keeps arbitrary-precision NUMERIC values, while the v1
-- TypeScript contract hashes ECMAScript Number values through JSON.stringify.
-- PostgreSQL's positive extra_float_digits mode emits the same shortest
-- round-trippable float8 significand; this function only adapts its notation to
-- ECMAScript's fixed/scientific thresholds and exponent spelling. The final
-- NUMERIC comparison rejects raw SQL decimals which would be rounded merely by
-- casting them to float8.
CREATE FUNCTION "canonicalize_ai_result_float8_number_v1"(p_value NUMERIC)
RETURNS TEXT LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE AS $$
DECLARE
  float_value DOUBLE PRECISION;
  float_text TEXT;
  magnitude TEXT;
  mantissa TEXT;
  digits TEXT;
  sign_prefix TEXT := '';
  exponent_marker INTEGER;
  decimal_marker INTEGER;
  decimal_exponent INTEGER := 0;
  fraction_length INTEGER := 0;
  decimal_scale INTEGER;
  scientific_exponent INTEGER;
  decimal_position INTEGER;
  canonical TEXT;
BEGIN
  IF CURRENT_SETTING('extra_float_digits')::INTEGER <= 0 THEN
    RAISE EXCEPTION 'AI result numeric canonicalization requires extra_float_digits > 0';
  END IF;
  float_value := p_value::DOUBLE PRECISION;
  float_text := float_value::TEXT;
  IF LOWER(float_text) IN ('nan', 'infinity', '-infinity') THEN
    RAISE EXCEPTION 'AI result JSON contains a non-finite number';
  END IF;
  IF LEFT(float_text, 1) = '-' THEN
    sign_prefix := '-';
    magnitude := SUBSTRING(float_text FROM 2);
  ELSE
    magnitude := float_text;
  END IF;

  exponent_marker := STRPOS(LOWER(magnitude), 'e');
  IF exponent_marker > 0 THEN
    mantissa := LEFT(magnitude, exponent_marker - 1);
    decimal_exponent := SUBSTRING(magnitude FROM exponent_marker + 1)::INTEGER;
  ELSE
    mantissa := magnitude;
  END IF;
  decimal_marker := STRPOS(mantissa, '.');
  IF decimal_marker > 0 THEN
    fraction_length := LENGTH(mantissa) - decimal_marker;
  END IF;
  digits := REPLACE(mantissa, '.', '');
  decimal_scale := decimal_exponent - fraction_length;
  digits := LTRIM(digits, '0');
  IF digits = '' THEN
    IF p_value IS DISTINCT FROM 0::NUMERIC THEN
      RAISE EXCEPTION 'AI result JSON numeric is not the exact canonical float8 decimal';
    END IF;
    RETURN '0';
  END IF;
  WHILE LENGTH(digits) > 1 AND RIGHT(digits, 1) = '0' LOOP
    digits := LEFT(digits, LENGTH(digits) - 1);
    decimal_scale := decimal_scale + 1;
  END LOOP;

  scientific_exponent := LENGTH(digits) + decimal_scale - 1;
  IF scientific_exponent <= -7 OR scientific_exponent >= 21 THEN
    canonical := sign_prefix || LEFT(digits, 1)
      || CASE WHEN LENGTH(digits) > 1 THEN '.' || SUBSTRING(digits FROM 2) ELSE '' END
      || 'e' || CASE WHEN scientific_exponent >= 0 THEN '+' ELSE '' END
      || scientific_exponent::TEXT;
  ELSE
    decimal_position := scientific_exponent + 1;
    IF decimal_position <= 0 THEN
      canonical := sign_prefix || '0.' || REPEAT('0', -decimal_position) || digits;
    ELSIF decimal_position >= LENGTH(digits) THEN
      canonical := sign_prefix || digits || REPEAT('0', decimal_position - LENGTH(digits));
    ELSE
      canonical := sign_prefix || LEFT(digits, decimal_position) || '.'
        || SUBSTRING(digits FROM decimal_position + 1);
    END IF;
  END IF;

  IF p_value IS DISTINCT FROM canonical::NUMERIC THEN
    RAISE EXCEPTION 'AI result JSON numeric is not the exact canonical float8 decimal';
  END IF;
  RETURN canonical;
END $$;

-- PR77-only canonical JSON. Do not change canonicalize_ai_workflow_jsonb:
-- earlier state-machine, queue and runtime hashes depend on its historical
-- integer-focused representation.
CREATE FUNCTION "canonicalize_ai_result_jsonb_v1"(input_json JSONB)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
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
          TO_JSONB(object_key)::TEXT || ':' || "canonicalize_ai_result_jsonb_v1"(object_value),
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
          "canonicalize_ai_result_jsonb_v1"(array_value),
          ',' ORDER BY array_position
        ),
        ''
      ) || ']'
      INTO canonical
      FROM JSONB_ARRAY_ELEMENTS(input_json) WITH ORDINALITY
        AS array_entry(array_value, array_position);
      RETURN canonical;
    WHEN 'number' THEN
      RETURN "canonicalize_ai_result_float8_number_v1"((input_json #>> '{}')::NUMERIC);
    ELSE
      RETURN input_json::TEXT;
  END CASE;
END;
$$;

CREATE FUNCTION "ai_result_artifact_canonical_hash"(p_domain TEXT, p_value JSONB)
RETURNS TEXT LANGUAGE SQL STABLE AS $$
  SELECT ENCODE(SHA256(CONVERT_TO(p_domain || E'\n' || "canonicalize_ai_result_jsonb_v1"(p_value), 'UTF8')), 'hex')
$$;

CREATE FUNCTION "ai_result_artifact_canonical_json_hash"(p_value JSONB)
RETURNS TEXT LANGUAGE SQL STABLE AS $$
  SELECT ENCODE(SHA256(CONVERT_TO("canonicalize_ai_result_jsonb_v1"(p_value), 'UTF8')), 'hex')
$$;

-- The result/artifact cardinality is part of the v1 contract, independently
-- from the schema digests (which are themselves bound into artifactHash and
-- resultHash). Keeping this mapping in SQL prevents a raw caller from
-- committing a validly hashed but wrong artifact family for a job.
CREATE FUNCTION "expected_ai_workflow_result_artifact_type"(
  p_job_code TEXT,
  p_ordinal INTEGER
)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_ordinal = 0 THEN CASE p_job_code
      WHEN 'DOCUMENT_INGESTION' THEN 'DOCUMENT_MANIFEST'
      WHEN 'DOCUMENT_CLASSIFICATION' THEN 'DOCUMENT_CLASSIFICATION'
      WHEN 'EVIDENCE_EXTRACTION' THEN 'EVIDENCE_SET'
      WHEN 'FINANCIAL_ANALYSIS' THEN 'FINANCIAL_ANALYSIS'
      WHEN 'CREDIT_ANALYSIS' THEN 'CREDIT_ANALYSIS'
      WHEN 'CALCULATIONS' THEN 'CALCULATION_SET'
      WHEN 'FINDINGS_DRAFTING' THEN 'FINDINGS_DRAFT'
      WHEN 'REPORT_COMPOSITION' THEN 'REPORT_DRAFT'
      WHEN 'SCHEMA_REVIEW' THEN 'SCHEMA_REVIEW_REPORT'
      WHEN 'NUMERIC_REVIEW' THEN 'NUMERIC_REVIEW_REPORT'
      WHEN 'SOURCE_REVIEW' THEN 'SOURCE_REVIEW_REPORT'
      WHEN 'RED_TEAM_REVIEW' THEN 'RED_TEAM_REVIEW_REPORT'
      WHEN 'CORRECTION' THEN 'CORRECTED_REPORT'
      ELSE NULL
    END
    WHEN p_job_code = 'CORRECTION' AND p_ordinal = 1 THEN 'CORRECTION_MANIFEST'
    ELSE NULL
  END
$$;

-- Exact digests generated from result-artifact-contract-v1.ts. As in the PR76
-- capability mirror, changing a schema or contract identity requires a new
-- versioned migration; accepting an arbitrary well-shaped digest is forbidden.
CREATE FUNCTION "expected_ai_workflow_artifact_schema_hash"(p_artifact_type TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_artifact_type
    WHEN 'DOCUMENT_MANIFEST' THEN 'bf299a9b90f895ffc467a95824711498416a6d2693548cb8e71da6b7ab2cce94'
    WHEN 'DOCUMENT_CLASSIFICATION' THEN '48373e052869df45883dd1d54734f667bf79b07b0b1bb7203f330b2cd72cf7e8'
    WHEN 'EVIDENCE_SET' THEN 'b26b140ddb4a4fd16675facffbebabc734feafb0293b2a0c305430d4346a539e'
    WHEN 'FINANCIAL_ANALYSIS' THEN '9e7e1ccef16eb422d65ffbadee38c1e3325a7cb27aa416ee586964a1ac3967f3'
    WHEN 'CREDIT_ANALYSIS' THEN 'd0bc1ee256776f2e3dce7805fb6b347f269d01f4b536ec31b198764160d5e0d7'
    WHEN 'CALCULATION_SET' THEN 'e3a9838f0a594997c91c0b810bc932af0e6d9a71dc70fd9f666a017be860dec7'
    WHEN 'FINDINGS_DRAFT' THEN '0723d31f4cc55456b6797124a5458c651d4b5ed249478d51db262b7bf682226c'
    WHEN 'REPORT_DRAFT' THEN '7ded76258d441047817393aac95204b1d96dd0174943819164336bb7a6a7ef4d'
    WHEN 'SCHEMA_REVIEW_REPORT' THEN '15c4a57f99f8295da18ed167e22a19233c30d601ac92fb76b5fc44ed9bb9cb31'
    WHEN 'NUMERIC_REVIEW_REPORT' THEN 'db23ca9ec8a9367fe51ad68d41a557ae3ba6c81988917bbcf2167036e7bf287f'
    WHEN 'SOURCE_REVIEW_REPORT' THEN 'a1b3c19cb5b5d17ca2a5443b0a6cfc4670dbd2fbc4839e12ace4bb75c27991f2'
    WHEN 'RED_TEAM_REVIEW_REPORT' THEN 'dc2d911a3b95da9fe0a5e3d0ef555b5265688acd818c51f7ef9cc9d3a91c015b'
    WHEN 'CORRECTED_REPORT' THEN 'f2faf61bc9933ef62146732e328f43e58e8905fd5732f0797ab165dc5f917be7'
    WHEN 'CORRECTION_MANIFEST' THEN '7a2979ea267d66ba314d5bc6e65f7c5f244bc995e69b79d43e54058dd615c61f'
    ELSE NULL
  END
$$;

CREATE FUNCTION "expected_ai_workflow_result_contract_hash"(p_job_code TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_job_code
    WHEN 'DOCUMENT_INGESTION' THEN '66e22e704b466528b5126ac8cfb036ee149c243dd47552d2aa239f5cf246f7dc'
    WHEN 'DOCUMENT_CLASSIFICATION' THEN '95b86089dee6d95c19ee750303d23f364c8084141758b2f5a6e69e45842d5436'
    WHEN 'EVIDENCE_EXTRACTION' THEN '56c2ed40a940cdd67e985b5dc6ec25fc296b59668fc19827587bba6a46727adf'
    WHEN 'FINANCIAL_ANALYSIS' THEN '1df27c1fa695441fc3ea01e14545f0d7737fb1731751f70d708e569ead67f257'
    WHEN 'CREDIT_ANALYSIS' THEN '85bed60b5b3a870b946dd05812e080daa9adfed7e4fa865855337132dccbbc85'
    WHEN 'CALCULATIONS' THEN 'fa3128a00a1c8a6bf72ee123c451fab7401bd20cf5725f9994ffb70c4766f715'
    WHEN 'FINDINGS_DRAFTING' THEN '690021734044efcea13386d18ffe7cc4cd34e967eed85a132e8c235b77185080'
    WHEN 'REPORT_COMPOSITION' THEN 'd6e44c44888c4084b586c8564c65afdb8b57a58b8188875cdf47cbc1cbda539a'
    WHEN 'SCHEMA_REVIEW' THEN '3940b10c0f92467be74e3c7af09b60e64598d42721bdc9c5e1ec18c24fa6d720'
    WHEN 'NUMERIC_REVIEW' THEN '049c432e941acd9df112db846fe03d9409519272de884ab2f784385aac14d18d'
    WHEN 'SOURCE_REVIEW' THEN '36ec82dc515cd89b3ef446d27b22cc1c1f498a8250d46d982cfb48563830f14f'
    WHEN 'RED_TEAM_REVIEW' THEN '67a509ef2dbcb9d230bf72af842f2661e80ce594c3cb26ed6cd16d3dcf16a05b'
    WHEN 'CORRECTION' THEN '0a46f23dd0ff72a4ac453d05b58ec3d0b407879ec24b3aa04dc1bd80b346833b'
    ELSE NULL
  END
$$;

-- PostgreSQL mirror of the generic JSON envelope limits applied by
-- validateAiResultJsonValue. Exact v1 payload shapes are checked separately
-- below so a raw SQL writer cannot claim a canonical schema digest for a
-- payload that the strict TypeScript/Zod contract would reject.
CREATE FUNCTION "assert_ai_workflow_result_json_policy"(p_value JSONB)
RETURNS VOID LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE
  node_count INTEGER;
  maximum_depth INTEGER;
  maximum_string_bytes INTEGER;
  canonical TEXT;
BEGIN
  WITH RECURSIVE json_walk(value, depth) AS (
    SELECT p_value, 1
    UNION ALL
    SELECT child.value, parent.depth + 1
    FROM json_walk parent
    CROSS JOIN LATERAL (
      SELECT array_item.value
      FROM JSONB_ARRAY_ELEMENTS(
        CASE WHEN JSONB_TYPEOF(parent.value) = 'array' THEN parent.value ELSE '[]'::JSONB END
      ) array_item(value)
      UNION ALL
      SELECT object_item.value
      FROM JSONB_EACH(
        CASE WHEN JSONB_TYPEOF(parent.value) = 'object' THEN parent.value ELSE '{}'::JSONB END
      ) object_item(key, value)
    ) child
  )
  SELECT
    COUNT(*)::INTEGER,
    COALESCE(MAX(depth), 0)::INTEGER,
    COALESCE(MAX(
      CASE WHEN JSONB_TYPEOF(value) = 'string'
        THEN OCTET_LENGTH(value #>> '{}') ELSE 0 END
    ), 0)::INTEGER
  INTO node_count, maximum_depth, maximum_string_bytes
  FROM json_walk;

  IF node_count > 512 OR maximum_depth > 8 OR maximum_string_bytes > 4096 THEN
    RAISE EXCEPTION 'AI result JSON depth, node or string limit exceeded';
  END IF;
  IF EXISTS (
    WITH RECURSIVE json_walk(value) AS (
      SELECT p_value
      UNION ALL
      SELECT child.value
      FROM json_walk parent
      CROSS JOIN LATERAL (
        SELECT array_item.value
        FROM JSONB_ARRAY_ELEMENTS(
          CASE WHEN JSONB_TYPEOF(parent.value) = 'array' THEN parent.value ELSE '[]'::JSONB END
        ) array_item(value)
        UNION ALL
        SELECT object_item.value
        FROM JSONB_EACH(
          CASE WHEN JSONB_TYPEOF(parent.value) = 'object' THEN parent.value ELSE '{}'::JSONB END
        ) object_item(key, value)
      ) child
    )
    SELECT 1
    FROM json_walk parent
    CROSS JOIN LATERAL JSONB_OBJECT_KEYS(
      CASE WHEN JSONB_TYPEOF(parent.value) = 'object' THEN parent.value ELSE '{}'::JSONB END
    ) object_key
    WHERE OCTET_LENGTH(object_key) > 4096
  ) THEN RAISE EXCEPTION 'AI result JSON object key exceeds the string limit'; END IF;
  IF EXISTS (
    WITH RECURSIVE json_walk(value) AS (
      SELECT p_value
      UNION ALL
      SELECT child.value
      FROM json_walk parent
      CROSS JOIN LATERAL (
        SELECT array_item.value
        FROM JSONB_ARRAY_ELEMENTS(
          CASE WHEN JSONB_TYPEOF(parent.value) = 'array' THEN parent.value ELSE '[]'::JSONB END
        ) array_item(value)
        UNION ALL
        SELECT object_item.value
        FROM JSONB_EACH(
          CASE WHEN JSONB_TYPEOF(parent.value) = 'object' THEN parent.value ELSE '{}'::JSONB END
        ) object_item(key, value)
      ) child
    )
    SELECT 1 FROM json_walk
    WHERE JSONB_TYPEOF(value) = 'number'
      AND ABS((value #>> '{}')::NUMERIC) > 9007199254740991
  ) THEN RAISE EXCEPTION 'AI result JSON contains a number outside the safe range'; END IF;

  canonical := "canonicalize_ai_result_jsonb_v1"(p_value);
  IF canonical ~* '(<\/?[a-z][^>]*>|https?://|file://|(^|[^[:alnum:]_])(prompt|secret|password|token|api[_-]?key|crm real|cliente reale)([^[:alnum:]_]|$))' THEN
    RAISE EXCEPTION 'AI result JSON contains forbidden content';
  END IF;
  IF p_value -> 'synthetic' IS DISTINCT FROM 'true'::JSONB THEN
    RAISE EXCEPTION 'AI result JSON must be explicitly synthetic';
  END IF;
END $$;

CREATE FUNCTION "assert_ai_result_exact_object_keys_v1"(
  p_value JSONB,
  p_expected TEXT[]
)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  actual_keys TEXT[];
  expected_keys TEXT[];
BEGIN
  IF JSONB_TYPEOF(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'AI result payload schema requires an object';
  END IF;
  SELECT COALESCE(
    ARRAY_AGG(object_key ORDER BY object_key COLLATE "C"),
    ARRAY[]::TEXT[]
  ) INTO actual_keys
  FROM JSONB_OBJECT_KEYS(p_value) AS object_keys(object_key);
  SELECT COALESCE(
    ARRAY_AGG(expected_key ORDER BY expected_key COLLATE "C"),
    ARRAY[]::TEXT[]
  ) INTO expected_keys
  FROM UNNEST(p_expected) AS expected_keys(expected_key);
  IF actual_keys IS DISTINCT FROM expected_keys THEN
    RAISE EXCEPTION 'AI result payload schema keys mismatch';
  END IF;
END $$;

CREATE FUNCTION "assert_ai_result_string_array_v1"(
  p_value JSONB,
  p_max_items INTEGER
)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN
  IF JSONB_TYPEOF(p_value) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'AI result payload schema requires a string array';
  END IF;
  IF JSONB_ARRAY_LENGTH(p_value) > p_max_items OR EXISTS (
    SELECT 1 FROM JSONB_ARRAY_ELEMENTS(p_value) item(value)
    WHERE JSONB_TYPEOF(item.value) IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION 'AI result payload string array shape or cardinality mismatch';
  END IF;
END $$;

CREATE FUNCTION "assert_ai_result_code_value_array_v1"(
  p_value JSONB,
  p_max_items INTEGER
)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  item JSONB;
BEGIN
  IF JSONB_TYPEOF(p_value) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'AI result payload schema requires a code/value array';
  END IF;
  IF JSONB_ARRAY_LENGTH(p_value) > p_max_items THEN
    RAISE EXCEPTION 'AI result payload code/value array cardinality mismatch';
  END IF;
  FOR item IN SELECT value FROM JSONB_ARRAY_ELEMENTS(p_value) entries(value) LOOP
    PERFORM "assert_ai_result_exact_object_keys_v1"(item, ARRAY['code', 'value']);
    IF JSONB_TYPEOF(item -> 'code') IS DISTINCT FROM 'string'
      OR JSONB_TYPEOF(item -> 'value') IS DISTINCT FROM 'number'
    THEN
      RAISE EXCEPTION 'AI result payload code/value item shape mismatch';
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION "assert_ai_workflow_artifact_payload_shape"(
  p_artifact_type TEXT,
  p_value JSONB
)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  item JSONB;
  numeric_value NUMERIC;
BEGIN
  IF JSONB_TYPEOF(p_value) IS DISTINCT FROM 'object'
    OR p_value -> 'synthetic' IS DISTINCT FROM 'true'::JSONB
    OR JSONB_TYPEOF(p_value -> 'summary') IS DISTINCT FROM 'string'
  THEN
    RAISE EXCEPTION 'AI result artifact base payload shape mismatch';
  END IF;

  CASE p_artifact_type
    WHEN 'DOCUMENT_MANIFEST' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value, ARRAY['synthetic', 'summary', 'documentCount']
      );
      IF JSONB_TYPEOF(p_value -> 'documentCount') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'DOCUMENT_MANIFEST documentCount must be an integer';
      END IF;
      numeric_value := (p_value ->> 'documentCount')::NUMERIC;
      IF numeric_value <> TRUNC(numeric_value) OR numeric_value < 0 OR numeric_value > 100 THEN
        RAISE EXCEPTION 'DOCUMENT_MANIFEST documentCount is outside 0..100';
      END IF;
    WHEN 'DOCUMENT_CLASSIFICATION' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value, ARRAY['synthetic', 'summary', 'classes']
      );
      PERFORM "assert_ai_result_string_array_v1"(p_value -> 'classes', 16);
    WHEN 'EVIDENCE_SET' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value, ARRAY['synthetic', 'summary', 'evidenceItems']
      );
      PERFORM "assert_ai_result_string_array_v1"(p_value -> 'evidenceItems', 64);
    WHEN 'FINANCIAL_ANALYSIS' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value, ARRAY['synthetic', 'summary', 'indicators']
      );
      PERFORM "assert_ai_result_code_value_array_v1"(p_value -> 'indicators', 32);
    WHEN 'CREDIT_ANALYSIS' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value, ARRAY['synthetic', 'summary', 'rating', 'confidence']
      );
      IF JSONB_TYPEOF(p_value -> 'rating') IS DISTINCT FROM 'string'
        OR JSONB_TYPEOF(p_value -> 'confidence') IS DISTINCT FROM 'number'
      THEN
        RAISE EXCEPTION 'CREDIT_ANALYSIS rating/confidence shape mismatch';
      END IF;
      numeric_value := (p_value ->> 'confidence')::NUMERIC;
      IF numeric_value < 0 OR numeric_value > 1 THEN
        RAISE EXCEPTION 'CREDIT_ANALYSIS confidence is outside 0..1';
      END IF;
    WHEN 'CALCULATION_SET' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value, ARRAY['synthetic', 'summary', 'calculations']
      );
      PERFORM "assert_ai_result_code_value_array_v1"(p_value -> 'calculations', 64);
    WHEN 'FINDINGS_DRAFT' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value, ARRAY['synthetic', 'summary', 'findings']
      );
      PERFORM "assert_ai_result_string_array_v1"(p_value -> 'findings', 32);
    WHEN 'REPORT_DRAFT' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value, ARRAY['synthetic', 'summary', 'sections']
      );
      PERFORM "assert_ai_result_string_array_v1"(p_value -> 'sections', 32);
    WHEN 'SCHEMA_REVIEW_REPORT', 'NUMERIC_REVIEW_REPORT',
      'SOURCE_REVIEW_REPORT', 'RED_TEAM_REVIEW_REPORT' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value, ARRAY['synthetic', 'summary', 'passed', 'issues']
      );
      IF JSONB_TYPEOF(p_value -> 'passed') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'AI review artifact passed must be boolean';
      END IF;
      PERFORM "assert_ai_result_string_array_v1"(p_value -> 'issues', 16);
    WHEN 'CORRECTED_REPORT' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value, ARRAY['synthetic', 'summary', 'correctedSections']
      );
      PERFORM "assert_ai_result_string_array_v1"(p_value -> 'correctedSections', 32);
    WHEN 'CORRECTION_MANIFEST' THEN
      PERFORM "assert_ai_result_exact_object_keys_v1"(
        p_value,
        ARRAY['synthetic', 'summary', 'correctionReasons', 'supersededArtifactHashes']
      );
      PERFORM "assert_ai_result_string_array_v1"(p_value -> 'correctionReasons', 32);
      IF JSONB_TYPEOF(p_value -> 'supersededArtifactHashes') IS DISTINCT FROM 'array'
        OR JSONB_ARRAY_LENGTH(p_value -> 'supersededArtifactHashes') > 16
      THEN
        RAISE EXCEPTION 'CORRECTION_MANIFEST superseded hashes shape mismatch';
      END IF;
      FOR item IN SELECT value
        FROM JSONB_ARRAY_ELEMENTS(p_value -> 'supersededArtifactHashes') entries(value)
      LOOP
        IF JSONB_TYPEOF(item) IS DISTINCT FROM 'string'
          OR (item #>> '{}') !~ '^[0-9a-f]{64}$'
        THEN
          RAISE EXCEPTION 'CORRECTION_MANIFEST contains an invalid artifact hash';
        END IF;
      END LOOP;
    ELSE
      RAISE EXCEPTION 'Unknown AI result artifact payload schema %', p_artifact_type;
  END CASE;
END $$;

CREATE FUNCTION "assert_ai_workflow_result_payload_shape"(
  p_job_code TEXT,
  p_value JSONB
)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  artifact_type TEXT;
BEGIN
  IF p_job_code = 'CORRECTION' THEN
    PERFORM "assert_ai_result_exact_object_keys_v1"(
      p_value,
      ARRAY['synthetic', 'summary', 'correctedReportHash', 'correctionManifestHash']
    );
    IF p_value -> 'synthetic' IS DISTINCT FROM 'true'::JSONB
      OR JSONB_TYPEOF(p_value -> 'summary') IS DISTINCT FROM 'string'
      OR JSONB_TYPEOF(p_value -> 'correctedReportHash') IS DISTINCT FROM 'string'
      OR (p_value ->> 'correctedReportHash') !~ '^[0-9a-f]{64}$'
      OR JSONB_TYPEOF(p_value -> 'correctionManifestHash') IS DISTINCT FROM 'string'
      OR (p_value ->> 'correctionManifestHash') !~ '^[0-9a-f]{64}$'
    THEN
      RAISE EXCEPTION 'CORRECTION result payload shape mismatch';
    END IF;
    RETURN;
  END IF;
  artifact_type := "expected_ai_workflow_result_artifact_type"(p_job_code, 0);
  IF artifact_type IS NULL THEN
    RAISE EXCEPTION 'Unknown AI result job payload schema %', p_job_code;
  END IF;
  PERFORM "assert_ai_workflow_artifact_payload_shape"(artifact_type, p_value);
END $$;

CREATE FUNCTION "validate_ai_workflow_job_result_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  runtime_row "AiWorkflowJobRuntime"%ROWTYPE;
  attempt_row "AiWorkflowJobAttempt"%ROWTYPE;
  job_row "AiWorkflowJob"%ROWTYPE;
BEGIN
  SELECT * INTO runtime_row FROM "AiWorkflowJobRuntime" WHERE "id" = NEW."runtimeId";
  SELECT * INTO attempt_row FROM "AiWorkflowJobAttempt" WHERE "id" = NEW."attemptId";
  SELECT * INTO job_row FROM "AiWorkflowJob" WHERE "id" = NEW."jobId";
  IF runtime_row."id" IS NULL OR attempt_row."id" IS NULL OR job_row."id" IS NULL THEN
    RAISE EXCEPTION 'AiWorkflowJobResult references missing runtime/job/attempt';
  END IF;
  IF runtime_row."jobId" IS DISTINCT FROM NEW."jobId"
    OR attempt_row."runtimeId" IS DISTINCT FROM NEW."runtimeId"
    OR attempt_row."jobId" IS DISTINCT FROM NEW."jobId"
  THEN RAISE EXCEPTION 'AiWorkflowJobResult runtime/job/attempt mismatch'; END IF;
  IF attempt_row."attemptSequence" IS DISTINCT FROM NEW."attemptSequence"
    OR attempt_row."fencingToken" IS DISTINCT FROM NEW."fencingToken"
    OR attempt_row."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId"
    OR attempt_row."workerBuildHash" IS DISTINCT FROM NEW."workerBuildHash"
    OR attempt_row."runtimePolicyHash" IS DISTINCT FROM NEW."runtimePolicyHash"
    OR attempt_row."capabilityHash" IS DISTINCT FROM NEW."capabilityHash"
    OR attempt_row."handlerCode" IS DISTINCT FROM NEW."handlerCode"
    OR attempt_row."handlerVersion" IS DISTINCT FROM NEW."handlerVersion"
    OR attempt_row."workflowDefinitionHash" IS DISTINCT FROM NEW."workflowDefinitionHash"
    OR attempt_row."phaseCode" IS DISTINCT FROM NEW."phaseCode"
    OR attempt_row."phaseEntrySequence" IS DISTINCT FROM NEW."phaseEntrySequence"
    OR attempt_row."correctionCycle" IS DISTINCT FROM NEW."correctionCycle"
    OR attempt_row."executorAgentId" IS DISTINCT FROM NEW."executorAgentId"
    OR attempt_row."executorAgentConfigVersion" IS DISTINCT FROM NEW."executorAgentConfigVersion"
    OR attempt_row."executorAgentConfigHash" IS DISTINCT FROM NEW."executorAgentConfigHash"
    OR attempt_row."jobPayloadHash" IS DISTINCT FROM NEW."jobPayloadHash"
  THEN RAISE EXCEPTION 'AiWorkflowJobResult attempt provenance mismatch'; END IF;
  IF runtime_row."runtimePolicyHash" IS DISTINCT FROM NEW."runtimePolicyHash"
    OR runtime_row."capabilityCode" IS DISTINCT FROM NEW."capabilityCode"
    OR runtime_row."capabilityVersion" IS DISTINCT FROM NEW."capabilityVersion"
    OR runtime_row."capabilityHash" IS DISTINCT FROM NEW."capabilityHash"
    OR runtime_row."handlerCode" IS DISTINCT FROM NEW."handlerCode"
    OR runtime_row."handlerVersion" IS DISTINCT FROM NEW."handlerVersion"
  THEN RAISE EXCEPTION 'AiWorkflowJobResult runtime provenance mismatch'; END IF;
  IF job_row."payloadHash" IS DISTINCT FROM NEW."jobPayloadHash"
    OR job_row."workflowDefinitionHash" IS DISTINCT FROM NEW."workflowDefinitionHash"
    OR job_row."phaseCode" IS DISTINCT FROM NEW."phaseCode"
    OR job_row."phaseEntrySequence" IS DISTINCT FROM NEW."phaseEntrySequence"
    OR job_row."correctionCycle" IS DISTINCT FROM NEW."correctionCycle"
    OR job_row."executorAgentId" IS DISTINCT FROM NEW."executorAgentId"
    OR job_row."executorAgentCode" IS DISTINCT FROM NEW."executorAgentCode"
    OR job_row."executorAgentConfigVersion" IS DISTINCT FROM NEW."executorAgentConfigVersion"
    OR job_row."executorAgentConfigHash" IS DISTINCT FROM NEW."executorAgentConfigHash"
  THEN RAISE EXCEPTION 'AiWorkflowJobResult job provenance mismatch'; END IF;
  IF NEW."workflowInstanceId" IS DISTINCT FROM runtime_row."workflowInstanceId"
    OR NEW."workflowInstanceId" IS DISTINCT FROM job_row."workflowInstanceId"
  THEN RAISE EXCEPTION 'AiWorkflowJobResult workflow mismatch'; END IF;
  IF NEW."resultContractCode" IS DISTINCT FROM 'FAI_AUDIT_' || job_row."jobCode" || '_RESULT'
    OR NEW."resultContractHash" IS DISTINCT FROM
      "expected_ai_workflow_result_contract_hash"(job_row."jobCode")
    OR "expected_ai_workflow_result_artifact_type"(job_row."jobCode", 0) IS NULL
    OR NEW."artifactCount" IS DISTINCT FROM
      (CASE WHEN job_row."jobCode" = 'CORRECTION' THEN 2 ELSE 1 END)
  THEN RAISE EXCEPTION 'AiWorkflowJobResult contract identity or cardinality mismatch'; END IF;
  IF NEW."payloadHash" IS DISTINCT FROM "ai_result_artifact_canonical_hash"('ai.payload.v1', NEW."payload") THEN
    RAISE EXCEPTION 'AiWorkflowJobResult payloadHash mismatch';
  END IF;
  PERFORM "assert_ai_workflow_result_json_policy"(NEW."payload");
  PERFORM "assert_ai_workflow_result_payload_shape"(job_row."jobCode", NEW."payload");
  IF NEW."retentionPolicyHash" IS DISTINCT FROM "ai_result_artifact_canonical_json_hash"(
    JSONB_BUILD_OBJECT(
      'domain', 'ai.retentionPolicy.v1',
      'policyCode', NEW."retentionPolicyCode",
      'policyVersion', NEW."retentionPolicyVersion",
      'retentionClass', NEW."retentionClass",
      'retainUntil', CASE WHEN NEW."retainUntil" IS NULL THEN NULL
        ELSE TO_JSONB(TO_CHAR(NEW."retainUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END
    )
  ) THEN RAISE EXCEPTION 'AiWorkflowJobResult retentionPolicyHash mismatch'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "validate_ai_workflow_job_artifact_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  result_row "AiWorkflowJobResult"%ROWTYPE;
  job_row "AiWorkflowJob"%ROWTYPE;
  target_attempt "AiWorkflowJobAttempt"%ROWTYPE;
  source_row "AiWorkflowJobArtifact"%ROWTYPE;
  source_result "AiWorkflowJobResult"%ROWTYPE;
  source_runtime "AiWorkflowJobRuntime"%ROWTYPE;
BEGIN
  SELECT * INTO result_row FROM "AiWorkflowJobResult" WHERE "id" = NEW."resultId";
  IF result_row."id" IS NULL THEN RAISE EXCEPTION 'AiWorkflowJobArtifact result missing'; END IF;
  SELECT * INTO job_row FROM "AiWorkflowJob" WHERE "id" = result_row."jobId";
  IF job_row."id" IS NULL
    OR result_row."artifactCount" <= NEW."ordinal"
    OR NEW."artifactType" IS DISTINCT FROM
      "expected_ai_workflow_result_artifact_type"(job_row."jobCode", NEW."ordinal")
    OR NEW."slotCode" IS DISTINCT FROM NEW."artifactType"
    OR NEW."artifactSchemaCode" IS DISTINCT FROM NEW."artifactType" || '_SCHEMA'
    OR NEW."artifactSchemaHash" IS DISTINCT FROM
      "expected_ai_workflow_artifact_schema_hash"(NEW."artifactType")
    OR NEW."createdAt" IS DISTINCT FROM result_row."createdAt"
  THEN RAISE EXCEPTION 'AiWorkflowJobArtifact contract, ordinal or timestamp mismatch'; END IF;
  IF NEW."payloadHash" IS DISTINCT FROM "ai_result_artifact_canonical_hash"('ai.payload.v1', NEW."payload") THEN
    RAISE EXCEPTION 'AiWorkflowJobArtifact payloadHash mismatch';
  END IF;
  PERFORM "assert_ai_workflow_result_json_policy"(NEW."payload");
  PERFORM "assert_ai_workflow_artifact_payload_shape"(NEW."artifactType", NEW."payload");
  IF NEW."payloadBytes" IS DISTINCT FROM OCTET_LENGTH(
    CONVERT_TO("canonicalize_ai_result_jsonb_v1"(NEW."payload"), 'UTF8')
  ) THEN RAISE EXCEPTION 'AiWorkflowJobArtifact payloadBytes mismatch'; END IF;
  IF NEW."artifactHash" IS DISTINCT FROM "ai_result_artifact_canonical_json_hash"(
    JSONB_BUILD_OBJECT(
      'domain', 'ai.artifact.v1',
      'artifactType', NEW."artifactType",
      'ordinal', NEW."ordinal",
      'slotCode', NEW."slotCode",
      'logicalKey', NEW."logicalKey",
      'artifactVersion', NEW."artifactVersion",
      'mediaType', NEW."mediaType",
      'artifactSchemaHash', NEW."artifactSchemaHash",
      'payloadHash', NEW."payloadHash",
      'supersedesArtifactId', NEW."supersedesArtifactId"
    )
  ) THEN RAISE EXCEPTION 'AiWorkflowJobArtifact artifactHash mismatch'; END IF;

  IF NEW."supersedesArtifactId" IS NOT NULL THEN
    SELECT * INTO source_row FROM "AiWorkflowJobArtifact"
      WHERE "id" = NEW."supersedesArtifactId";
    SELECT * INTO source_result FROM "AiWorkflowJobResult"
      WHERE "id" = source_row."resultId";
    SELECT * INTO source_runtime FROM "AiWorkflowJobRuntime"
      WHERE "id" = source_result."runtimeId";
    SELECT * INTO target_attempt FROM "AiWorkflowJobAttempt"
      WHERE "id" = result_row."attemptId";
    IF job_row."jobCode" IS DISTINCT FROM 'CORRECTION'
      OR NEW."artifactType" IS DISTINCT FROM 'CORRECTED_REPORT'
      OR source_row."id" IS NULL
      OR source_result."id" IS NULL
      OR source_runtime."id" IS NULL
      OR target_attempt."id" IS NULL
      OR source_row."id" IS NOT DISTINCT FROM NEW."id"
      OR source_result."id" IS NOT DISTINCT FROM result_row."id"
      OR source_result."workflowInstanceId" IS DISTINCT FROM result_row."workflowInstanceId"
      OR source_result."correctionCycle" IS DISTINCT FROM result_row."correctionCycle" - 1
      OR NOT (
        (result_row."correctionCycle" = 1 AND source_row."artifactType" = 'REPORT_DRAFT')
        OR (
          result_row."correctionCycle" > 1
          AND source_row."artifactType" = 'CORRECTED_REPORT'
        )
      )
      OR source_runtime."state" IS DISTINCT FROM 'SUCCEEDED'
      OR source_runtime."resultHash" IS DISTINCT FROM source_result."resultHash"
      OR source_runtime."terminalAt" IS NULL
      OR source_runtime."terminalAt" >= target_attempt."claimedAt"
      OR source_row."createdAt" IS DISTINCT FROM source_result."createdAt"
    THEN RAISE EXCEPTION 'AiWorkflowJobArtifact supersession is not causal or compatible'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "validate_ai_workflow_job_source_artifact_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_row "AiWorkflowJobArtifact"%ROWTYPE;
  source_result "AiWorkflowJobResult"%ROWTYPE;
  source_runtime "AiWorkflowJobRuntime"%ROWTYPE;
  target_result "AiWorkflowJobResult"%ROWTYPE;
  target_attempt "AiWorkflowJobAttempt"%ROWTYPE;
BEGIN
  SELECT * INTO source_row FROM "AiWorkflowJobArtifact" WHERE "id" = NEW."sourceArtifactId";
  SELECT * INTO target_result FROM "AiWorkflowJobResult" WHERE "id" = NEW."resultId";
  IF source_row."id" IS NULL OR target_result."id" IS NULL THEN RAISE EXCEPTION 'AiWorkflowJobSourceArtifact missing source or result'; END IF;
  SELECT * INTO source_result FROM "AiWorkflowJobResult" WHERE "id" = source_row."resultId";
  SELECT * INTO source_runtime FROM "AiWorkflowJobRuntime" WHERE "id" = source_result."runtimeId";
  SELECT * INTO target_attempt FROM "AiWorkflowJobAttempt" WHERE "id" = target_result."attemptId";
  IF source_result."id" IS NULL OR source_runtime."id" IS NULL OR target_attempt."id" IS NULL THEN
    RAISE EXCEPTION 'AiWorkflowJobSourceArtifact missing causal result/runtime/attempt';
  END IF;
  IF source_row."artifactHash" IS DISTINCT FROM NEW."sourceArtifactHash" THEN
    RAISE EXCEPTION 'AiWorkflowJobSourceArtifact source hash mismatch';
  END IF;
  IF source_result."workflowInstanceId" IS DISTINCT FROM target_result."workflowInstanceId" THEN
    RAISE EXCEPTION 'AiWorkflowJobSourceArtifact cross-workflow lineage forbidden';
  END IF;
  IF source_result."id" IS NOT DISTINCT FROM target_result."id"
    OR source_runtime."state" IS DISTINCT FROM 'SUCCEEDED'
    OR source_runtime."resultHash" IS DISTINCT FROM source_result."resultHash"
    OR source_runtime."terminalAt" IS NULL
    OR source_runtime."terminalAt" >= target_attempt."claimedAt"
    OR source_result."correctionCycle" > target_result."correctionCycle"
    OR source_row."createdAt" IS DISTINCT FROM source_result."createdAt"
    OR NEW."createdAt" IS DISTINCT FROM target_result."createdAt"
  THEN RAISE EXCEPTION 'AiWorkflowJobSourceArtifact causal self/future reference forbidden'; END IF;
  IF NEW."role" = 'SUPERSEDED' AND NOT EXISTS (
    SELECT 1
    FROM "AiWorkflowJobArtifact" current_artifact
    WHERE current_artifact."resultId" = NEW."resultId"
      AND current_artifact."supersedesArtifactId" = NEW."sourceArtifactId"
  ) THEN RAISE EXCEPTION 'SUPERSEDED source must match an artifact supersession edge'; END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER "AiWorkflowJobResult_validate_insert" AFTER INSERT ON "AiWorkflowJobResult" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_result_insert"();
CREATE CONSTRAINT TRIGGER "AiWorkflowJobArtifact_validate_insert" AFTER INSERT ON "AiWorkflowJobArtifact" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_artifact_insert"();
CREATE CONSTRAINT TRIGGER "AiWorkflowJobSourceArtifact_validate_insert" AFTER INSERT ON "AiWorkflowJobSourceArtifact" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_ai_workflow_job_source_artifact_insert"();


CREATE FUNCTION "assert_ai_workflow_result_final_consistency"(p_runtime_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  runtime_row "AiWorkflowJobRuntime"%ROWTYPE;
  attempt_row "AiWorkflowJobAttempt"%ROWTYPE;
  result_row "AiWorkflowJobResult"%ROWTYPE;
  job_row "AiWorkflowJob"%ROWTYPE;
  result_count INTEGER;
  artifact_count INTEGER;
  source_count INTEGER;
  artifact_bytes INTEGER;
  result_payload_bytes INTEGER;
  succeeded_attempt_count INTEGER;
  succeeded_event_count INTEGER;
  expected_artifact_count INTEGER;
  artifact_hashes JSONB;
  source_references JSONB;
  retention JSONB;
  expected_manifest_hash TEXT;
  expected_result_hash TEXT;
  corrected_report_hash TEXT;
  correction_manifest_hash TEXT;
  declared_superseded_hashes JSONB;
  actual_superseded_hashes JSONB;
BEGIN
  SELECT * INTO runtime_row
  FROM "AiWorkflowJobRuntime"
  WHERE "id" = p_runtime_id;
  IF runtime_row."id" IS NULL THEN
    RAISE EXCEPTION 'AiWorkflow result consistency references missing runtime %', p_runtime_id;
  END IF;

  SELECT COUNT(*)::INTEGER INTO result_count
  FROM "AiWorkflowJobResult"
  WHERE "runtimeId" = p_runtime_id;

  -- Results may be staged while a completion transaction is in progress, but
  -- the deferred final state must be all-or-nothing: no result on a non-success
  -- runtime, and exactly one result on a successful runtime.
  IF runtime_row."state" IS DISTINCT FROM 'SUCCEEDED' THEN
    IF result_count <> 0 THEN
      RAISE EXCEPTION 'Non-SUCCEEDED runtime cannot retain an AiWorkflowJobResult';
    END IF;
    RETURN;
  END IF;
  IF result_count <> 1 THEN
    RAISE EXCEPTION 'SUCCEEDED runtime requires exactly one canonical result';
  END IF;

  SELECT * INTO result_row
  FROM "AiWorkflowJobResult"
  WHERE "runtimeId" = p_runtime_id;
  SELECT * INTO attempt_row
  FROM "AiWorkflowJobAttempt"
  WHERE "id" = result_row."attemptId";
  SELECT * INTO job_row
  FROM "AiWorkflowJob"
  WHERE "id" = runtime_row."jobId";

  SELECT COUNT(*)::INTEGER INTO succeeded_attempt_count
  FROM "AiWorkflowJobAttempt"
  WHERE "runtimeId" = p_runtime_id AND "outcome" = 'SUCCEEDED';

  IF attempt_row."id" IS NULL OR job_row."id" IS NULL
    OR succeeded_attempt_count <> 1
    OR result_row."runtimeId" IS DISTINCT FROM runtime_row."id"
    OR result_row."jobId" IS DISTINCT FROM runtime_row."jobId"
    OR result_row."workflowInstanceId" IS DISTINCT FROM runtime_row."workflowInstanceId"
    OR result_row."resultHash" IS DISTINCT FROM runtime_row."resultHash"
    OR result_row."attemptSequence" IS DISTINCT FROM runtime_row."attemptSequence"
    OR result_row."fencingToken" IS DISTINCT FROM runtime_row."fencingToken"
    OR attempt_row."runtimeId" IS DISTINCT FROM runtime_row."id"
    OR attempt_row."jobId" IS DISTINCT FROM runtime_row."jobId"
    OR attempt_row."attemptSequence" IS DISTINCT FROM runtime_row."attemptSequence"
    OR attempt_row."fencingToken" IS DISTINCT FROM runtime_row."fencingToken"
    OR attempt_row."outcome" IS DISTINCT FROM 'SUCCEEDED'
    OR attempt_row."resultHash" IS DISTINCT FROM result_row."resultHash"
    OR attempt_row."finishedAt" IS DISTINCT FROM runtime_row."terminalAt"
    OR attempt_row."workerInstanceId" IS DISTINCT FROM result_row."workerInstanceId"
    OR attempt_row."workerBuildHash" IS DISTINCT FROM result_row."workerBuildHash"
    OR attempt_row."runtimePolicyHash" IS DISTINCT FROM result_row."runtimePolicyHash"
    OR attempt_row."capabilityHash" IS DISTINCT FROM result_row."capabilityHash"
    OR attempt_row."handlerCode" IS DISTINCT FROM result_row."handlerCode"
    OR attempt_row."handlerVersion" IS DISTINCT FROM result_row."handlerVersion"
    OR runtime_row."runtimePolicyHash" IS DISTINCT FROM result_row."runtimePolicyHash"
    OR runtime_row."capabilityCode" IS DISTINCT FROM result_row."capabilityCode"
    OR runtime_row."capabilityVersion" IS DISTINCT FROM result_row."capabilityVersion"
    OR runtime_row."capabilityHash" IS DISTINCT FROM result_row."capabilityHash"
    OR runtime_row."handlerCode" IS DISTINCT FROM result_row."handlerCode"
    OR runtime_row."handlerVersion" IS DISTINCT FROM result_row."handlerVersion"
    OR result_row."createdAt" < attempt_row."claimedAt"
    OR result_row."createdAt" > attempt_row."finishedAt"
  THEN RAISE EXCEPTION 'SUCCEEDED runtime/attempt/result identity or fencing mismatch'; END IF;

  IF job_row."workflowInstanceId" IS DISTINCT FROM result_row."workflowInstanceId"
    OR job_row."payloadHash" IS DISTINCT FROM result_row."jobPayloadHash"
    OR job_row."workflowDefinitionHash" IS DISTINCT FROM result_row."workflowDefinitionHash"
    OR job_row."phaseCode" IS DISTINCT FROM result_row."phaseCode"
    OR job_row."phaseEntrySequence" IS DISTINCT FROM result_row."phaseEntrySequence"
    OR job_row."correctionCycle" IS DISTINCT FROM result_row."correctionCycle"
    OR job_row."executorAgentId" IS DISTINCT FROM result_row."executorAgentId"
    OR job_row."executorAgentCode" IS DISTINCT FROM result_row."executorAgentCode"
    OR job_row."executorAgentConfigVersion" IS DISTINCT FROM result_row."executorAgentConfigVersion"
    OR job_row."executorAgentConfigHash" IS DISTINCT FROM result_row."executorAgentConfigHash"
    OR result_row."resultContractCode" IS DISTINCT FROM
      'FAI_AUDIT_' || job_row."jobCode" || '_RESULT'
    OR result_row."resultContractHash" IS DISTINCT FROM
      "expected_ai_workflow_result_contract_hash"(job_row."jobCode")
  THEN RAISE EXCEPTION 'AiWorkflowJobResult immutable job provenance mismatch'; END IF;

  expected_artifact_count := CASE WHEN job_row."jobCode" = 'CORRECTION' THEN 2 ELSE 1 END;
  SELECT
    COUNT(*)::INTEGER,
    COALESCE(SUM(artifact."payloadBytes"), 0)::INTEGER,
    COALESCE(
      JSONB_AGG(TO_JSONB(artifact."artifactHash") ORDER BY artifact."ordinal"),
      '[]'::JSONB
    )
  INTO artifact_count, artifact_bytes, artifact_hashes
  FROM "AiWorkflowJobArtifact" artifact
  WHERE artifact."resultId" = result_row."id";

  SELECT
    COUNT(*)::INTEGER,
    COALESCE(
      JSONB_AGG(
        JSONB_BUILD_OBJECT(
          'sourceArtifactId', source_ref."sourceArtifactId",
          'sourceArtifactHash', source_ref."sourceArtifactHash",
          'role', source_ref."role",
          'ordinal', source_ref."ordinal"
        ) ORDER BY source_ref."ordinal"
      ),
      '[]'::JSONB
    )
  INTO source_count, source_references
  FROM "AiWorkflowJobSourceArtifact" source_ref
  WHERE source_ref."resultId" = result_row."id";

  result_payload_bytes := OCTET_LENGTH(CONVERT_TO(
    "canonicalize_ai_result_jsonb_v1"(result_row."payload"), 'UTF8'
  ));
  IF artifact_count <> expected_artifact_count
    OR artifact_count <> result_row."artifactCount"
    OR EXISTS (
      SELECT 1
      FROM "AiWorkflowJobArtifact" artifact
      WHERE artifact."resultId" = result_row."id"
        AND (
          artifact."artifactType" IS DISTINCT FROM
            "expected_ai_workflow_result_artifact_type"(job_row."jobCode", artifact."ordinal")
          OR artifact."slotCode" IS DISTINCT FROM artifact."artifactType"
          OR artifact."artifactSchemaCode" IS DISTINCT FROM artifact."artifactType" || '_SCHEMA'
          OR artifact."artifactSchemaHash" IS DISTINCT FROM
            "expected_ai_workflow_artifact_schema_hash"(artifact."artifactType")
          OR artifact."createdAt" IS DISTINCT FROM result_row."createdAt"
        )
    )
    OR (
      job_row."jobCode" IS DISTINCT FROM 'CORRECTION'
      AND EXISTS (
        SELECT 1
        FROM "AiWorkflowJobArtifact" artifact
        WHERE artifact."resultId" = result_row."id"
          AND artifact."ordinal" = 0
          AND artifact."payload" IS DISTINCT FROM result_row."payload"
      )
    )
    OR result_row."totalPayloadBytes" IS DISTINCT FROM artifact_bytes + result_payload_bytes
    OR result_row."totalPayloadBytes" > 65536
  THEN RAISE EXCEPTION 'AiWorkflowJobResult artifact cardinality, bytes or contract mismatch'; END IF;

  IF EXISTS (
    SELECT 1 FROM GENERATE_SERIES(0, artifact_count - 1) expected_ordinal
    WHERE NOT EXISTS (
      SELECT 1 FROM "AiWorkflowJobArtifact" artifact
      WHERE artifact."resultId" = result_row."id"
        AND artifact."ordinal" = expected_ordinal
    )
  ) THEN RAISE EXCEPTION 'AiWorkflowJobArtifact ordinals are not contiguous'; END IF;
  IF source_count > 0 AND EXISTS (
    SELECT 1 FROM GENERATE_SERIES(0, source_count - 1) expected_ordinal
    WHERE NOT EXISTS (
      SELECT 1 FROM "AiWorkflowJobSourceArtifact" source_ref
      WHERE source_ref."resultId" = result_row."id"
        AND source_ref."ordinal" = expected_ordinal
    )
  ) THEN RAISE EXCEPTION 'AiWorkflowJobSourceArtifact ordinals are not contiguous'; END IF;
  IF EXISTS (
    SELECT 1 FROM "AiWorkflowJobSourceArtifact" source_ref
    WHERE source_ref."resultId" = result_row."id"
      AND source_ref."createdAt" IS DISTINCT FROM result_row."createdAt"
  ) THEN RAISE EXCEPTION 'AiWorkflowJobSourceArtifact was appended after completion'; END IF;
  IF EXISTS (
    SELECT 1
    FROM "AiWorkflowJobArtifact" current_artifact
    WHERE current_artifact."resultId" = result_row."id"
      AND current_artifact."supersedesArtifactId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "AiWorkflowJobSourceArtifact" source_ref
        WHERE source_ref."resultId" = result_row."id"
          AND source_ref."sourceArtifactId" = current_artifact."supersedesArtifactId"
          AND source_ref."role" = 'SUPERSEDED'
      )
  ) OR EXISTS (
    SELECT 1
    FROM "AiWorkflowJobSourceArtifact" source_ref
    WHERE source_ref."resultId" = result_row."id"
      AND source_ref."role" = 'SUPERSEDED'
      AND NOT EXISTS (
        SELECT 1
        FROM "AiWorkflowJobArtifact" current_artifact
        WHERE current_artifact."resultId" = result_row."id"
          AND current_artifact."supersedesArtifactId" = source_ref."sourceArtifactId"
      )
  ) THEN RAISE EXCEPTION 'Supersession edges and SUPERSEDED source references mismatch'; END IF;

  IF result_row."payloadHash" IS DISTINCT FROM
    "ai_result_artifact_canonical_hash"('ai.payload.v1', result_row."payload")
  THEN RAISE EXCEPTION 'AiWorkflowJobResult payloadHash mismatch at commit'; END IF;

  retention := JSONB_BUILD_OBJECT(
    'policyCode', result_row."retentionPolicyCode",
    'policyVersion', result_row."retentionPolicyVersion",
    'retentionClass', result_row."retentionClass",
    'retainUntil', CASE WHEN result_row."retainUntil" IS NULL THEN NULL
      ELSE TO_JSONB(TO_CHAR(result_row."retainUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END,
    'retentionPolicyHash', result_row."retentionPolicyHash"
  );
  expected_manifest_hash := "ai_result_artifact_canonical_json_hash"(
    JSONB_BUILD_OBJECT(
      'domain', 'ai.manifest.v1',
      'artifactHashes', artifact_hashes,
      'sourceReferences', source_references,
      'retention', retention
    )
  );
  IF result_row."manifestHash" IS DISTINCT FROM expected_manifest_hash THEN
    RAISE EXCEPTION 'AiWorkflowJobResult manifestHash aggregate mismatch';
  END IF;

  expected_result_hash := "ai_result_artifact_canonical_json_hash"(
    JSONB_BUILD_OBJECT(
      'domain', 'ai.result.v1',
      'provenance', JSONB_BUILD_OBJECT(
        'runtimeId', result_row."runtimeId",
        'jobId', result_row."jobId",
        'attemptId', result_row."attemptId",
        'attemptSequence', result_row."attemptSequence",
        'fencingToken', result_row."fencingToken"::TEXT,
        'workerInstanceId', result_row."workerInstanceId",
        'workerBuildHash', result_row."workerBuildHash",
        'runtimePolicyHash', result_row."runtimePolicyHash",
        'capabilityCode', result_row."capabilityCode",
        'capabilityVersion', result_row."capabilityVersion",
        'capabilityHash', result_row."capabilityHash",
        'handlerCode', result_row."handlerCode",
        'handlerVersion', result_row."handlerVersion",
        'jobPayloadHash', result_row."jobPayloadHash",
        'workflowInstanceId', result_row."workflowInstanceId",
        'workflowDefinitionHash', result_row."workflowDefinitionHash",
        'phaseCode', result_row."phaseCode",
        'phaseEntrySequence', result_row."phaseEntrySequence",
        'correctionCycle', result_row."correctionCycle",
        'executorAgentId', result_row."executorAgentId",
        'executorAgentCode', result_row."executorAgentCode",
        'executorAgentConfigVersion', result_row."executorAgentConfigVersion",
        'executorAgentConfigHash', result_row."executorAgentConfigHash",
        'provider', result_row."provider",
        'dataMode', result_row."dataMode"
      ),
      'resultContractHash', result_row."resultContractHash",
      'resultPayloadHash', result_row."payloadHash",
      'manifestHash', result_row."manifestHash",
      'artifactHashes', artifact_hashes,
      'sourceReferences', source_references
    )
  );
  IF result_row."resultHash" IS DISTINCT FROM expected_result_hash THEN
    RAISE EXCEPTION 'AiWorkflowJobResult resultHash aggregate mismatch';
  END IF;

  IF job_row."jobCode" = 'CORRECTION' THEN
    SELECT artifact."artifactHash" INTO corrected_report_hash
    FROM "AiWorkflowJobArtifact" artifact
    WHERE artifact."resultId" = result_row."id"
      AND artifact."artifactType" = 'CORRECTED_REPORT';
    SELECT artifact."artifactHash", artifact."payload" -> 'supersededArtifactHashes'
    INTO correction_manifest_hash, declared_superseded_hashes
    FROM "AiWorkflowJobArtifact" artifact
    WHERE artifact."resultId" = result_row."id"
      AND artifact."artifactType" = 'CORRECTION_MANIFEST';
    SELECT COALESCE(
      JSONB_AGG(TO_JSONB(superseded."artifactHash") ORDER BY current_artifact."ordinal")
        FILTER (WHERE current_artifact."supersedesArtifactId" IS NOT NULL),
      '[]'::JSONB
    ) INTO actual_superseded_hashes
    FROM "AiWorkflowJobArtifact" current_artifact
    LEFT JOIN "AiWorkflowJobArtifact" superseded
      ON superseded."id" = current_artifact."supersedesArtifactId"
    WHERE current_artifact."resultId" = result_row."id";
    IF result_row."payload" ->> 'correctedReportHash' IS DISTINCT FROM corrected_report_hash
      OR result_row."payload" ->> 'correctionManifestHash' IS DISTINCT FROM correction_manifest_hash
      OR declared_superseded_hashes IS DISTINCT FROM actual_superseded_hashes
    THEN RAISE EXCEPTION 'CORRECTION result/artifact/supersession hashes mismatch'; END IF;
  ELSIF EXISTS (
    SELECT 1 FROM "AiWorkflowJobArtifact" artifact
    WHERE artifact."resultId" = result_row."id"
      AND artifact."supersedesArtifactId" IS NOT NULL
  ) THEN RAISE EXCEPTION 'Only CORRECTION results may supersede artifacts'; END IF;

  SELECT COUNT(*)::INTEGER INTO succeeded_event_count
  FROM "AiWorkflowJobRuntimeEvent" event
  WHERE event."runtimeId" = runtime_row."id"
    AND event."jobId" = result_row."jobId"
    AND event."workflowInstanceId" = result_row."workflowInstanceId"
    AND event."eventType" = 'SUCCEEDED'
    AND event."attemptSequence" IS NOT DISTINCT FROM result_row."attemptSequence"
    AND event."fencingToken" IS NOT DISTINCT FROM result_row."fencingToken"
    AND event."reasonCode" IS NOT DISTINCT FROM 'SUCCEEDED'
    AND event."occurredAt" IS NOT DISTINCT FROM runtime_row."terminalAt"
    AND event."payload" = JSONB_BUILD_OBJECT(
      'schemaVersion', 1,
      'runtimePolicyHash', result_row."runtimePolicyHash",
      'resultHash', result_row."resultHash",
      'manifestHash', result_row."manifestHash",
      'resultId', result_row."id",
      'artifactCount', result_row."artifactCount",
      'provider', 'mock',
      'workflowTransitionApplied', false
    );
  IF succeeded_event_count <> 1 THEN
    RAISE EXCEPTION 'SUCCEEDED runtime event/result mismatch';
  END IF;
END $$;

-- A constraint trigger executes with the row type of its source table. Access
-- to NEW.runtimeId is therefore invalid for Artifact and SourceArtifact rows.
-- Resolve the runtime explicitly for every supported table, then run one
-- fail-closed final-state assertion.
CREATE FUNCTION "verify_ai_workflow_result_final_consistency"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  runtime_id TEXT;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'AiWorkflowJobRuntime' THEN runtime_id := NEW."id";
    WHEN 'AiWorkflowJobAttempt' THEN runtime_id := NEW."runtimeId";
    WHEN 'AiWorkflowJobRuntimeEvent' THEN runtime_id := NEW."runtimeId";
    WHEN 'AiWorkflowJobResult' THEN runtime_id := NEW."runtimeId";
    WHEN 'AiWorkflowJobArtifact' THEN
      SELECT result."runtimeId" INTO runtime_id
      FROM "AiWorkflowJobResult" result
      WHERE result."id" = NEW."resultId";
    WHEN 'AiWorkflowJobSourceArtifact' THEN
      SELECT result."runtimeId" INTO runtime_id
      FROM "AiWorkflowJobResult" result
      WHERE result."id" = NEW."resultId";
    ELSE
      RAISE EXCEPTION 'Unsupported result consistency trigger table %', TG_TABLE_NAME;
  END CASE;
  IF runtime_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve runtime for result consistency on %', TG_TABLE_NAME;
  END IF;
  PERFORM "assert_ai_workflow_result_final_consistency"(runtime_id);
  RETURN NULL;
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

COMMIT;
