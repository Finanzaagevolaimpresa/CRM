-- PR80 — Admin Orchestrator UI Foundation v1.
--
-- This additive migration hardens the immutable administrative reason field
-- and adds the keyset audit index used by the private server-rendered UI. It
-- does not alter runtime gates, worker capabilities, jobs or provider state.

BEGIN;

-- Count-only preflight: immutable historical rows are never printed, updated,
-- re-hashed or sanitized in place. An incompatible row aborts the transaction
-- before the new constraint or index is installed.
DO $$
DECLARE
  legacy_reason_constraints INTEGER;
BEGIN
  IF TO_REGCLASS('"AiOrchestratorAdminPolicyRevision"') IS NULL THEN
    RAISE EXCEPTION 'PR80 reason hardening requires the PR79 administrative ledger';
  END IF;

  SELECT COUNT(*) INTO legacy_reason_constraints
  FROM pg_constraint
  WHERE conrelid = '"AiOrchestratorAdminPolicyRevision"'::REGCLASS
    AND conname = 'AiOAdminPolicy_reason_check'
    AND contype = 'c'
    AND convalidated;

  IF legacy_reason_constraints <> 1 THEN
    RAISE EXCEPTION 'PR80 requires the validated PR79 reason constraint';
  END IF;
END;
$$;

-- Prevent a concurrent append from racing the preflight/constraint install.
-- The lock is held only for this migration transaction.
LOCK TABLE "AiOrchestratorAdminPolicyRevision" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  incompatible_reason_count BIGINT;
BEGIN

  SELECT COUNT(*) INTO incompatible_reason_count
  FROM "AiOrchestratorAdminPolicyRevision"
  WHERE "reason" ~ '[[:cntrl:]]'
    OR (
      TRANSLATE(
        "reason",
        'ABCDEFGHIJKLMNOPQRSTUVWXYZſK',
        'abcdefghijklmnopqrstuvwxyzsk'
      ) ~ 'https?://'
      OR "reason" ~ '<[^>]*>'
      OR POSITION('@' IN "reason") > 0
      OR TRANSLATE(
        "reason",
        'ABCDEFGHIJKLMNOPQRSTUVWXYZſK',
        'abcdefghijklmnopqrstuvwxyzsk'
      ) ~ '(^|[^A-Za-z0-9_])(password|passwd|secret|token|prompt|authorization|cookie|api[ _-]?key)($|[^A-Za-z0-9_])'
    );

  IF incompatible_reason_count <> 0 THEN
    RAISE EXCEPTION
      'PR80 reason hardening blocked by % immutable incompatible revision(s)',
      incompatible_reason_count;
  END IF;
END;
$$;

ALTER TABLE "AiOrchestratorAdminPolicyRevision"
  ADD CONSTRAINT "AiOAdminPolicy_reason_minimized_v1_check" CHECK (
    "reason" !~ '[[:cntrl:]]'
    AND TRANSLATE(
      "reason",
      'ABCDEFGHIJKLMNOPQRSTUVWXYZſK',
      'abcdefghijklmnopqrstuvwxyzsk'
    ) !~ 'https?://'
    AND "reason" !~ '<[^>]*>'
    AND POSITION('@' IN "reason") = 0
    AND TRANSLATE(
      "reason",
      'ABCDEFGHIJKLMNOPQRSTUVWXYZſK',
      'abcdefghijklmnopqrstuvwxyzsk'
    ) !~ '(^|[^A-Za-z0-9_])(password|passwd|secret|token|prompt|authorization|cookie|api[ _-]?key)($|[^A-Za-z0-9_])'
  ) NOT VALID;

ALTER TABLE "AiOrchestratorAdminPolicyRevision"
  VALIDATE CONSTRAINT "AiOAdminPolicy_reason_minimized_v1_check";

CREATE INDEX "AiOAdminPolicy_audit_cursor_idx"
  ON "AiOrchestratorAdminPolicyRevision"("createdAt", "id");

-- Fail closed if validation or the exact physical dispatch barrier drifted.
DO $$
DECLARE
  legacy_constraints INTEGER;
  hardening_constraints INTEGER;
  dispatch_constraints INTEGER;
BEGIN
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
$$;

COMMIT;
