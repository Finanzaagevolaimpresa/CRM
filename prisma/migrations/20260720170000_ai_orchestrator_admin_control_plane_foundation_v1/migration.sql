-- AI Orchestrator Admin Control Plane Foundation v1.
--
-- This migration adds only an immutable, versioned administrative policy
-- ledger. It does not open any runtime gate, mutate an existing capability,
-- create a workflow/job, install a worker or expose an API/UI.

BEGIN;

-- Refuse to install on a base which is not the exact dormant PR74-PR77
-- production contract. In particular, the physical dispatch barrier is an
-- input invariant of this foundation and is preserved byte-for-byte below.
DO $$
DECLARE
  dispatch_constraints INTEGER;
  setting_rows INTEGER;
  control_rows INTEGER;
  capability_rows INTEGER;
  canonical_capability_rows INTEGER;
  leased_rows INTEGER;
BEGIN
  IF TO_REGCLASS('"AiOrchestratorSetting"') IS NULL
    OR TO_REGCLASS('"AiOrchestratorWorkerCapabilitySetting"') IS NULL
    OR TO_REGCLASS('"AiWorkflowJobRuntime"') IS NULL
    OR TO_REGCLASS('"AiWorkflowJobResult"') IS NULL
    OR TO_REGPROCEDURE('canonicalize_ai_workflow_jsonb(jsonb)') IS NULL
    OR TO_REGPROCEDURE('count_ai_workflow_jsonb_keys(jsonb)') IS NULL
    OR TO_REGPROCEDURE('expected_ai_workflow_worker_capability(text)') IS NULL
    OR TO_REGPROCEDURE('canonicalize_ai_result_jsonb_v1(jsonb)') IS NULL
  THEN
    RAISE EXCEPTION 'Admin Control Plane v1 requires the complete PR74-PR77 contract';
  END IF;

  SELECT COUNT(*) INTO dispatch_constraints
  FROM pg_constraint
  WHERE conrelid = '"AiOrchestratorSetting"'::REGCLASS
    AND conname = 'AiOrchestratorSetting_dispatch_disabled_check'
    AND contype = 'c'
    AND convalidated
    AND pg_get_constraintdef(oid) = 'CHECK (("dispatchEnabled" = false))';

  IF dispatch_constraints <> 1 THEN
    RAISE EXCEPTION 'The exact validated physical dispatch barrier is required';
  END IF;

  SELECT COUNT(*) INTO setting_rows
  FROM "AiOrchestratorSetting"
  WHERE "id" = 'global'
    AND "stateMachineEnabled" = false
    AND "dispatchEnabled" = false
    AND "syntheticDataOnly" = true
    AND "provider" = 'mock';

  IF setting_rows <> 1 OR (SELECT COUNT(*) FROM "AiOrchestratorSetting") <> 1 THEN
    RAISE EXCEPTION 'The orchestrator singleton must be exactly dormant, mock and synthetic';
  END IF;

  SELECT COUNT(*) INTO control_rows
  FROM "AiControlSetting"
  WHERE "id" = 'global' AND "externalProvidersEnabled" = false;

  IF control_rows <> 1 OR (SELECT COUNT(*) FROM "AiControlSetting") <> 1 THEN
    RAISE EXCEPTION 'External providers must be explicitly disabled';
  END IF;

  SELECT COUNT(*) INTO capability_rows
  FROM "AiOrchestratorWorkerCapabilitySetting";

  SELECT COUNT(*) INTO canonical_capability_rows
  FROM "AiOrchestratorWorkerCapabilitySetting" setting
  CROSS JOIN LATERAL "expected_ai_workflow_worker_capability"(setting."jobCode") expected
  WHERE setting."enabled" = false
    AND setting."capabilityCode" = expected."capabilityCode"
    AND setting."capabilityVersion" = '1.0'
    AND setting."capabilityHash" = expected."capabilityHash";

  IF capability_rows <> 13 OR canonical_capability_rows <> 13 THEN
    RAISE EXCEPTION 'All 13 canonical worker capabilities must exist and remain disabled';
  END IF;

  SELECT COUNT(*) INTO leased_rows
  FROM "AiWorkflowJobRuntime"
  WHERE "state" = 'LEASED';

  IF leased_rows <> 0 THEN
    RAISE EXCEPTION 'Admin Control Plane v1 cannot be installed while a lease is active';
  END IF;
END;
$$;

CREATE TABLE "AiOrchestratorAdminPolicyRevision" (
  "id" TEXT NOT NULL,
  "scopeType" TEXT NOT NULL,
  "scopeCode" TEXT NOT NULL,
  "targetDefinitionHash" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "policy" JSONB NOT NULL,
  "policyHash" TEXT NOT NULL,
  "previousRevisionHash" TEXT,
  "revisionHash" TEXT NOT NULL,
  "requestId" TEXT,
  "requestHash" TEXT NOT NULL,
  "requestedPolicyHash" TEXT NOT NULL,
  "expectedVersion" INTEGER,
  "expectedRevisionHash" TEXT,
  "operationCode" TEXT NOT NULL,
  "requiredPermissions" JSONB NOT NULL,
  "permissionDecisions" JSONB NOT NULL,
  "actorUserId" TEXT,
  "actorRole" TEXT,
  "reasonCode" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "confirmed" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiOrchestratorAdminPolicyRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiOAdminPolicy_scope_check" CHECK (
    "scopeType" IN ('GLOBAL', 'PROVIDER', 'AGENT', 'CAPABILITY', 'JOB', 'WORKFLOW')
    AND LENGTH("scopeCode") BETWEEN 1 AND 160
    AND "scopeCode" = BTRIM("scopeCode")
    AND "scopeCode" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "AiOAdminPolicy_version_check" CHECK ("version" >= 1),
  CONSTRAINT "AiOAdminPolicy_hashes_check" CHECK (
    "targetDefinitionHash" ~ '^[0-9a-f]{64}$'
    AND "policyHash" ~ '^[0-9a-f]{64}$'
    AND "revisionHash" ~ '^[0-9a-f]{64}$'
    AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND ("previousRevisionHash" IS NULL OR "previousRevisionHash" ~ '^[0-9a-f]{64}$')
    AND "requestedPolicyHash" ~ '^[0-9a-f]{64}$'
    AND ("expectedRevisionHash" IS NULL OR "expectedRevisionHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "AiOAdminPolicy_request_id_check" CHECK (
    "requestId" IS NULL OR "requestId" ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "AiOAdminPolicy_expected_version_check" CHECK (
    "expectedVersion" IS NULL OR "expectedVersion" >= 1
  ),
  CONSTRAINT "AiOAdminPolicy_operation_check" CHECK (
    "operationCode" IN ('GENESIS', 'SET_GLOBAL_POLICY', 'SET_SCOPE_POLICY', 'EMERGENCY_STOP')
  ),
  CONSTRAINT "AiOAdminPolicy_permissions_json_check" CHECK (
    JSONB_TYPEOF("requiredPermissions") = 'array'
    AND JSONB_TYPEOF("permissionDecisions") = 'array'
  ),
  CONSTRAINT "AiOAdminPolicy_actor_pair_check" CHECK (
    ("actorUserId" IS NULL AND "actorRole" IS NULL)
    OR ("actorUserId" IS NOT NULL AND "actorRole" IS NOT NULL)
  ),
  CONSTRAINT "AiOAdminPolicy_reason_check" CHECK (
    "reasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    AND LENGTH(BTRIM("reason")) BETWEEN 10 AND 500
    AND "reason" = BTRIM("reason")
    AND "reason" !~ '[[:cntrl:]]'
  )
);

CREATE UNIQUE INDEX "AiOAdminPolicy_revisionHash_key"
  ON "AiOrchestratorAdminPolicyRevision"("revisionHash");
CREATE UNIQUE INDEX "AiOAdminPolicy_requestId_key"
  ON "AiOrchestratorAdminPolicyRevision"("requestId");
CREATE UNIQUE INDEX "AiOAdminPolicy_scope_version_key"
  ON "AiOrchestratorAdminPolicyRevision"("scopeType", "scopeCode", "version");
CREATE UNIQUE INDEX "AiOAdminPolicy_scope_previous_key"
  ON "AiOrchestratorAdminPolicyRevision"("scopeType", "scopeCode", "previousRevisionHash");
CREATE UNIQUE INDEX "AiOAdminPolicy_scope_genesis_key"
  ON "AiOrchestratorAdminPolicyRevision"("scopeType", "scopeCode")
  WHERE "previousRevisionHash" IS NULL;
CREATE INDEX "AiOAdminPolicy_scope_latest_idx"
  ON "AiOrchestratorAdminPolicyRevision"("scopeType", "scopeCode", "version");
CREATE INDEX "AiOAdminPolicy_scope_audit_idx"
  ON "AiOrchestratorAdminPolicyRevision"("scopeType", "scopeCode", "createdAt");
CREATE INDEX "AiOAdminPolicy_actor_audit_idx"
  ON "AiOrchestratorAdminPolicyRevision"("actorUserId", "createdAt");
CREATE INDEX "AiOAdminPolicy_operation_audit_idx"
  ON "AiOrchestratorAdminPolicyRevision"("operationCode", "createdAt");
CREATE INDEX "AiOAdminPolicy_requestHash_idx"
  ON "AiOrchestratorAdminPolicyRevision"("requestHash");

ALTER TABLE "AiOrchestratorAdminPolicyRevision"
  ADD CONSTRAINT "AiOAdminPolicy_actor_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "ai_orchestrator_admin_jsonb_is_integer_v1"(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT JSONB_TYPEOF(p_value) = 'number'
    AND (p_value #>> '{}') ~ '^-?(0|[1-9][0-9]*)$'
$$;

CREATE FUNCTION "ai_orchestrator_admin_target_hash_v1"(
  p_scope_type TEXT,
  p_scope_code TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  target_hash TEXT;
  target_count INTEGER;
BEGIN
  IF p_scope_type = 'GLOBAL' AND p_scope_code = 'global' THEN
    RETURN ENCODE(SHA256(CONVERT_TO(
      "canonicalize_ai_workflow_jsonb"(JSONB_BUILD_OBJECT(
        'schemaVersion', 1,
        'policyCode', 'AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY',
        'policyVersion', '1.0',
        'activationEpoch', 'FOUNDATION_LOCKED_V1'
      )), 'UTF8')), 'hex');
  END IF;

  IF p_scope_type = 'PROVIDER' AND p_scope_code = 'mock' THEN
    RETURN ENCODE(SHA256(CONVERT_TO(
      "canonicalize_ai_workflow_jsonb"(JSONB_BUILD_OBJECT(
        'schemaVersion', 1,
        'provider', 'mock',
        'dataMode', 'synthetic',
        'networkAccessAllowed', false,
        'externalProvider', false
      )), 'UTF8')), 'hex');
  END IF;

  IF p_scope_type = 'WORKFLOW' AND p_scope_code = 'FAI-AUDIT-WORKFLOW' THEN
    RETURN '6b31ebbe050314afe397ccf61b8fc6a2c1ca8620cb08cb9cdb37c42a62a5024c';
  END IF;

  IF p_scope_type = 'JOB' THEN
    SELECT expected."jobDefinitionHash" INTO target_hash
    FROM "expected_ai_workflow_worker_capability"(p_scope_code) expected;
    RETURN target_hash;
  END IF;

  IF p_scope_type = 'CAPABILITY' THEN
    SELECT expected."capabilityHash" INTO target_hash
    FROM "AiOrchestratorWorkerCapabilitySetting" setting
    CROSS JOIN LATERAL "expected_ai_workflow_worker_capability"(setting."jobCode") expected
    WHERE expected."capabilityCode" = p_scope_code;
    RETURN target_hash;
  END IF;

  IF p_scope_type = 'AGENT' THEN
    SELECT MIN(expected."executorAgentConfigHash"),
      COUNT(DISTINCT expected."executorAgentConfigHash")::INTEGER
    INTO target_hash, target_count
    FROM "AiOrchestratorWorkerCapabilitySetting" setting
    CROSS JOIN LATERAL "expected_ai_workflow_worker_capability"(setting."jobCode") expected
    WHERE expected."executorAgentCode" = p_scope_code;

    IF target_count = 1 THEN RETURN target_hash; END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION "validate_ai_orchestrator_admin_policy_v1"(
  p_scope_type TEXT,
  p_scope_code TEXT,
  p_target_definition_hash TEXT,
  p_policy JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
STRICT
AS $$
DECLARE
  limits JSONB;
  operating_window JSONB;
  lease_duration INTEGER;
  heartbeat_interval INTEGER;
  max_attempt_duration INTEGER;
  start_minute INTEGER;
  end_minute INTEGER;
BEGIN
  IF p_target_definition_hash IS DISTINCT FROM
    "ai_orchestrator_admin_target_hash_v1"(p_scope_type, p_scope_code)
  THEN RETURN false; END IF;

  IF JSONB_TYPEOF(p_policy) <> 'object' THEN RETURN false; END IF;

  IF p_scope_type = 'GLOBAL' THEN
    IF "count_ai_workflow_jsonb_keys"(p_policy) <> 14
      OR NOT p_policy ?& ARRAY[
        'schemaVersion', 'policyCode', 'policyVersion', 'activationEpoch',
        'foundationLocked', 'desiredMode', 'desiredStateMachineEnabled',
        'desiredDispatchEnabled', 'emergencyStopEngaged', 'globalKillSwitch',
        'provider', 'syntheticDataOnly', 'limits', 'operatingWindow'
      ]
      OR p_policy -> 'schemaVersion' <> '1'::JSONB
      OR p_policy ->> 'policyCode' <> 'AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY'
      OR p_policy ->> 'policyVersion' <> '1.0'
      OR p_policy ->> 'activationEpoch' <> 'FOUNDATION_LOCKED_V1'
      OR p_policy -> 'foundationLocked' <> 'true'::JSONB
      OR p_policy ->> 'desiredMode' NOT IN ('STOPPED', 'PAUSED', 'DRAINING', 'READY')
      OR JSONB_TYPEOF(p_policy -> 'desiredStateMachineEnabled') <> 'boolean'
      OR p_policy -> 'desiredDispatchEnabled' <> 'false'::JSONB
      OR JSONB_TYPEOF(p_policy -> 'emergencyStopEngaged') <> 'boolean'
      OR JSONB_TYPEOF(p_policy -> 'globalKillSwitch') <> 'boolean'
      OR p_policy ->> 'provider' <> 'mock'
      OR p_policy -> 'syntheticDataOnly' <> 'true'::JSONB
      OR JSONB_TYPEOF(p_policy -> 'limits') <> 'object'
      OR JSONB_TYPEOF(p_policy -> 'operatingWindow') <> 'object'
      OR (
        p_policy ->> 'desiredMode' = 'STOPPED'
        AND p_policy -> 'desiredStateMachineEnabled' <> 'false'::JSONB
      )
    THEN RETURN false; END IF;

    limits := p_policy -> 'limits';
    IF "count_ai_workflow_jsonb_keys"(limits) <> 8
      OR NOT limits ?& ARRAY[
        'maxConcurrentGlobal', 'maxConcurrentPerWorkflow',
        'maxConcurrentPerAgent', 'maxRetryableFailures', 'leaseDurationMs',
        'heartbeatIntervalMs', 'maxAttemptDurationMs', 'dailyJobLimit'
      ]
      OR NOT "ai_orchestrator_admin_jsonb_is_integer_v1"(limits -> 'maxConcurrentGlobal')
      OR NOT "ai_orchestrator_admin_jsonb_is_integer_v1"(limits -> 'maxConcurrentPerWorkflow')
      OR NOT "ai_orchestrator_admin_jsonb_is_integer_v1"(limits -> 'maxConcurrentPerAgent')
      OR NOT "ai_orchestrator_admin_jsonb_is_integer_v1"(limits -> 'maxRetryableFailures')
      OR NOT "ai_orchestrator_admin_jsonb_is_integer_v1"(limits -> 'leaseDurationMs')
      OR NOT "ai_orchestrator_admin_jsonb_is_integer_v1"(limits -> 'heartbeatIntervalMs')
      OR NOT "ai_orchestrator_admin_jsonb_is_integer_v1"(limits -> 'maxAttemptDurationMs')
      OR NOT "ai_orchestrator_admin_jsonb_is_integer_v1"(limits -> 'dailyJobLimit')
    THEN RETURN false; END IF;

    lease_duration := (limits ->> 'leaseDurationMs')::INTEGER;
    heartbeat_interval := (limits ->> 'heartbeatIntervalMs')::INTEGER;
    max_attempt_duration := (limits ->> 'maxAttemptDurationMs')::INTEGER;

    IF (limits ->> 'maxConcurrentGlobal')::INTEGER NOT BETWEEN 0 AND 1
      OR (limits ->> 'maxConcurrentPerWorkflow')::INTEGER NOT BETWEEN 0 AND 1
      OR (limits ->> 'maxConcurrentPerAgent')::INTEGER NOT BETWEEN 0 AND 1
      OR (limits ->> 'maxRetryableFailures')::INTEGER NOT BETWEEN 0 AND 3
      OR lease_duration NOT BETWEEN 30000 AND 120000
      OR heartbeat_interval NOT BETWEEN 10000 AND 30000
      OR heartbeat_interval * 2 > lease_duration
      OR max_attempt_duration NOT BETWEEN 5000 AND 600000
      OR max_attempt_duration < lease_duration
      OR (limits ->> 'dailyJobLimit')::INTEGER NOT BETWEEN 0 AND 1000
    THEN RETURN false; END IF;

    operating_window := p_policy -> 'operatingWindow';
    IF "count_ai_workflow_jsonb_keys"(operating_window) <> 4
      OR NOT operating_window ?& ARRAY['enabled', 'timezone', 'startMinuteUtc', 'endMinuteUtc']
      OR JSONB_TYPEOF(operating_window -> 'enabled') <> 'boolean'
      OR operating_window ->> 'timezone' <> 'UTC'
    THEN RETURN false; END IF;

    IF operating_window -> 'enabled' = 'true'::JSONB THEN
      IF NOT "ai_orchestrator_admin_jsonb_is_integer_v1"(operating_window -> 'startMinuteUtc')
        OR NOT "ai_orchestrator_admin_jsonb_is_integer_v1"(operating_window -> 'endMinuteUtc')
      THEN RETURN false; END IF;
      start_minute := (operating_window ->> 'startMinuteUtc')::INTEGER;
      end_minute := (operating_window ->> 'endMinuteUtc')::INTEGER;
      IF start_minute NOT BETWEEN 0 AND 1439
        OR end_minute NOT BETWEEN 0 AND 1439
        OR start_minute = end_minute
      THEN RETURN false; END IF;
    ELSIF JSONB_TYPEOF(operating_window -> 'startMinuteUtc') <> 'null'
      OR JSONB_TYPEOF(operating_window -> 'endMinuteUtc') <> 'null'
    THEN RETURN false;
    END IF;

    RETURN true;
  END IF;

  IF p_scope_type NOT IN ('PROVIDER', 'AGENT', 'CAPABILITY', 'JOB', 'WORKFLOW')
    OR "count_ai_workflow_jsonb_keys"(p_policy) <> 9
    OR NOT p_policy ?& ARRAY[
      'schemaVersion', 'policyCode', 'policyVersion', 'activationEpoch',
      'scopeType', 'scopeCode', 'targetDefinitionHash', 'desiredEnabled', 'killSwitch'
    ]
    OR p_policy -> 'schemaVersion' <> '1'::JSONB
    OR p_policy ->> 'policyCode' <> 'AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY'
    OR p_policy ->> 'policyVersion' <> '1.0'
    OR p_policy ->> 'activationEpoch' <> 'FOUNDATION_LOCKED_V1'
    OR p_policy ->> 'scopeType' IS DISTINCT FROM p_scope_type
    OR p_policy ->> 'scopeCode' IS DISTINCT FROM p_scope_code
    OR p_policy ->> 'targetDefinitionHash' IS DISTINCT FROM p_target_definition_hash
    OR JSONB_TYPEOF(p_policy -> 'desiredEnabled') <> 'boolean'
    OR JSONB_TYPEOF(p_policy -> 'killSwitch') <> 'boolean'
  THEN RETURN false; END IF;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE FUNCTION "ai_orchestrator_admin_policy_hash_v1"(p_policy JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT ENCODE(SHA256(CONVERT_TO(
    "canonicalize_ai_workflow_jsonb"(p_policy), 'UTF8')), 'hex')
$$;

CREATE FUNCTION "ai_orchestrator_admin_request_hash_v1"(p_request JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT ENCODE(SHA256(CONVERT_TO(
    "canonicalize_ai_workflow_jsonb"(p_request), 'UTF8')), 'hex')
$$;

CREATE FUNCTION "ai_orchestrator_admin_revision_hash_v1"(p_revision JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT ENCODE(SHA256(CONVERT_TO(
    "canonicalize_ai_workflow_jsonb"(p_revision), 'UTF8')), 'hex')
$$;

CREATE FUNCTION "ai_orchestrator_admin_emergency_policy_v1"(p_current_policy JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT p_current_policy || JSONB_BUILD_OBJECT(
    'desiredMode', 'STOPPED',
    'desiredStateMachineEnabled', false,
    'desiredDispatchEnabled', false,
    'emergencyStopEngaged', true,
    'globalKillSwitch', true
  )
$$;

CREATE FUNCTION "ai_orchestrator_admin_emergency_intent_hash_v1"()
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT ENCODE(SHA256(CONVERT_TO(
    "canonicalize_ai_workflow_jsonb"(JSONB_BUILD_OBJECT(
      'schemaVersion', 1,
      'reducerCode', 'AI_ORCHESTRATOR_ADMIN_EMERGENCY_STOP_REDUCER',
      'reducerVersion', '1.0'
    )), 'UTF8')), 'hex')
$$;

CREATE FUNCTION "ai_orchestrator_admin_required_permissions_v1"(
  p_previous_policy JSONB,
  p_next_policy JSONB,
  p_operation_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  needs_configure BOOLEAN := false;
  needs_enable BOOLEAN := false;
  needs_disable BOOLEAN := false;
  needs_kill BOOLEAN := false;
  needs_retry BOOLEAN := false;
  needs_limits BOOLEAN := false;
  needs_agents BOOLEAN := false;
  permissions JSONB;
BEGIN
  IF p_operation_code = 'EMERGENCY_STOP' THEN
    RETURN '["ai.orchestrator.kill"]'::JSONB;
  END IF;
  IF p_operation_code NOT IN ('SET_GLOBAL_POLICY', 'SET_SCOPE_POLICY') THEN
    RETURN '[]'::JSONB;
  END IF;

  needs_configure := true;
  IF p_previous_policy ->> 'policyCode' = 'AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY'
    AND p_next_policy ->> 'policyCode' = 'AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY'
  THEN
    needs_limits := (p_previous_policy -> 'limits') IS DISTINCT FROM (p_next_policy -> 'limits');
    needs_retry := (p_previous_policy #> '{limits,maxRetryableFailures}')
      IS DISTINCT FROM (p_next_policy #> '{limits,maxRetryableFailures}');

    IF p_previous_policy ->> 'desiredMode' IS DISTINCT FROM p_next_policy ->> 'desiredMode' THEN
      IF p_next_policy ->> 'desiredMode' = 'READY' THEN needs_enable := true;
      ELSE needs_disable := true; END IF;
    END IF;
    IF p_previous_policy -> 'desiredStateMachineEnabled'
      IS DISTINCT FROM p_next_policy -> 'desiredStateMachineEnabled'
    THEN
      IF p_next_policy -> 'desiredStateMachineEnabled' = 'true'::JSONB
        THEN needs_enable := true;
        ELSE needs_disable := true;
      END IF;
    END IF;
    IF p_previous_policy -> 'emergencyStopEngaged'
      IS DISTINCT FROM p_next_policy -> 'emergencyStopEngaged'
    THEN
      needs_kill := true;
      IF p_next_policy -> 'emergencyStopEngaged' = 'false'::JSONB THEN needs_enable := true; END IF;
    END IF;
    IF p_previous_policy -> 'globalKillSwitch'
      IS DISTINCT FROM p_next_policy -> 'globalKillSwitch'
    THEN
      needs_kill := true;
      IF p_next_policy -> 'globalKillSwitch' = 'false'::JSONB THEN needs_enable := true; END IF;
    END IF;
  ELSE
    IF p_previous_policy ->> 'scopeType' IS DISTINCT FROM p_next_policy ->> 'scopeType'
      OR p_previous_policy ->> 'scopeCode' IS DISTINCT FROM p_next_policy ->> 'scopeCode'
      OR p_previous_policy ->> 'targetDefinitionHash'
        IS DISTINCT FROM p_next_policy ->> 'targetDefinitionHash'
    THEN RAISE EXCEPTION 'Admin scope identity is immutable'; END IF;

    needs_agents := p_previous_policy ->> 'scopeType' = 'AGENT';
    IF p_previous_policy -> 'desiredEnabled' IS DISTINCT FROM p_next_policy -> 'desiredEnabled' THEN
      IF p_next_policy -> 'desiredEnabled' = 'true'::JSONB
        THEN needs_enable := true;
        ELSE needs_disable := true;
      END IF;
    END IF;
    IF p_previous_policy -> 'killSwitch' IS DISTINCT FROM p_next_policy -> 'killSwitch' THEN
      needs_kill := true;
      IF p_next_policy -> 'killSwitch' = 'false'::JSONB THEN needs_enable := true; END IF;
    END IF;
  END IF;

  SELECT COALESCE(JSONB_AGG(permission_code ORDER BY permission_order), '[]'::JSONB)
  INTO permissions
  FROM (VALUES
    (2, 'ai.orchestrator.configure', needs_configure),
    (3, 'ai.orchestrator.enable', needs_enable),
    (4, 'ai.orchestrator.disable', needs_disable),
    (5, 'ai.orchestrator.kill', needs_kill),
    (6, 'ai.orchestrator.retry', needs_retry),
    (8, 'ai.orchestrator.limits', needs_limits),
    (9, 'ai.orchestrator.agents', needs_agents)
  ) required(permission_order, permission_code, needed)
  WHERE needed;
  RETURN permissions;
END;
$$;

CREATE FUNCTION "validate_ai_orchestrator_admin_policy_revision_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_row "AiOrchestratorAdminPolicyRevision"%ROWTYPE;
  actor_row "User"%ROWTYPE;
  expected_permissions JSONB;
  expected_permission TEXT;
  expected_source TEXT;
  decision JSONB;
  permission_index INTEGER;
  expected_target_hash TEXT;
  expected_policy_hash TEXT;
  request_payload JSONB;
  revision_payload JSONB;
BEGIN
  -- One short transaction-scoped lock per logical scope prevents chain forks,
  -- including raw SQL callers which do not first lock a mutable head row.
  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED(
    NEW."scopeType" || CHR(31) || NEW."scopeCode", 7901::BIGINT
  ));

  SELECT * INTO previous_row
  FROM "AiOrchestratorAdminPolicyRevision"
  WHERE "scopeType" = NEW."scopeType" AND "scopeCode" = NEW."scopeCode"
  ORDER BY "version" DESC
  LIMIT 1
  FOR UPDATE;

  expected_target_hash := "ai_orchestrator_admin_target_hash_v1"(
    NEW."scopeType", NEW."scopeCode"
  );
  IF expected_target_hash IS NULL
    OR NEW."targetDefinitionHash" IS DISTINCT FROM expected_target_hash
    OR NOT "validate_ai_orchestrator_admin_policy_v1"(
      NEW."scopeType", NEW."scopeCode", NEW."targetDefinitionHash", NEW."policy"
    )
  THEN
    RAISE EXCEPTION 'Admin policy target or strict policy contract is invalid';
  END IF;

  expected_policy_hash := "ai_orchestrator_admin_policy_hash_v1"(NEW."policy");
  NEW."policyHash" := expected_policy_hash;
  NEW."createdAt" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';

  IF previous_row."id" IS NULL THEN
    NEW."requestedPolicyHash" := expected_policy_hash;
    IF NEW."operationCode" <> 'GENESIS'
      OR NEW."version" <> 1
      OR NEW."previousRevisionHash" IS NOT NULL
      OR NEW."requestId" IS NOT NULL
      OR NEW."requestedPolicyHash" IS DISTINCT FROM expected_policy_hash
      OR NEW."expectedVersion" IS NOT NULL
      OR NEW."expectedRevisionHash" IS NOT NULL
      OR NEW."actorUserId" IS NOT NULL
      OR NEW."actorRole" IS NOT NULL
      OR NEW."requiredPermissions" <> '[]'::JSONB
      OR NEW."permissionDecisions" <> '[]'::JSONB
      OR NEW."reasonCode" <> 'FOUNDATION_BOOTSTRAP'
      OR NEW."reason" <> 'Bootstrap fail-closed Admin Control Plane Foundation v1.'
      OR NEW."confirmed" <> false
    THEN
      RAISE EXCEPTION 'The first policy revision must be the fail-closed genesis';
    END IF;

    IF NEW."scopeType" = 'GLOBAL' THEN
      IF NEW."policy" ->> 'desiredMode' <> 'STOPPED'
        OR NEW."policy" -> 'desiredStateMachineEnabled' <> 'false'::JSONB
        OR NEW."policy" -> 'desiredDispatchEnabled' <> 'false'::JSONB
        OR NEW."policy" -> 'emergencyStopEngaged' <> 'true'::JSONB
        OR NEW."policy" -> 'globalKillSwitch' <> 'true'::JSONB
        OR NEW."policy" #> '{limits,maxConcurrentGlobal}' <> '0'::JSONB
        OR NEW."policy" #> '{limits,maxConcurrentPerWorkflow}' <> '0'::JSONB
        OR NEW."policy" #> '{limits,maxConcurrentPerAgent}' <> '0'::JSONB
        OR NEW."policy" #> '{limits,maxRetryableFailures}' <> '0'::JSONB
        OR NEW."policy" #> '{limits,leaseDurationMs}' <> '120000'::JSONB
        OR NEW."policy" #> '{limits,heartbeatIntervalMs}' <> '30000'::JSONB
        OR NEW."policy" #> '{limits,maxAttemptDurationMs}' <> '600000'::JSONB
        OR NEW."policy" #> '{limits,dailyJobLimit}' <> '0'::JSONB
        OR NEW."policy" #> '{operatingWindow,enabled}' <> 'false'::JSONB
        OR NEW."policy" #>> '{operatingWindow,timezone}' <> 'UTC'
        OR JSONB_TYPEOF(NEW."policy" #> '{operatingWindow,startMinuteUtc}') <> 'null'
        OR JSONB_TYPEOF(NEW."policy" #> '{operatingWindow,endMinuteUtc}') <> 'null'
      THEN RAISE EXCEPTION 'Global genesis must be stopped and fully killed'; END IF;
    ELSIF NEW."policy" -> 'desiredEnabled' <> 'false'::JSONB
      OR NEW."policy" -> 'killSwitch' <> 'true'::JSONB
    THEN
      RAISE EXCEPTION 'Scope genesis must be disabled and killed';
    END IF;
  ELSE
    IF expected_policy_hash IS NOT DISTINCT FROM previous_row."policyHash" THEN
      RAISE EXCEPTION 'Admin policy revision must change the canonical policy hash';
    END IF;

    -- Emergency-stop request identities deliberately carry no CAS. Bind the
    -- immutable ledger chain to the head selected under the same advisory
    -- lock instead of accepting version/hash fields supplied by a caller.
    IF NEW."operationCode" = 'EMERGENCY_STOP' THEN
      NEW."version" := previous_row."version" + 1;
      NEW."previousRevisionHash" := previous_row."revisionHash";
    END IF;

    IF NEW."operationCode" = 'GENESIS'
      OR NEW."version" <> previous_row."version" + 1
      OR NEW."previousRevisionHash" IS DISTINCT FROM previous_row."revisionHash"
      OR NEW."requestId" IS NULL
      OR NEW."actorUserId" IS NULL
      OR NEW."actorRole" IS NULL
      OR NEW."confirmed" <> true
    THEN
      RAISE EXCEPTION 'Admin policy CAS, request, confirmation or hash-chain binding is invalid';
    END IF;

    IF NEW."operationCode" = 'SET_GLOBAL_POLICY' THEN
      IF NEW."scopeType" <> 'GLOBAL'
        OR NEW."expectedVersion" IS DISTINCT FROM previous_row."version"
        OR NEW."expectedRevisionHash" IS DISTINCT FROM previous_row."revisionHash"
        OR NEW."requestedPolicyHash" IS DISTINCT FROM expected_policy_hash
      THEN RAISE EXCEPTION 'SET_GLOBAL_POLICY requires an exact global CAS and policy hash'; END IF;
    ELSIF NEW."operationCode" = 'SET_SCOPE_POLICY' THEN
      IF NEW."scopeType" = 'GLOBAL'
        OR NEW."expectedVersion" IS DISTINCT FROM previous_row."version"
        OR NEW."expectedRevisionHash" IS DISTINCT FROM previous_row."revisionHash"
        OR NEW."requestedPolicyHash" IS DISTINCT FROM expected_policy_hash
      THEN RAISE EXCEPTION 'SET_SCOPE_POLICY requires an exact scope CAS and policy hash'; END IF;
    ELSIF NEW."operationCode" = 'EMERGENCY_STOP' THEN
      IF NEW."scopeType" <> 'GLOBAL'
        OR NEW."policy" IS DISTINCT FROM
          "ai_orchestrator_admin_emergency_policy_v1"(previous_row."policy")
        OR NEW."requestedPolicyHash" IS DISTINCT FROM
          "ai_orchestrator_admin_emergency_intent_hash_v1"()
        OR NEW."expectedVersion" IS NOT NULL
        OR NEW."expectedRevisionHash" IS NOT NULL
      THEN RAISE EXCEPTION 'EMERGENCY_STOP reducer intent or null-only CAS is invalid'; END IF;
    END IF;

    SELECT * INTO actor_row
    FROM "User"
    WHERE "id" = NEW."actorUserId"
    FOR SHARE;
    IF actor_row."id" IS NULL
      OR actor_row."active" <> true
      OR actor_row."deletedAt" IS NOT NULL
      OR actor_row."role"::TEXT IS DISTINCT FROM NEW."actorRole"
    THEN RAISE EXCEPTION 'Admin policy actor must be a current active user'; END IF;

    expected_permissions := "ai_orchestrator_admin_required_permissions_v1"(
      previous_row."policy", NEW."policy", NEW."operationCode"
    );
    IF NEW."requiredPermissions" IS DISTINCT FROM expected_permissions
      OR JSONB_ARRAY_LENGTH(NEW."permissionDecisions") <>
        JSONB_ARRAY_LENGTH(expected_permissions)
    THEN RAISE EXCEPTION 'Dedicated orchestrator permission snapshot is invalid'; END IF;

    FOR permission_index IN 0..JSONB_ARRAY_LENGTH(expected_permissions) - 1 LOOP
      expected_permission := expected_permissions ->> permission_index;
      decision := NEW."permissionDecisions" -> permission_index;
      IF JSONB_TYPEOF(decision) <> 'object'
        OR "count_ai_workflow_jsonb_keys"(decision) <> 3
        OR NOT decision ?& ARRAY['permission', 'allowed', 'source']
        OR decision ->> 'permission' IS DISTINCT FROM expected_permission
        OR decision -> 'allowed' <> 'true'::JSONB
        OR decision ->> 'source' NOT IN ('ADMIN', 'OVERRIDE')
      THEN RAISE EXCEPTION 'Dedicated orchestrator permission decision is invalid'; END IF;

      IF actor_row."role"::TEXT = 'admin' THEN
        expected_source := 'ADMIN';
      ELSE
        PERFORM 1
        FROM "UserPermissionOverride" permission_override
        WHERE permission_override."userId" = actor_row."id"
          AND permission_override."permission" = expected_permission
          AND permission_override."allowed" = true
        FOR SHARE;

        IF FOUND THEN
          expected_source := 'OVERRIDE';
        ELSE
          RAISE EXCEPTION 'Actor lacks dedicated orchestrator permission %', expected_permission;
        END IF;
      END IF;

      IF decision ->> 'source' IS DISTINCT FROM expected_source THEN
        RAISE EXCEPTION 'Orchestrator permission source does not match current RBAC';
      END IF;
    END LOOP;
  END IF;

  request_payload := JSONB_BUILD_OBJECT(
    'schemaVersion', 1,
    'domain', 'AI_ORCHESTRATOR_ADMIN_CONTROL_REQUEST',
    'actorUserId', NEW."actorUserId",
    'requestId', NEW."requestId",
    'scopeType', NEW."scopeType",
    'scopeCode', NEW."scopeCode",
    'expectedVersion', NEW."expectedVersion",
    'expectedRevisionHash', NEW."expectedRevisionHash",
    'operationCode', NEW."operationCode",
    'requestedPolicyHash', NEW."requestedPolicyHash",
    'reasonCode', NEW."reasonCode",
    'reason', NEW."reason",
    'confirmed', NEW."confirmed"
  );
  NEW."requestHash" := "ai_orchestrator_admin_request_hash_v1"(request_payload);

  revision_payload := JSONB_BUILD_OBJECT(
    'schemaVersion', 1,
    'ledgerCode', 'AI_ORCHESTRATOR_ADMIN_POLICY_LEDGER',
    'scopeType', NEW."scopeType",
    'scopeCode', NEW."scopeCode",
    'targetDefinitionHash', NEW."targetDefinitionHash",
    'version', NEW."version",
    'policyHash', NEW."policyHash",
    'previousRevisionHash', NEW."previousRevisionHash",
    'requestId', NEW."requestId",
    'requestHash', NEW."requestHash",
    'operationCode', NEW."operationCode",
    'requiredPermissions', NEW."requiredPermissions",
    'permissionDecisions', NEW."permissionDecisions",
    'actorUserId', NEW."actorUserId",
    'actorRole', NEW."actorRole",
    'reasonCode', NEW."reasonCode",
    'reason', NEW."reason",
    'confirmed', NEW."confirmed"
  );
  NEW."revisionHash" := "ai_orchestrator_admin_revision_hash_v1"(revision_payload);
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiOAdminPolicy_validate_insert"
BEFORE INSERT ON "AiOrchestratorAdminPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION "validate_ai_orchestrator_admin_policy_revision_insert"();

CREATE FUNCTION "reject_ai_orchestrator_admin_policy_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AiOrchestratorAdminPolicyRevision is append-only';
END;
$$;

CREATE TRIGGER "AiOAdminPolicy_immutable_update"
BEFORE UPDATE ON "AiOrchestratorAdminPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_orchestrator_admin_policy_mutation"();
CREATE TRIGGER "AiOAdminPolicy_immutable_delete"
BEFORE DELETE ON "AiOrchestratorAdminPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_orchestrator_admin_policy_mutation"();
CREATE TRIGGER "AiOAdminPolicy_immutable_truncate"
BEFORE TRUNCATE ON "AiOrchestratorAdminPolicyRevision"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_ai_orchestrator_admin_policy_mutation"();

-- The trigger calculates every hash and timestamp server-side. Placeholder
-- values below are intentionally never persisted.
INSERT INTO "AiOrchestratorAdminPolicyRevision" (
  "id", "scopeType", "scopeCode", "targetDefinitionHash", "version",
  "policy", "policyHash", "revisionHash", "requestHash", "operationCode",
  "requiredPermissions", "permissionDecisions", "reasonCode", "reason", "confirmed"
) VALUES (
  'aiocp_genesis_global',
  'GLOBAL',
  'global',
  "ai_orchestrator_admin_target_hash_v1"('GLOBAL', 'global'),
  1,
  JSONB_BUILD_OBJECT(
    'schemaVersion', 1,
    'policyCode', 'AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY',
    'policyVersion', '1.0',
    'activationEpoch', 'FOUNDATION_LOCKED_V1',
    'foundationLocked', true,
    'desiredMode', 'STOPPED',
    'desiredStateMachineEnabled', false,
    'desiredDispatchEnabled', false,
    'emergencyStopEngaged', true,
    'globalKillSwitch', true,
    'provider', 'mock',
    'syntheticDataOnly', true,
    'limits', JSONB_BUILD_OBJECT(
      'maxConcurrentGlobal', 0,
      'maxConcurrentPerWorkflow', 0,
      'maxConcurrentPerAgent', 0,
      'maxRetryableFailures', 0,
      'leaseDurationMs', 120000,
      'heartbeatIntervalMs', 30000,
      'maxAttemptDurationMs', 600000,
      'dailyJobLimit', 0
    ),
    'operatingWindow', JSONB_BUILD_OBJECT(
      'enabled', false,
      'timezone', 'UTC',
      'startMinuteUtc', NULL,
      'endMinuteUtc', NULL
    )
  ),
  REPEAT('0', 64), REPEAT('0', 64), REPEAT('0', 64),
  'GENESIS', '[]'::JSONB, '[]'::JSONB,
  'FOUNDATION_BOOTSTRAP', 'Bootstrap fail-closed Admin Control Plane Foundation v1.', false
);

INSERT INTO "AiOrchestratorAdminPolicyRevision" (
  "id", "scopeType", "scopeCode", "targetDefinitionHash", "version",
  "policy", "policyHash", "revisionHash", "requestHash", "operationCode",
  "requiredPermissions", "permissionDecisions", "reasonCode", "reason", "confirmed"
)
SELECT
  'aiocp_genesis_' || LOWER(scope_row."scopeType") || '_' ||
    SUBSTRING(MD5(scope_row."scopeCode") FROM 1 FOR 24),
  scope_row."scopeType",
  scope_row."scopeCode",
  scope_row."targetDefinitionHash",
  1,
  JSONB_BUILD_OBJECT(
    'schemaVersion', 1,
    'policyCode', 'AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY',
    'policyVersion', '1.0',
    'activationEpoch', 'FOUNDATION_LOCKED_V1',
    'scopeType', scope_row."scopeType",
    'scopeCode', scope_row."scopeCode",
    'targetDefinitionHash', scope_row."targetDefinitionHash",
    'desiredEnabled', false,
    'killSwitch', true
  ),
  REPEAT('0', 64), REPEAT('0', 64), REPEAT('0', 64),
  'GENESIS', '[]'::JSONB, '[]'::JSONB,
  'FOUNDATION_BOOTSTRAP', 'Bootstrap fail-closed Admin Control Plane Foundation v1.', false
FROM (
  SELECT 'PROVIDER'::TEXT AS "scopeType", 'mock'::TEXT AS "scopeCode",
    "ai_orchestrator_admin_target_hash_v1"('PROVIDER', 'mock') AS "targetDefinitionHash"
  UNION ALL
  SELECT 'WORKFLOW', 'FAI-AUDIT-WORKFLOW',
    "ai_orchestrator_admin_target_hash_v1"('WORKFLOW', 'FAI-AUDIT-WORKFLOW')
  UNION ALL
  SELECT 'JOB', setting."jobCode", expected."jobDefinitionHash"
  FROM "AiOrchestratorWorkerCapabilitySetting" setting
  CROSS JOIN LATERAL "expected_ai_workflow_worker_capability"(setting."jobCode") expected
  UNION ALL
  SELECT 'CAPABILITY', expected."capabilityCode", expected."capabilityHash"
  FROM "AiOrchestratorWorkerCapabilitySetting" setting
  CROSS JOIN LATERAL "expected_ai_workflow_worker_capability"(setting."jobCode") expected
  UNION ALL
  SELECT DISTINCT 'AGENT', expected."executorAgentCode", expected."executorAgentConfigHash"
  FROM "AiOrchestratorWorkerCapabilitySetting" setting
  CROSS JOIN LATERAL "expected_ai_workflow_worker_capability"(setting."jobCode") expected
) scope_row
ORDER BY scope_row."scopeType" COLLATE "C", scope_row."scopeCode" COLLATE "C";

-- Final proof: 36 independent genesis chains, all execution intent disabled,
-- no existing operational gate changed, and the PR74 dispatch CHECK remains
-- exact and validated.
DO $$
DECLARE
  revision_rows INTEGER;
  disabled_scope_rows INTEGER;
  dispatch_constraints INTEGER;
BEGIN
  SELECT COUNT(*) INTO revision_rows
  FROM "AiOrchestratorAdminPolicyRevision"
  WHERE "version" = 1
    AND "operationCode" = 'GENESIS'
    AND "previousRevisionHash" IS NULL
    AND "actorUserId" IS NULL
    AND "requestId" IS NULL;

  SELECT COUNT(*) INTO disabled_scope_rows
  FROM "AiOrchestratorAdminPolicyRevision"
  WHERE "scopeType" <> 'GLOBAL'
    AND "policy" -> 'desiredEnabled' = 'false'::JSONB
    AND "policy" -> 'killSwitch' = 'true'::JSONB;

  IF revision_rows <> 36 OR disabled_scope_rows <> 35 THEN
    RAISE EXCEPTION 'Admin Control Plane genesis catalog is incomplete';
  END IF;

  IF (SELECT COUNT(*) FROM "AiOrchestratorAdminPolicyRevision" WHERE "scopeType" = 'JOB') <> 13
    OR (SELECT COUNT(*) FROM "AiOrchestratorAdminPolicyRevision" WHERE "scopeType" = 'CAPABILITY') <> 13
    OR (SELECT COUNT(*) FROM "AiOrchestratorAdminPolicyRevision" WHERE "scopeType" = 'AGENT') <> 7
    OR (SELECT COUNT(*) FROM "AiOrchestratorAdminPolicyRevision" WHERE "scopeType" = 'PROVIDER') <> 1
    OR (SELECT COUNT(*) FROM "AiOrchestratorAdminPolicyRevision" WHERE "scopeType" = 'WORKFLOW') <> 1
    OR (SELECT COUNT(*) FROM "AiOrchestratorAdminPolicyRevision" WHERE "scopeType" = 'GLOBAL') <> 1
  THEN
    RAISE EXCEPTION 'Admin Control Plane genesis scope cardinality is invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "AiOrchestratorSetting"
    WHERE "id" <> 'global'
      OR "stateMachineEnabled" <> false
      OR "dispatchEnabled" <> false
      OR "syntheticDataOnly" <> true
      OR "provider" <> 'mock'
  ) OR EXISTS (
    SELECT 1 FROM "AiOrchestratorWorkerCapabilitySetting" WHERE "enabled" <> false
  ) THEN
    RAISE EXCEPTION 'Admin Control Plane migration changed an operational gate';
  END IF;

  SELECT COUNT(*) INTO dispatch_constraints
  FROM pg_constraint
  WHERE conrelid = '"AiOrchestratorSetting"'::REGCLASS
    AND conname = 'AiOrchestratorSetting_dispatch_disabled_check'
    AND contype = 'c'
    AND convalidated
    AND pg_get_constraintdef(oid) = 'CHECK (("dispatchEnabled" = false))';

  IF dispatch_constraints <> 1 THEN
    RAISE EXCEPTION 'The physical dispatch barrier was not preserved';
  END IF;
END;
$$;

COMMIT;
