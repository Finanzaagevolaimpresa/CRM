-- PR86 — corrective terminal lifecycle and exact, versioned execution-input hashing.
-- Additive only: no existing hash, fingerprint, ledger, grant, notification or run is rewritten.
BEGIN;

ALTER TABLE "AiExecutionRequest"
  ADD COLUMN "hashCanonicalizationVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "supersedesRequestId" TEXT;
ALTER TABLE "AiExecutionAuthorizationGrant"
  ADD COLUMN "hashCanonicalizationVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AiRun"
  ADD COLUMN "hashCanonicalizationVersion" INTEGER;

ALTER TABLE "AiExecutionRequest"
  ADD CONSTRAINT "AiExecRequest_hash_version_check" CHECK ("hashCanonicalizationVersion" IN (1, 2)),
  ADD CONSTRAINT "AiExecRequest_no_self_supersession_check" CHECK ("supersedesRequestId" IS NULL OR "supersedesRequestId" <> "id"),
  ADD CONSTRAINT "AiExecRequest_supersedes_fkey" FOREIGN KEY ("supersedesRequestId")
    REFERENCES "AiExecutionRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "AiExecRequest_supersedes_key"
  ON "AiExecutionRequest"("supersedesRequestId") WHERE "supersedesRequestId" IS NOT NULL;
ALTER TABLE "AiExecutionAuthorizationGrant"
  ADD CONSTRAINT "AiExecGrant_hash_version_check" CHECK ("hashCanonicalizationVersion" IN (1, 2));
ALTER TABLE "AiRun"
  ADD CONSTRAINT "AiRun_hash_version_check" CHECK ("hashCanonicalizationVersion" IS NULL OR "hashCanonicalizationVersion" IN (1, 2));

CREATE FUNCTION "ai_execution_utf16_sort_key_v2"(p_text TEXT)
RETURNS BYTEA LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result BYTEA := ''::BYTEA; cp INTEGER; ch TEXT;
BEGIN
  FOR ch IN SELECT REGEXP_SPLIT_TO_TABLE(p_text, '') LOOP
    cp := ASCII(ch);
    IF cp <= 65535 THEN
      result := result || DECODE(LPAD(TO_HEX(cp), 4, '0'), 'hex');
    ELSE
      cp := cp - 65536;
      result := result || DECODE(LPAD(TO_HEX(55296 + (cp >> 10)), 4, '0'), 'hex');
      result := result || DECODE(LPAD(TO_HEX(56320 + (cp & 1023)), 4, '0'), 'hex');
    END IF;
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION "ai_execution_number_ecmascript_v2"(p_number JSONB)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE n NUMERIC; f DOUBLE PRECISION; raw TEXT; mantissa TEXT; exponent INTEGER;
DECLARE sign TEXT := ''; digits TEXT; decimal_pos INTEGER; result TEXT;
BEGIN
  IF JSONB_TYPEOF(p_number) <> 'number' THEN RAISE EXCEPTION 'Expected JSON number'; END IF;
  n := (p_number::TEXT)::NUMERIC;
  BEGIN f := n::DOUBLE PRECISION; EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'JSON number is outside the finite IEEE-754 domain';
  END;
  raw := LOWER(f::TEXT);
  IF raw IN ('infinity', '-infinity', 'nan') THEN RAISE EXCEPTION 'Non-finite JSON number'; END IF;
  IF raw::NUMERIC IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'JSON number % is not an exact accepted IEEE-754 JSON representation (float text %)', p_number::TEXT, raw;
  END IF;
  IF f = 0 THEN RETURN '0'; END IF;
  IF POSITION('e' IN raw) = 0 THEN RETURN raw; END IF;
  mantissa := SPLIT_PART(raw, 'e', 1); exponent := SPLIT_PART(raw, 'e', 2)::INTEGER;
  IF exponent < -6 OR exponent >= 21 THEN
    RETURN mantissa || 'e' || CASE WHEN exponent >= 0 THEN '+' ELSE '' END || exponent::TEXT;
  END IF;
  IF LEFT(mantissa, 1) = '-' THEN sign := '-'; mantissa := SUBSTRING(mantissa FROM 2); END IF;
  digits := REPLACE(mantissa, '.', '');
  decimal_pos := 1 + exponent;
  IF decimal_pos <= 0 THEN result := '0.' || REPEAT('0', -decimal_pos) || digits;
  ELSIF decimal_pos >= LENGTH(digits) THEN result := digits || REPEAT('0', decimal_pos - LENGTH(digits));
  ELSE result := SUBSTRING(digits FROM 1 FOR decimal_pos) || '.' || SUBSTRING(digits FROM decimal_pos + 1); END IF;
  RETURN sign || result;
END $$;

CREATE FUNCTION "canonicalize_ai_execution_jsonb_v2"(p_value JSONB)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE canonical TEXT;
BEGIN
  CASE JSONB_TYPEOF(p_value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(STRING_AGG(TO_JSONB(k)::TEXT || ':' || "canonicalize_ai_execution_jsonb_v2"(v), ',' ORDER BY "ai_execution_utf16_sort_key_v2"(k)), '') || '}'
      INTO canonical FROM JSONB_EACH(p_value) e(k,v); RETURN canonical;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(STRING_AGG("canonicalize_ai_execution_jsonb_v2"(v), ',' ORDER BY pos), '') || ']'
      INTO canonical FROM JSONB_ARRAY_ELEMENTS(p_value) WITH ORDINALITY e(v,pos); RETURN canonical;
    WHEN 'number' THEN RETURN "ai_execution_number_ecmascript_v2"(p_value);
    ELSE RETURN p_value::TEXT;
  END CASE;
END $$;

CREATE FUNCTION "ai_execution_hash_jsonb_v2"(p_value JSONB)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT ENCODE(SHA256(CONVERT_TO("canonicalize_ai_execution_jsonb_v2"(
    JSONB_BUILD_OBJECT('hashCanonicalizationVersion', 2, 'value', p_value)
  ), 'UTF8')), 'hex')
$$;

CREATE FUNCTION "ai_execution_request_supersession_guard_v2"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE prior "AiExecutionRequest"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'NEEDS_INFORMATION' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'NEEDS_INFORMATION is terminal and immutable';
    END IF;
    IF NEW."hashCanonicalizationVersion" IS DISTINCT FROM OLD."hashCanonicalizationVersion"
      OR NEW."supersedesRequestId" IS DISTINCT FROM OLD."supersedesRequestId" THEN
      RAISE EXCEPTION 'AI execution hash version and supersession binding are immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."hashCanonicalizationVersion" NOT IN (1,2) THEN RAISE EXCEPTION 'Unknown AI execution hash canonicalization version'; END IF;
  IF NEW."supersedesRequestId" IS NULL THEN RETURN NEW; END IF;
  IF NEW."hashCanonicalizationVersion" <> 2 THEN RAISE EXCEPTION 'Replacement requests require hash canonicalization v2'; END IF;
  SELECT * INTO prior FROM "AiExecutionRequest" WHERE "id" = NEW."supersedesRequestId" FOR UPDATE;
  IF NOT FOUND OR prior."status" <> 'NEEDS_INFORMATION' THEN RAISE EXCEPTION 'Replacement requires a terminal NEEDS_INFORMATION request'; END IF;
  IF EXISTS (SELECT 1 FROM "AiExecutionAuthorizationGrant" WHERE "requestId" = prior."id")
    OR EXISTS (SELECT 1 FROM "AiRun" WHERE "aiExecutionRequestId" = prior."id") THEN
    RAISE EXCEPTION 'Replacement source cannot have a grant or run';
  END IF;
  IF ROW(NEW."origin",NEW."requesterKind",NEW."requesterUserId",NEW."requesterIdentity",NEW."functionCode",NEW."purposeCode",NEW."clientId",NEW."companyId",NEW."projectId",NEW."clientServiceId")
    IS DISTINCT FROM ROW(prior."origin",prior."requesterKind",prior."requesterUserId",prior."requesterIdentity",prior."functionCode",prior."purposeCode",prior."clientId",prior."companyId",prior."projectId",prior."clientServiceId") THEN
    RAISE EXCEPTION 'Replacement request continuity mismatch';
  END IF;
  IF NEW."idempotencyKey" = prior."idempotencyKey" OR NEW."inputFingerprint" = prior."inputFingerprint" OR NEW."executionInputHash" = prior."executionInputHash" THEN
    RAISE EXCEPTION 'Replacement requires new idempotency key, fingerprint and execution input hash';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "ai_execution_terminal_decision_guard_v2"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AiExecutionRequest" WHERE "id"=NEW."requestId" AND "status"='NEEDS_INFORMATION') THEN
    RAISE EXCEPTION 'NEEDS_INFORMATION is terminal and accepts no further ledger event';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "ai_execution_grant_version_before_v2"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v INTEGER;
BEGIN
  SELECT "hashCanonicalizationVersion" INTO v FROM "AiExecutionRequest" WHERE "id"=NEW."requestId" FOR UPDATE;
  IF v NOT IN (1,2) THEN RAISE EXCEPTION 'Unknown request hash canonicalization version'; END IF;
  NEW."hashCanonicalizationVersion" := v;
  RETURN NEW;
END $$;

CREATE FUNCTION "ai_execution_grant_hash_after_v2"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE decision_hash TEXT;
BEGIN
  IF NEW."hashCanonicalizationVersion" = 1 THEN RETURN NEW; END IF;
  SELECT "decisionHash" INTO decision_hash FROM "AiExecutionDecision" WHERE "id"=NEW."approvalDecisionId";
  NEW."grantHash" := ENCODE(SHA256(CONVERT_TO(JSONB_BUILD_OBJECT(
    'schemaVersion',2,'hashCanonicalizationVersion',NEW."hashCanonicalizationVersion",
    'requestId',NEW."requestId",'approvalDecisionHash',decision_hash,
    'inputFingerprint',NEW."inputFingerprint",'executionInputHash',NEW."executionInputHash",
    'agentId',NEW."agentId",'agentConfigVersion',NEW."agentConfigVersion",'provider',NEW."provider",
    'model',NEW."model",'purposeCode',NEW."purposeCode",'maxAttempts',NEW."maxAttempts",
    'expiresAt',TO_CHAR(NEW."expiresAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'approvedById',NEW."approvedById")::TEXT,'UTF8')),'hex');
  RETURN NEW;
END $$;

-- Replace only the live function; migration 30 remains untouched. The same trigger now dispatches v1/v2.
CREATE OR REPLACE FUNCTION "ai_execution_run_before_insert_v1"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE request_row "AiExecutionRequest"%ROWTYPE; grant_row "AiExecutionAuthorizationGrant"%ROWTYPE; expected_prompt_version TEXT; expected_hash TEXT;
BEGIN
  IF NEW."aiExecutionRequestId" IS NULL OR NEW."authorizationGrantId" IS NULL THEN RAISE EXCEPTION 'Every new AiRun requires a manual Admin authorization grant'; END IF;
  SELECT * INTO request_row FROM "AiExecutionRequest" WHERE "id"=NEW."aiExecutionRequestId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AiRun authorization request does not exist'; END IF;
  SELECT * INTO grant_row FROM "AiExecutionAuthorizationGrant" WHERE "id"=NEW."authorizationGrantId" FOR SHARE;
  IF NEW."hashCanonicalizationVersion" IS NULL AND request_row."hashCanonicalizationVersion"=1 AND grant_row."hashCanonicalizationVersion"=1 THEN NEW."hashCanonicalizationVersion":=1; END IF;
  IF request_row."hashCanonicalizationVersion" NOT IN (1,2) OR grant_row."hashCanonicalizationVersion" NOT IN (1,2)
    OR NEW."hashCanonicalizationVersion" IS NULL OR NEW."hashCanonicalizationVersion" NOT IN (1,2)
    OR NEW."hashCanonicalizationVersion"<>request_row."hashCanonicalizationVersion" OR NEW."hashCanonicalizationVersion"<>grant_row."hashCanonicalizationVersion" THEN
    RAISE EXCEPTION 'AiRun hash canonicalization version is missing, unknown or mismatched';
  END IF;
  expected_hash := CASE request_row."hashCanonicalizationVersion" WHEN 1 THEN ENCODE(SHA256(CONVERT_TO("canonicalize_ai_workflow_jsonb"(COALESCE(NEW."input",'null'::JSONB)),'UTF8')),'hex') WHEN 2 THEN "ai_execution_hash_jsonb_v2"(COALESCE(NEW."input",'null'::JSONB)) END;
  IF NOT FOUND OR grant_row."requestId" IS DISTINCT FROM request_row."id" OR request_row."status"<>'APPROVED'
    OR request_row."expiresAt"<=CURRENT_TIMESTAMP OR grant_row."expiresAt"<=CURRENT_TIMESTAMP OR grant_row."maxAttempts"<>1
    OR grant_row."inputFingerprint" IS DISTINCT FROM request_row."inputFingerprint" OR grant_row."executionInputHash" IS DISTINCT FROM request_row."executionInputHash"
    OR grant_row."agentId" IS DISTINCT FROM request_row."agentId" OR grant_row."agentConfigVersion" IS DISTINCT FROM request_row."agentConfigVersion"
    OR grant_row."provider" IS DISTINCT FROM request_row."provider" OR grant_row."model" IS DISTINCT FROM request_row."model" OR grant_row."purposeCode" IS DISTINCT FROM request_row."purposeCode"
    THEN RAISE EXCEPTION 'AiRun authorization grant is invalid, expired, revoked or mismatched'; END IF;
  SELECT "promptVersion" INTO expected_prompt_version FROM "AiAgentConfigVersion" WHERE "agentId"=request_row."agentId" AND "version"=request_row."agentConfigVersion" FOR KEY SHARE;
  IF NEW."reliabilityVersion" IS DISTINCT FROM 1 OR NEW."status"<>'running' OR NEW."requestKey" IS DISTINCT FROM request_row."idempotencyKey"
    OR NEW."requestFingerprint" IS DISTINCT FROM request_row."inputFingerprint" OR NEW."executionInputHash" IS DISTINCT FROM request_row."executionInputHash" OR NEW."executionInputHash" IS DISTINCT FROM expected_hash
    OR NEW."agentId" IS DISTINCT FROM request_row."agentId" OR NEW."agentConfigVersion" IS DISTINCT FROM request_row."agentConfigVersion" OR NEW."promptVersion" IS DISTINCT FROM expected_prompt_version
    OR NEW."provider" IS DISTINCT FROM request_row."provider" OR NEW."model" IS DISTINCT FROM request_row."model" OR NEW."clientId" IS DISTINCT FROM request_row."clientId"
    OR NEW."clientServiceId" IS DISTINCT FROM request_row."clientServiceId" OR NEW."projectId" IS DISTINCT FROM request_row."projectId" OR NEW."createdById" IS DISTINCT FROM request_row."requesterUserId"
    THEN RAISE EXCEPTION 'AiRun does not match the immutable authorization request binding'; END IF;
  INSERT INTO "AiExecutionDecision"("id","requestId","decisionType","actorUserId","actorRole","reasonCode","reason","requestFingerprint") VALUES
    (GEN_RANDOM_UUID()::TEXT,request_row."id",'CONSUMED',NULL,NULL,'AI_EXECUTION_CONSUMED','Autorizzazione consumata per la creazione atomica del singolo run AI.',request_row."inputFingerprint");
  RETURN NEW;
END $$;

CREATE TRIGGER "AiExecRequest_00_supersession_v2" BEFORE INSERT OR UPDATE ON "AiExecutionRequest" FOR EACH ROW EXECUTE FUNCTION "ai_execution_request_supersession_guard_v2"();
CREATE TRIGGER "AiExecDecision_00_terminal_v2" BEFORE INSERT ON "AiExecutionDecision" FOR EACH ROW EXECUTE FUNCTION "ai_execution_terminal_decision_guard_v2"();
CREATE TRIGGER "AiExecGrant_00_version_v2" BEFORE INSERT ON "AiExecutionAuthorizationGrant" FOR EACH ROW EXECUTE FUNCTION "ai_execution_grant_version_before_v2"();
CREATE TRIGGER "AiExecGrant_zz_hash_v2" BEFORE INSERT ON "AiExecutionAuthorizationGrant" FOR EACH ROW EXECUTE FUNCTION "ai_execution_grant_hash_after_v2"();

-- Protect the newly added run binding on updates as well.
CREATE FUNCTION "ai_execution_run_hash_version_immutable_v2"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN IF NEW."hashCanonicalizationVersion" IS DISTINCT FROM OLD."hashCanonicalizationVersion" THEN RAISE EXCEPTION 'AiRun hash canonicalization version is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "AiRun_hash_version_immutable_v2" BEFORE UPDATE ON "AiRun" FOR EACH ROW EXECUTE FUNCTION "ai_execution_run_hash_version_immutable_v2"();

CREATE FUNCTION "assert_ai_execution_pr85_rollback_safe_v2"()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AiExecutionRequest" WHERE "hashCanonicalizationVersion" <> 1 OR "supersedesRequestId" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "AiExecutionAuthorizationGrant" WHERE "hashCanonicalizationVersion" <> 1)
    OR EXISTS (SELECT 1 FROM "AiRun" WHERE "hashCanonicalizationVersion" = 2)
    OR EXISTS (SELECT 1 FROM "AiExecutionRequest" WHERE "status" = 'NEEDS_INFORMATION') THEN
    RAISE EXCEPTION 'PR85 application rollback is unsafe: v2, replacement, or any NEEDS_INFORMATION rows exist';
  END IF;
END $$;

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM "AiOrchestratorSetting" WHERE "stateMachineEnabled"<>false OR "dispatchEnabled"<>false OR "syntheticDataOnly"<>true OR "provider"<>'mock')
    OR EXISTS (SELECT 1 FROM "AiOrchestratorWorkerCapabilitySetting" WHERE "enabled"<>false)
    OR EXISTS (SELECT 1 FROM "AiControlSetting" WHERE "externalProvidersEnabled"<>false) THEN
    RAISE EXCEPTION 'PR86 must preserve every production gate fail-closed';
  END IF;
END $verify$;

COMMIT;
