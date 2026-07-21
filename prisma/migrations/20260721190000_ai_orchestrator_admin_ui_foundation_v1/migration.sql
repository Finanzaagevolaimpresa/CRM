-- PR80 — Admin Orchestrator UI Foundation v1.
--
-- This additive migration hardens the immutable administrative reason field
-- and adds the keyset audit index used by the private server-rendered UI. It
-- does not alter runtime gates, worker capabilities, jobs or provider state.

-- Keep the complete lock/preflight/DDL/verification sequence in one PostgreSQL
-- statement. PostgreSQL executes a DO statement atomically, while Prisma can
-- still record the original count-only exception when the preflight fails.
DO $pr80$
DECLARE
  incompatible_reason_count BIGINT;
  legacy_constraints INTEGER;
  hardening_constraints INTEGER;
  dispatch_constraints INTEGER;
BEGIN
  IF TO_REGCLASS('"AiOrchestratorAdminPolicyRevision"') IS NULL THEN
    RAISE EXCEPTION 'PR80 reason hardening requires the PR79 administrative ledger';
  END IF;

  -- Prevent a concurrent append from racing the preflight/constraint install.
  -- The statement-level transaction holds this lock until all DDL is verified.
  EXECUTE 'LOCK TABLE "AiOrchestratorAdminPolicyRevision" IN SHARE ROW EXCLUSIVE MODE';

  SELECT COUNT(*) INTO legacy_constraints
  FROM pg_constraint
  WHERE conrelid = '"AiOrchestratorAdminPolicyRevision"'::REGCLASS
    AND conname = 'AiOAdminPolicy_reason_check'
    AND contype = 'c'
    AND convalidated;

  SELECT COUNT(*) INTO dispatch_constraints
  FROM pg_constraint
  WHERE conrelid = '"AiOrchestratorSetting"'::REGCLASS
    AND conname = 'AiOrchestratorSetting_dispatch_disabled_check'
    AND contype = 'c'
    AND convalidated
    AND PG_GET_CONSTRAINTDEF(oid) = 'CHECK (("dispatchEnabled" = false))';

  IF legacy_constraints <> 1 THEN
    RAISE EXCEPTION 'PR80 requires the validated PR79 reason constraint';
  END IF;
  IF dispatch_constraints <> 1 THEN
    RAISE EXCEPTION 'PR80 must preserve the exact physical dispatch barrier';
  END IF;

  -- Count-only preflight: immutable historical rows are never printed,
  -- updated, re-hashed or sanitized in place.
  SELECT COUNT(*) INTO incompatible_reason_count
  FROM "AiOrchestratorAdminPolicyRevision"
  WHERE CHAR_LENGTH("reason") + CHAR_LENGTH(
      REGEXP_REPLACE("reason", U&'[^\+010000-\+10FFFF]', '', 'g')
    ) > 500
    OR ("reason" COLLATE "C") ~ '[[:cntrl:]]'
    OR ("reason" COLLATE "C") ~ U&'[\0080-\009F]'
    OR (
      (TRANSLATE(
        "reason",
        'ABCDEFGHIJKLMNOPQRSTUVWXYZſK',
        'abcdefghijklmnopqrstuvwxyzsk'
      ) COLLATE "C") ~ 'https?://'
      OR ("reason" COLLATE "C") ~ '<[^>]*>'
      OR POSITION('@' IN "reason") > 0
      OR (TRANSLATE(
        "reason",
        'ABCDEFGHIJKLMNOPQRSTUVWXYZſK',
        'abcdefghijklmnopqrstuvwxyzsk'
      ) COLLATE "C") ~ '(^|[^A-Za-z0-9_])(password|passwd|secret|token|prompt|authorization|cookie|api[ _-]?key)($|[^A-Za-z0-9_])'
    );

  IF incompatible_reason_count <> 0 THEN
    RAISE EXCEPTION
      'PR80 reason hardening blocked by % immutable incompatible revision(s)',
      incompatible_reason_count;
  END IF;

  EXECUTE $constraint$
    ALTER TABLE "AiOrchestratorAdminPolicyRevision"
      ADD CONSTRAINT "AiOAdminPolicy_reason_minimized_v1_check" CHECK (
        -- PostgreSQL counts Unicode scalar values, while PR79/Zod counts
        -- UTF-16 code units. Every supplementary scalar therefore contributes
        -- one additional unit to preserve rollback readability.
        CHAR_LENGTH("reason") + CHAR_LENGTH(
          REGEXP_REPLACE("reason", U&'[^\+010000-\+10FFFF]', '', 'g')
        ) <= 500
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
      ) NOT VALID
  $constraint$;

  EXECUTE $validate$
    ALTER TABLE "AiOrchestratorAdminPolicyRevision"
      VALIDATE CONSTRAINT "AiOAdminPolicy_reason_minimized_v1_check"
  $validate$;

  EXECUTE $index$
    CREATE INDEX "AiOAdminPolicy_audit_cursor_idx"
      ON "AiOrchestratorAdminPolicyRevision"("createdAt", "id")
  $index$;

  -- PR79 classified every mode except READY as a restriction. Replace the
  -- versioned permission derivation atomically so every upward transition in
  -- STOPPED < PAUSED < DRAINING < READY requires the enable permission.
  EXECUTE $required_permissions$
    CREATE OR REPLACE FUNCTION "ai_orchestrator_admin_required_permissions_v1"(
      p_previous_policy JSONB,
      p_next_policy JSONB,
      p_operation_code TEXT
    )
    RETURNS JSONB
    LANGUAGE plpgsql
    IMMUTABLE
    STRICT
    PARALLEL SAFE
    AS $permission_body$
    DECLARE
      needs_configure BOOLEAN := false;
      needs_enable BOOLEAN := false;
      needs_disable BOOLEAN := false;
      needs_kill BOOLEAN := false;
      needs_retry BOOLEAN := false;
      needs_limits BOOLEAN := false;
      needs_agents BOOLEAN := false;
      previous_mode_risk INTEGER;
      next_mode_risk INTEGER;
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
          previous_mode_risk := CASE p_previous_policy ->> 'desiredMode'
            WHEN 'STOPPED' THEN 0
            WHEN 'PAUSED' THEN 1
            WHEN 'DRAINING' THEN 2
            WHEN 'READY' THEN 3
            ELSE NULL
          END;
          next_mode_risk := CASE p_next_policy ->> 'desiredMode'
            WHEN 'STOPPED' THEN 0
            WHEN 'PAUSED' THEN 1
            WHEN 'DRAINING' THEN 2
            WHEN 'READY' THEN 3
            ELSE NULL
          END;
          IF previous_mode_risk IS NULL OR next_mode_risk IS NULL THEN
            RAISE EXCEPTION 'Admin desired mode is not canonical';
          ELSIF next_mode_risk > previous_mode_risk THEN
            needs_enable := true;
          ELSE
            needs_disable := true;
          END IF;
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
    $permission_body$
  $required_permissions$;

  -- Fail closed if validation or either inherited safety invariant drifted.
  SELECT COUNT(*) INTO legacy_constraints
  FROM pg_constraint
  WHERE conrelid = '"AiOrchestratorAdminPolicyRevision"'::REGCLASS
    AND conname = 'AiOAdminPolicy_reason_check'
    AND contype = 'c'
    AND convalidated;

  SELECT COUNT(*) INTO hardening_constraints
  FROM pg_constraint
  WHERE conrelid = '"AiOrchestratorAdminPolicyRevision"'::REGCLASS
    AND conname = 'AiOAdminPolicy_reason_minimized_v1_check'
    AND contype = 'c'
    AND convalidated;

  SELECT COUNT(*) INTO dispatch_constraints
  FROM pg_constraint
  WHERE conrelid = '"AiOrchestratorSetting"'::REGCLASS
    AND conname = 'AiOrchestratorSetting_dispatch_disabled_check'
    AND contype = 'c'
    AND convalidated
    AND PG_GET_CONSTRAINTDEF(oid) = 'CHECK (("dispatchEnabled" = false))';

  IF legacy_constraints <> 1 THEN
    RAISE EXCEPTION 'PR80 must preserve the validated PR79 reason constraint';
  END IF;
  IF hardening_constraints <> 1 THEN
    RAISE EXCEPTION 'PR80 reason minimization constraint is not validated';
  END IF;
  IF dispatch_constraints <> 1 THEN
    RAISE EXCEPTION 'PR80 must preserve the exact physical dispatch barrier';
  END IF;
END;
$pr80$;
