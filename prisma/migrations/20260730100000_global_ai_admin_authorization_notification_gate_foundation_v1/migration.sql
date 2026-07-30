-- PR85 — Global AI Manual Authorization & Persistent Admin Notification Gate v1.
--
-- This additive foundation creates the persistent request, append-only decision,
-- immutable one-use grant and per-Admin notification contract. It does not
-- invoke an adapter, activate a worker, admit a job, contact the website or
-- enable any provider. Existing orchestrator and external-provider gates remain
-- physically closed.

BEGIN;

DO $preflight$
DECLARE
  dispatch_constraints INTEGER;
  dormant_settings INTEGER;
  disabled_capabilities INTEGER;
BEGIN
  IF TO_REGCLASS('"User"') IS NULL
    OR TO_REGCLASS('"AiRun"') IS NULL
    OR TO_REGCLASS('"AiAgentConfigVersion"') IS NULL
    OR TO_REGCLASS('"AiOrchestratorSetting"') IS NULL
    OR TO_REGCLASS('"AiOrchestratorWorkerCapabilitySetting"') IS NULL
    OR TO_REGCLASS('"AiControlSetting"') IS NULL
  THEN
    RAISE EXCEPTION 'PR85 requires the complete CRM and dormant Orchestrator foundation';
  END IF;

  SELECT COUNT(*) INTO dispatch_constraints
  FROM pg_constraint
  WHERE conrelid = '"AiOrchestratorSetting"'::REGCLASS
    AND conname = 'AiOrchestratorSetting_dispatch_disabled_check'
    AND contype = 'c'
    AND convalidated
    AND PG_GET_CONSTRAINTDEF(oid) = 'CHECK (("dispatchEnabled" = false))';

  SELECT COUNT(*) INTO dormant_settings
  FROM "AiOrchestratorSetting"
  WHERE "id" = 'global'
    AND "stateMachineEnabled" = false
    AND "dispatchEnabled" = false
    AND "syntheticDataOnly" = true
    AND "provider" = 'mock';

  SELECT COUNT(*) INTO disabled_capabilities
  FROM "AiOrchestratorWorkerCapabilitySetting"
  WHERE "enabled" = false;

  IF dispatch_constraints <> 1 THEN
    RAISE EXCEPTION 'PR85 requires the exact validated dispatch-disabled barrier';
  END IF;
  IF dormant_settings <> 1
    OR (SELECT COUNT(*) FROM "AiOrchestratorSetting") <> 1
  THEN
    RAISE EXCEPTION 'PR85 requires the singleton Orchestrator to remain dormant, mock and synthetic';
  END IF;
  IF disabled_capabilities <> 13
    OR (SELECT COUNT(*) FROM "AiOrchestratorWorkerCapabilitySetting") <> 13
  THEN
    RAISE EXCEPTION 'PR85 requires all 13 worker capabilities to remain disabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "AiControlSetting"
    WHERE "id" = 'global' AND "externalProvidersEnabled" = false
  ) THEN
    RAISE EXCEPTION 'PR85 requires external providers to remain disabled';
  END IF;
END;
$preflight$;

CREATE TYPE "AiExecutionRequestOrigin" AS ENUM (
  'CRM_UI',
  'WEBSITE',
  'CLIENT_PORTAL',
  'INTERNAL_API'
);

CREATE TYPE "AiExecutionRequesterKind" AS ENUM (
  'HUMAN_USER',
  'SYSTEM_IDENTITY'
);

CREATE TYPE "AiExecutionRequestStatus" AS ENUM (
  'PENDING_ADMIN_APPROVAL',
  'NEEDS_INFORMATION',
  'APPROVED',
  'REJECTED',
  'REVOKED',
  'CANCELLED',
  'EXPIRED',
  'CONSUMED'
);

CREATE TYPE "AiExecutionDecisionType" AS ENUM (
  'REQUESTED',
  'NEEDS_INFORMATION',
  'APPROVED',
  'REJECTED',
  'REVOKED',
  'CANCELLED',
  'EXPIRED',
  'CONSUMED'
);

CREATE TYPE "AiExecutionNotificationPriority" AS ENUM (
  'NORMAL',
  'HIGH',
  'URGENT'
);

CREATE FUNCTION "ai_execution_string_array_v1"(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT JSONB_TYPEOF(p_value) = 'array'
    AND JSONB_ARRAY_LENGTH(p_value) BETWEEN 1 AND 32
    AND NOT EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(p_value) AS item(value)
      WHERE JSONB_TYPEOF(item.value) <> 'string'
        OR LENGTH(item.value #>> '{}') NOT BETWEEN 1 AND 80
        OR item.value #>> '{}' <> BTRIM(item.value #>> '{}')
        OR item.value #>> '{}' !~ '^[a-z][a-z0-9._:-]*$'
    )
$$;

CREATE TABLE "AiExecutionRequest" (
  "id" TEXT NOT NULL,
  "origin" "AiExecutionRequestOrigin" NOT NULL,
  "requesterKind" "AiExecutionRequesterKind" NOT NULL,
  "requesterUserId" TEXT,
  "requesterIdentity" TEXT,
  "clientId" TEXT,
  "companyId" TEXT,
  "projectId" TEXT,
  "clientServiceId" TEXT,
  "functionCode" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "agentConfigVersion" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT,
  "purposeCode" TEXT NOT NULL,
  "dataCategories" JSONB NOT NULL,
  "correlationId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "inputFingerprint" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" "AiExecutionRequestStatus" NOT NULL DEFAULT 'PENDING_ADMIN_APPROVAL',
  "stateVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiExecutionRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiExecRequest_requester_check" CHECK (
    (
      "requesterKind" = 'HUMAN_USER'
      AND "requesterUserId" IS NOT NULL
      AND "requesterIdentity" IS NULL
      AND "origin" IN ('CRM_UI', 'CLIENT_PORTAL')
    )
    OR (
      "requesterKind" = 'SYSTEM_IDENTITY'
      AND "requesterUserId" IS NULL
      AND "requesterIdentity" IS NOT NULL
      AND LENGTH("requesterIdentity") BETWEEN 3 AND 160
      AND "requesterIdentity" = BTRIM("requesterIdentity")
      AND "requesterIdentity" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
      AND "origin" IN ('WEBSITE', 'INTERNAL_API')
    )
  ),
  CONSTRAINT "AiExecRequest_function_check" CHECK (
    LENGTH("functionCode") BETWEEN 3 AND 128
    AND "functionCode" = BTRIM("functionCode")
    AND "functionCode" ~ '^[A-Za-z][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "AiExecRequest_binding_check" CHECK (
    "agentConfigVersion" >= 1
    AND LENGTH("provider") BETWEEN 2 AND 64
    AND "provider" = BTRIM("provider")
    AND "provider" ~ '^[a-z][a-z0-9._-]*$'
    AND (
      "model" IS NULL
      OR (
        LENGTH("model") BETWEEN 1 AND 160
        AND "model" = BTRIM("model")
        AND "model" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
      )
    )
  ),
  CONSTRAINT "AiExecRequest_purpose_check" CHECK (
    LENGTH("purposeCode") BETWEEN 3 AND 96
    AND "purposeCode" = BTRIM("purposeCode")
    AND "purposeCode" ~ '^[A-Z][A-Z0-9_]*$'
  ),
  CONSTRAINT "AiExecRequest_categories_check" CHECK (
    "ai_execution_string_array_v1"("dataCategories")
  ),
  CONSTRAINT "AiExecRequest_correlation_check" CHECK (
    LENGTH("correlationId") BETWEEN 8 AND 128
    AND "correlationId" = BTRIM("correlationId")
    AND "correlationId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "AiExecRequest_idempotency_check" CHECK (
    LENGTH("idempotencyKey") BETWEEN 8 AND 128
    AND "idempotencyKey" = BTRIM("idempotencyKey")
    AND "idempotencyKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "AiExecRequest_fingerprint_check" CHECK (
    "inputFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AiExecRequest_initial_state_check" CHECK ("stateVersion" >= 1),
  CONSTRAINT "AiExecRequest_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "AiExecRequest_origin_idempotency_key"
  ON "AiExecutionRequest"("origin", "idempotencyKey");
CREATE INDEX "AiExecRequest_status_expiry_idx"
  ON "AiExecutionRequest"("status", "expiresAt");
CREATE INDEX "AiExecRequest_requester_idx"
  ON "AiExecutionRequest"("requesterUserId", "createdAt");
CREATE INDEX "AiExecRequest_client_idx"
  ON "AiExecutionRequest"("clientId", "createdAt");
CREATE INDEX "AiExecRequest_company_idx"
  ON "AiExecutionRequest"("companyId", "createdAt");
CREATE INDEX "AiExecRequest_project_idx"
  ON "AiExecutionRequest"("projectId", "createdAt");
CREATE INDEX "AiExecRequest_service_idx"
  ON "AiExecutionRequest"("clientServiceId", "createdAt");
CREATE INDEX "AiExecRequest_correlation_idx"
  ON "AiExecutionRequest"("correlationId");
CREATE INDEX "AiExecRequest_agentConfig_idx"
  ON "AiExecutionRequest"("agentId", "agentConfigVersion");

CREATE TABLE "AiExecutionDecision" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "decisionType" "AiExecutionDecisionType" NOT NULL,
  "actorUserId" TEXT,
  "actorRole" TEXT,
  "reasonCode" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "previousDecisionHash" TEXT,
  "decisionHash" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiExecutionDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiExecDecision_sequence_check" CHECK ("sequence" >= 1),
  CONSTRAINT "AiExecDecision_actor_pair_check" CHECK (
    ("actorUserId" IS NULL AND "actorRole" IS NULL)
    OR ("actorUserId" IS NOT NULL AND "actorRole" IS NOT NULL)
  ),
  CONSTRAINT "AiExecDecision_reason_check" CHECK (
    "reasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    AND LENGTH(BTRIM("reason")) BETWEEN 10 AND 500
    AND "reason" = BTRIM("reason")
    AND ("reason" COLLATE "C") !~ '[[:cntrl:]]'
    AND ("reason" COLLATE "C") !~ U&'[\0080-\009F]'
    AND (TRANSLATE(
      "reason",
      'ABCDEFGHIJKLMNOPQRSTUVWXYZſK',
      'abcdefghijklmnopqrstuvwxyzsk'
    ) COLLATE "C") !~ 'https?://'
    AND ("reason" COLLATE "C") !~ '<[^>]*>'
    AND POSITION('@' IN "reason") = 0
    AND (TRANSLATE(
      "reason",
      'ABCDEFGHIJKLMNOPQRSTUVWXYZſK',
      'abcdefghijklmnopqrstuvwxyzsk'
    ) COLLATE "C") !~ '(^|[^A-Za-z0-9_])(password|passwd|secret|token|prompt|authorization|cookie|api[ _-]?key)($|[^A-Za-z0-9_])'
  ),
  CONSTRAINT "AiExecDecision_hash_check" CHECK (
    "requestFingerprint" ~ '^[0-9a-f]{64}$'
    AND ("previousDecisionHash" IS NULL OR "previousDecisionHash" ~ '^[0-9a-f]{64}$')
    AND "decisionHash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "AiExecDecision_request_sequence_key"
  ON "AiExecutionDecision"("requestId", "sequence");
CREATE UNIQUE INDEX "AiExecDecision_request_previous_key"
  ON "AiExecutionDecision"("requestId", "previousDecisionHash");
CREATE UNIQUE INDEX "AiExecDecision_request_genesis_key"
  ON "AiExecutionDecision"("requestId")
  WHERE "previousDecisionHash" IS NULL;
CREATE UNIQUE INDEX "AiExecDecision_hash_key"
  ON "AiExecutionDecision"("decisionHash");
CREATE UNIQUE INDEX "AiExecDecision_approval_once_key"
  ON "AiExecutionDecision"("requestId")
  WHERE "decisionType" = 'APPROVED';
CREATE UNIQUE INDEX "AiExecDecision_consumption_once_key"
  ON "AiExecutionDecision"("requestId")
  WHERE "decisionType" = 'CONSUMED';
CREATE INDEX "AiExecDecision_request_audit_idx"
  ON "AiExecutionDecision"("requestId", "createdAt");
CREATE INDEX "AiExecDecision_actor_audit_idx"
  ON "AiExecutionDecision"("actorUserId", "createdAt");
CREATE INDEX "AiExecDecision_type_audit_idx"
  ON "AiExecutionDecision"("decisionType", "createdAt");

CREATE TABLE "AiExecutionAuthorizationGrant" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "approvalDecisionId" TEXT NOT NULL,
  "inputFingerprint" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "agentConfigVersion" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT,
  "purposeCode" TEXT NOT NULL,
  "maxAttempts" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "approvedById" TEXT NOT NULL,
  "grantHash" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiExecutionAuthorizationGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiExecGrant_attempts_check" CHECK ("maxAttempts" = 1),
  CONSTRAINT "AiExecGrant_fingerprint_check" CHECK (
    "inputFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AiExecGrant_hash_check" CHECK ("grantHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AiExecGrant_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "AiExecGrant_requestId_key"
  ON "AiExecutionAuthorizationGrant"("requestId");
CREATE UNIQUE INDEX "AiExecGrant_decisionId_key"
  ON "AiExecutionAuthorizationGrant"("approvalDecisionId");
CREATE UNIQUE INDEX "AiExecGrant_hash_key"
  ON "AiExecutionAuthorizationGrant"("grantHash");
CREATE INDEX "AiExecGrant_expiry_idx"
  ON "AiExecutionAuthorizationGrant"("expiresAt");
CREATE INDEX "AiExecGrant_approver_idx"
  ON "AiExecutionAuthorizationGrant"("approvedById", "createdAt");
CREATE INDEX "AiExecGrant_agentConfig_idx"
  ON "AiExecutionAuthorizationGrant"("agentId", "agentConfigVersion");

CREATE TABLE "AiExecutionAdminNotification" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "recipientAdminId" TEXT NOT NULL,
  "priority" "AiExecutionNotificationPriority" NOT NULL DEFAULT 'NORMAL',
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  "readAt" TIMESTAMP(3),
  "decidedAt" TIMESTAMP(3),
  "dedupeKey" TEXT NOT NULL,
  "approvalPath" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiExecutionAdminNotification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiExecNotification_read_check" CHECK (
    ("isRead" = false AND "readAt" IS NULL)
    OR ("isRead" = true AND "readAt" IS NOT NULL)
  ),
  CONSTRAINT "AiExecNotification_dedupe_check" CHECK (
    "dedupeKey" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AiExecNotification_path_check" CHECK (
    "approvalPath" ~ '^/settings/ai-authorizations/[A-Za-z0-9_-]+$'
  )
);

CREATE UNIQUE INDEX "AiExecNotification_dedupe_key"
  ON "AiExecutionAdminNotification"("dedupeKey");
CREATE UNIQUE INDEX "AiExecNotification_request_recipient_key"
  ON "AiExecutionAdminNotification"("requestId", "recipientAdminId");
CREATE INDEX "AiExecNotification_inbox_idx"
  ON "AiExecutionAdminNotification"("recipientAdminId", "isRead", "createdAt");
CREATE INDEX "AiExecNotification_request_idx"
  ON "AiExecutionAdminNotification"("requestId", "createdAt");

ALTER TABLE "AiExecutionRequest"
  ADD CONSTRAINT "AiExecRequest_requester_fkey"
  FOREIGN KEY ("requesterUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiExecRequest_client_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiExecRequest_company_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiExecRequest_project_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiExecRequest_service_fkey"
  FOREIGN KEY ("clientServiceId") REFERENCES "ClientService"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiExecRequest_agentConfig_fkey"
  FOREIGN KEY ("agentId", "agentConfigVersion")
  REFERENCES "AiAgentConfigVersion"("agentId", "version")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiExecutionDecision"
  ADD CONSTRAINT "AiExecDecision_request_fkey"
  FOREIGN KEY ("requestId") REFERENCES "AiExecutionRequest"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiExecDecision_actor_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiExecutionAuthorizationGrant"
  ADD CONSTRAINT "AiExecGrant_request_fkey"
  FOREIGN KEY ("requestId") REFERENCES "AiExecutionRequest"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiExecGrant_decision_fkey"
  FOREIGN KEY ("approvalDecisionId") REFERENCES "AiExecutionDecision"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiExecGrant_agentConfig_fkey"
  FOREIGN KEY ("agentId", "agentConfigVersion")
  REFERENCES "AiAgentConfigVersion"("agentId", "version")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiExecGrant_approver_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiExecutionAdminNotification"
  ADD CONSTRAINT "AiExecNotification_request_fkey"
  FOREIGN KEY ("requestId") REFERENCES "AiExecutionRequest"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiExecNotification_recipient_fkey"
  FOREIGN KEY ("recipientAdminId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiRun"
  ADD COLUMN "aiExecutionRequestId" TEXT,
  ADD COLUMN "authorizationGrantId" TEXT,
  ADD CONSTRAINT "AiRun_execution_binding_pair_check" CHECK (
    ("aiExecutionRequestId" IS NULL AND "authorizationGrantId" IS NULL)
    OR ("aiExecutionRequestId" IS NOT NULL AND "authorizationGrantId" IS NOT NULL)
  ),
  ADD CONSTRAINT "AiRun_aiExecutionRequestId_fkey"
  FOREIGN KEY ("aiExecutionRequestId") REFERENCES "AiExecutionRequest"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AiRun_authorizationGrantId_fkey"
  FOREIGN KEY ("authorizationGrantId") REFERENCES "AiExecutionAuthorizationGrant"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "AiRun_authorizationGrantId_key"
  ON "AiRun"("authorizationGrantId");
CREATE INDEX "AiRun_aiExecutionRequestId_idx"
  ON "AiRun"("aiExecutionRequestId");

CREATE FUNCTION "ai_execution_deny_immutable_change_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and immutable', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION "ai_execution_request_before_insert_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  requester_active BOOLEAN;
BEGIN
  IF NEW."status" <> 'PENDING_ADMIN_APPROVAL' OR NEW."stateVersion" <> 1 THEN
    RAISE EXCEPTION 'AI execution requests must start pending Admin approval';
  END IF;

  IF NEW."requesterKind" = 'HUMAN_USER' THEN
    SELECT ("active" AND "deletedAt" IS NULL)
    INTO requester_active
    FROM "User"
    WHERE "id" = NEW."requesterUserId"
    FOR KEY SHARE;
    IF NOT FOUND OR requester_active IS NOT TRUE THEN
      RAISE EXCEPTION 'AI execution requester must be an active internal user';
    END IF;
  END IF;

  PERFORM 1
  FROM "User"
  WHERE "role" = 'admin' AND "active" = true AND "deletedAt" IS NULL
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI execution request denied because no active Admin exists';
  END IF;

  NEW."createdAt" := CLOCK_TIMESTAMP();
  NEW."updatedAt" := NEW."createdAt";
  RETURN NEW;
END;
$$;

CREATE FUNCTION "ai_execution_decision_before_insert_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  request_row "AiExecutionRequest"%ROWTYPE;
  actor_role TEXT;
  actor_active BOOLEAN;
  latest_sequence INTEGER;
  latest_hash TEXT;
BEGIN
  SELECT *
  INTO request_row
  FROM "AiExecutionRequest"
  WHERE "id" = NEW."requestId"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI execution decision requires an existing request';
  END IF;

  IF NEW."actorUserId" IS NOT NULL THEN
    SELECT "role"::TEXT, ("active" AND "deletedAt" IS NULL)
    INTO actor_role, actor_active
    FROM "User"
    WHERE "id" = NEW."actorUserId"
    FOR KEY SHARE;
    IF NOT FOUND OR actor_active IS NOT TRUE OR NEW."actorRole" IS DISTINCT FROM actor_role THEN
      RAISE EXCEPTION 'AI execution decision actor is not an active canonical user';
    END IF;
  END IF;

  IF NEW."decisionType" IN ('NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'REVOKED') THEN
    IF actor_role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'AI execution Admin decision requires an active Admin actor';
    END IF;
  ELSIF NEW."decisionType" = 'REQUESTED' THEN
    IF request_row."requesterKind" = 'HUMAN_USER' THEN
      IF NEW."actorUserId" IS DISTINCT FROM request_row."requesterUserId" THEN
        RAISE EXCEPTION 'AI execution request event must identify its requester';
      END IF;
    ELSIF NEW."actorUserId" IS NOT NULL THEN
      RAISE EXCEPTION 'System AI execution requests cannot impersonate a user';
    END IF;
  ELSIF NEW."decisionType" IN ('EXPIRED', 'CONSUMED') THEN
    IF NEW."actorUserId" IS NOT NULL THEN
      RAISE EXCEPTION 'AI execution lifecycle event must use the internal system actor';
    END IF;
  ELSIF NEW."decisionType" = 'CANCELLED' THEN
    IF NEW."actorUserId" IS NULL
      OR (
        actor_role <> 'admin'
        AND NEW."actorUserId" IS DISTINCT FROM request_row."requesterUserId"
      )
    THEN
      RAISE EXCEPTION 'AI execution cancellation requires its requester or an Admin';
    END IF;
  END IF;

  SELECT "sequence", "decisionHash"
  INTO latest_sequence, latest_hash
  FROM "AiExecutionDecision"
  WHERE "requestId" = NEW."requestId"
  ORDER BY "sequence" DESC
  LIMIT 1;

  NEW."sequence" := COALESCE(latest_sequence, 0) + 1;
  NEW."previousDecisionHash" := latest_hash;
  NEW."requestFingerprint" := request_row."inputFingerprint";
  NEW."createdAt" := CLOCK_TIMESTAMP();
  NEW."decisionHash" := ENCODE(SHA256(CONVERT_TO(
    JSONB_BUILD_OBJECT(
      'schemaVersion', 1,
      'requestId', NEW."requestId",
      'sequence', NEW."sequence",
      'decisionType', NEW."decisionType"::TEXT,
      'actorUserId', NEW."actorUserId",
      'actorRole', NEW."actorRole",
      'reasonCode', NEW."reasonCode",
      'reason', NEW."reason",
      'requestFingerprint', NEW."requestFingerprint",
      'previousDecisionHash', NEW."previousDecisionHash",
      'createdAt', TO_CHAR(NEW."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )::TEXT,
    'UTF8'
  )), 'hex');
  RETURN NEW;
END;
$$;

CREATE FUNCTION "ai_execution_request_after_insert_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  requester_role TEXT;
BEGIN
  IF NEW."requesterUserId" IS NOT NULL THEN
    SELECT "role"::TEXT INTO requester_role
    FROM "User"
    WHERE "id" = NEW."requesterUserId";
  END IF;

  INSERT INTO "AiExecutionDecision" (
    "id", "requestId", "decisionType", "actorUserId", "actorRole",
    "reasonCode", "reason", "requestFingerprint"
  ) VALUES (
    GEN_RANDOM_UUID()::TEXT,
    NEW."id",
    'REQUESTED',
    NEW."requesterUserId",
    requester_role,
    'AI_EXECUTION_REQUESTED',
    'Richiesta AI registrata in attesa di approvazione Admin.',
    NEW."inputFingerprint"
  );

  INSERT INTO "AuditLog" (
    "id", "actorId", "event", "entityType", "entityId", "after", "createdAt"
  ) VALUES (
    GEN_RANDOM_UUID()::TEXT,
    NEW."requesterUserId",
    'ai_execution_request_created',
    'AiExecutionRequest',
    NEW."id",
    JSONB_BUILD_OBJECT(
      'origin', NEW."origin"::TEXT,
      'functionCode', NEW."functionCode",
      'purposeCode', NEW."purposeCode",
      'correlationId', NEW."correlationId",
      'inputFingerprint', NEW."inputFingerprint",
      'status', NEW."status"::TEXT
    ),
    CLOCK_TIMESTAMP()
  );

  INSERT INTO "AiExecutionAdminNotification" (
    "id", "requestId", "recipientAdminId", "priority", "isRead",
    "dedupeKey", "approvalPath", "createdAt", "updatedAt"
  )
  SELECT
    GEN_RANDOM_UUID()::TEXT,
    NEW."id",
    admin_user."id",
    'HIGH',
    false,
    ENCODE(SHA256(CONVERT_TO(
      NEW."id" || ':' || admin_user."id" || ':AI_EXECUTION_ADMIN_APPROVAL_V1',
      'UTF8'
    )), 'hex'),
    '/settings/ai-authorizations/' || NEW."id",
    CLOCK_TIMESTAMP(),
    CLOCK_TIMESTAMP()
  FROM "User" admin_user
  WHERE admin_user."role" = 'admin'
    AND admin_user."active" = true
    AND admin_user."deletedAt" IS NULL;

  RETURN NEW;
END;
$$;

CREATE FUNCTION "ai_execution_request_before_update_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  required_decision "AiExecutionDecisionType";
BEGIN
  IF ROW(
    NEW."id", NEW."origin", NEW."requesterKind", NEW."requesterUserId",
    NEW."requesterIdentity", NEW."clientId", NEW."companyId", NEW."projectId",
    NEW."clientServiceId", NEW."functionCode", NEW."agentId",
    NEW."agentConfigVersion", NEW."provider", NEW."model", NEW."purposeCode",
    NEW."dataCategories", NEW."correlationId", NEW."idempotencyKey",
    NEW."inputFingerprint", NEW."expiresAt", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."origin", OLD."requesterKind", OLD."requesterUserId",
    OLD."requesterIdentity", OLD."clientId", OLD."companyId", OLD."projectId",
    OLD."clientServiceId", OLD."functionCode", OLD."agentId",
    OLD."agentConfigVersion", OLD."provider", OLD."model", OLD."purposeCode",
    OLD."dataCategories", OLD."correlationId", OLD."idempotencyKey",
    OLD."inputFingerprint", OLD."expiresAt", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'AI execution request binding is immutable';
  END IF;

  IF NEW."status" = OLD."status" THEN
    NEW."stateVersion" := OLD."stateVersion";
    NEW."updatedAt" := OLD."updatedAt";
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD."status" = 'PENDING_ADMIN_APPROVAL' AND NEW."status" IN (
      'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'
    ))
    OR (OLD."status" = 'NEEDS_INFORMATION' AND NEW."status" IN (
      'PENDING_ADMIN_APPROVAL', 'CANCELLED', 'EXPIRED'
    ))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN (
      'REVOKED', 'EXPIRED', 'CONSUMED'
    ))
  ) THEN
    RAISE EXCEPTION 'Invalid AI execution request state transition';
  END IF;

  required_decision := CASE NEW."status"
    WHEN 'PENDING_ADMIN_APPROVAL' THEN 'REQUESTED'::"AiExecutionDecisionType"
    WHEN 'NEEDS_INFORMATION' THEN 'NEEDS_INFORMATION'::"AiExecutionDecisionType"
    WHEN 'APPROVED' THEN 'APPROVED'::"AiExecutionDecisionType"
    WHEN 'REJECTED' THEN 'REJECTED'::"AiExecutionDecisionType"
    WHEN 'REVOKED' THEN 'REVOKED'::"AiExecutionDecisionType"
    WHEN 'CANCELLED' THEN 'CANCELLED'::"AiExecutionDecisionType"
    WHEN 'EXPIRED' THEN 'EXPIRED'::"AiExecutionDecisionType"
    WHEN 'CONSUMED' THEN 'CONSUMED'::"AiExecutionDecisionType"
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM "AiExecutionDecision"
    WHERE "requestId" = OLD."id"
      AND "decisionType" = required_decision
      AND "requestFingerprint" = OLD."inputFingerprint"
  ) THEN
    RAISE EXCEPTION 'AI execution request transition requires its append-only decision';
  END IF;

  NEW."stateVersion" := OLD."stateVersion" + 1;
  NEW."updatedAt" := CLOCK_TIMESTAMP();
  RETURN NEW;
END;
$$;

CREATE FUNCTION "ai_execution_grant_before_insert_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  request_row "AiExecutionRequest"%ROWTYPE;
  decision_row "AiExecutionDecision"%ROWTYPE;
  approver_active BOOLEAN;
  approver_role TEXT;
BEGIN
  SELECT * INTO request_row
  FROM "AiExecutionRequest"
  WHERE "id" = NEW."requestId"
  FOR UPDATE;
  IF NOT FOUND OR request_row."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'AI execution grant requires an approved request';
  END IF;

  SELECT * INTO decision_row
  FROM "AiExecutionDecision"
  WHERE "id" = NEW."approvalDecisionId";
  IF NOT FOUND
    OR decision_row."requestId" <> NEW."requestId"
    OR decision_row."decisionType" <> 'APPROVED'
    OR decision_row."actorUserId" IS DISTINCT FROM NEW."approvedById"
  THEN
    RAISE EXCEPTION 'AI execution grant requires the matching Admin approval decision';
  END IF;

  SELECT "role"::TEXT, ("active" AND "deletedAt" IS NULL)
  INTO approver_role, approver_active
  FROM "User"
  WHERE "id" = NEW."approvedById"
  FOR KEY SHARE;
  IF NOT FOUND OR approver_role <> 'admin' OR approver_active IS NOT TRUE THEN
    RAISE EXCEPTION 'AI execution grant approver must be an active Admin';
  END IF;

  IF NEW."inputFingerprint" IS DISTINCT FROM request_row."inputFingerprint"
    OR NEW."agentId" IS DISTINCT FROM request_row."agentId"
    OR NEW."agentConfigVersion" IS DISTINCT FROM request_row."agentConfigVersion"
    OR NEW."provider" IS DISTINCT FROM request_row."provider"
    OR NEW."model" IS DISTINCT FROM request_row."model"
    OR NEW."purposeCode" IS DISTINCT FROM request_row."purposeCode"
    OR NEW."maxAttempts" <> 1
    OR NEW."expiresAt" > request_row."expiresAt"
  THEN
    RAISE EXCEPTION 'AI execution grant does not match the immutable request binding';
  END IF;

  NEW."createdAt" := CLOCK_TIMESTAMP();
  NEW."grantHash" := ENCODE(SHA256(CONVERT_TO(
    JSONB_BUILD_OBJECT(
      'schemaVersion', 1,
      'requestId', NEW."requestId",
      'approvalDecisionHash', decision_row."decisionHash",
      'inputFingerprint', NEW."inputFingerprint",
      'agentId', NEW."agentId",
      'agentConfigVersion', NEW."agentConfigVersion",
      'provider', NEW."provider",
      'model', NEW."model",
      'purposeCode', NEW."purposeCode",
      'maxAttempts', NEW."maxAttempts",
      'expiresAt', TO_CHAR(NEW."expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'approvedById', NEW."approvedById"
    )::TEXT,
    'UTF8'
  )), 'hex');
  RETURN NEW;
END;
$$;

CREATE FUNCTION "ai_execution_notification_guard_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  recipient_is_admin BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT ("role" = 'admin' AND "active" = true AND "deletedAt" IS NULL)
    INTO recipient_is_admin
    FROM "User"
    WHERE "id" = NEW."recipientAdminId"
    FOR KEY SHARE;
    IF NOT FOUND OR recipient_is_admin IS NOT TRUE THEN
      RAISE EXCEPTION 'AI execution notification recipient must be an active Admin';
    END IF;
    NEW."createdAt" := CLOCK_TIMESTAMP();
  ELSE
    IF ROW(
      NEW."id", NEW."requestId", NEW."recipientAdminId", NEW."priority",
      NEW."dedupeKey", NEW."approvalPath", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
      OLD."id", OLD."requestId", OLD."recipientAdminId", OLD."priority",
      OLD."dedupeKey", OLD."approvalPath", OLD."createdAt"
    ) THEN
      RAISE EXCEPTION 'AI execution notification routing is immutable';
    END IF;
  END IF;
  NEW."updatedAt" := CLOCK_TIMESTAMP();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiExecRequest_before_insert_v1"
BEFORE INSERT ON "AiExecutionRequest"
FOR EACH ROW EXECUTE FUNCTION "ai_execution_request_before_insert_v1"();

CREATE TRIGGER "AiExecRequest_after_insert_v1"
AFTER INSERT ON "AiExecutionRequest"
FOR EACH ROW EXECUTE FUNCTION "ai_execution_request_after_insert_v1"();

CREATE TRIGGER "AiExecRequest_before_update_v1"
BEFORE UPDATE ON "AiExecutionRequest"
FOR EACH ROW EXECUTE FUNCTION "ai_execution_request_before_update_v1"();

CREATE TRIGGER "AiExecRequest_deny_delete_v1"
BEFORE DELETE ON "AiExecutionRequest"
FOR EACH ROW EXECUTE FUNCTION "ai_execution_deny_immutable_change_v1"();

CREATE TRIGGER "AiExecDecision_before_insert_v1"
BEFORE INSERT ON "AiExecutionDecision"
FOR EACH ROW EXECUTE FUNCTION "ai_execution_decision_before_insert_v1"();

CREATE TRIGGER "AiExecDecision_immutable_v1"
BEFORE UPDATE OR DELETE ON "AiExecutionDecision"
FOR EACH ROW EXECUTE FUNCTION "ai_execution_deny_immutable_change_v1"();

CREATE TRIGGER "AiExecGrant_before_insert_v1"
BEFORE INSERT ON "AiExecutionAuthorizationGrant"
FOR EACH ROW EXECUTE FUNCTION "ai_execution_grant_before_insert_v1"();

CREATE TRIGGER "AiExecGrant_immutable_v1"
BEFORE UPDATE OR DELETE ON "AiExecutionAuthorizationGrant"
FOR EACH ROW EXECUTE FUNCTION "ai_execution_deny_immutable_change_v1"();

CREATE TRIGGER "AiExecNotification_guard_v1"
BEFORE INSERT OR UPDATE ON "AiExecutionAdminNotification"
FOR EACH ROW EXECUTE FUNCTION "ai_execution_notification_guard_v1"();

DO $verify$
DECLARE
  dispatch_constraints INTEGER;
  foundation_tables INTEGER;
  foundation_triggers INTEGER;
BEGIN
  SELECT COUNT(*) INTO dispatch_constraints
  FROM pg_constraint
  WHERE conrelid = '"AiOrchestratorSetting"'::REGCLASS
    AND conname = 'AiOrchestratorSetting_dispatch_disabled_check'
    AND contype = 'c'
    AND convalidated
    AND PG_GET_CONSTRAINTDEF(oid) = 'CHECK (("dispatchEnabled" = false))';

  SELECT COUNT(*) INTO foundation_tables
  FROM pg_class
  WHERE oid IN (
    '"AiExecutionRequest"'::REGCLASS,
    '"AiExecutionDecision"'::REGCLASS,
    '"AiExecutionAuthorizationGrant"'::REGCLASS,
    '"AiExecutionAdminNotification"'::REGCLASS
  )
    AND relkind = 'r';

  SELECT COUNT(*) INTO foundation_triggers
  FROM pg_trigger
  WHERE tgrelid IN (
    '"AiExecutionRequest"'::REGCLASS,
    '"AiExecutionDecision"'::REGCLASS,
    '"AiExecutionAuthorizationGrant"'::REGCLASS,
    '"AiExecutionAdminNotification"'::REGCLASS
  )
    AND NOT tgisinternal;

  IF dispatch_constraints <> 1 THEN
    RAISE EXCEPTION 'PR85 changed the physical dispatch-disabled barrier';
  END IF;
  IF foundation_tables <> 4 OR foundation_triggers <> 9 THEN
    RAISE EXCEPTION 'PR85 authorization foundation is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "AiOrchestratorSetting"
    WHERE "stateMachineEnabled" <> false
      OR "dispatchEnabled" <> false
      OR "syntheticDataOnly" <> true
      OR "provider" <> 'mock'
  ) OR EXISTS (
    SELECT 1 FROM "AiOrchestratorWorkerCapabilitySetting"
    WHERE "enabled" <> false
  ) OR EXISTS (
    SELECT 1 FROM "AiControlSetting"
    WHERE "externalProvidersEnabled" <> false
  ) THEN
    RAISE EXCEPTION 'PR85 must preserve every production gate fail-closed';
  END IF;
END;
$verify$;

COMMIT;
