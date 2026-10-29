-- Additive operational correction journal. No existing record is rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>71
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261028180000_record_deadline_reminders_v1'
   AND checksum='dfc159e99ab00a8587fe5c50834fd4d651b25ff14d1a9aa5a0b7731abf9652f6'
   AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 OR EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL
   AND migration_name<>'20261029190000_admin_record_revisions_v1')
 THEN RAISE EXCEPTION 'ADMIN_RECORD_SCHEMA71_REQUIRED'; END IF;
END $$;
CREATE TABLE "AdminRecordRevision" (
  "commandId" UUID PRIMARY KEY,
  "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sessionId" UUID NOT NULL REFERENCES "InternalSession"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  model TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('CREATE','UPDATE','TRASH','RESTORE','RECTIFY','CLOSE')),
  "requestHash" CHAR(64) NOT NULL CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  "beforeHash" CHAR(64) NOT NULL CHECK ("beforeHash" ~ '^[a-f0-9]{64}$'),
  "afterHash" CHAR(64) NOT NULL CHECK ("afterHash" ~ '^[a-f0-9]{64}$'),
  before JSONB NOT NULL,
  after JSONB NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 2000),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  CHECK ((before='null'::jsonb OR COALESCE(jsonb_typeof(before)='object' AND jsonb_typeof(before->'id')='string' AND before->>'id'="recordId", false))
     AND (after='null'::jsonb OR COALESCE(jsonb_typeof(after)='object' AND jsonb_typeof(after->'id')='string' AND after->>'id'="recordId", false))),
  CHECK ((operation='CREATE' AND before='null'::jsonb AND after<>'null'::jsonb)
    OR (operation='UPDATE' AND before<>'null'::jsonb AND after<>'null'::jsonb)
    OR (operation='TRASH' AND before<>'null'::jsonb)
    OR (operation='RESTORE' AND after<>'null'::jsonb)
    OR (operation='RECTIFY' AND before<>'null'::jsonb AND before=after)
    OR (operation='CLOSE' AND before='null'::jsonb AND after='null'::jsonb))
);
CREATE INDEX "AdminRecordRevision_model_recordId_createdAt_commandId_idx" ON "AdminRecordRevision"(model,"recordId","createdAt","commandId");
CREATE INDEX "AdminRecordRevision_actorId_createdAt_idx" ON "AdminRecordRevision"("actorId","createdAt");

CREATE FUNCTION fai_admin_record_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ADMIN_REVISION_HISTORY_RETAINED'; END IF;
  IF NEW."transactionId" <> txid_current()
    OR NOT EXISTS (SELECT 1 FROM "User" u JOIN "InternalSession" s ON s."userId"=u.id
      WHERE u.id=NEW."actorId" AND u.role='admin' AND u.active AND u."deletedAt" IS NULL
        AND s.id=NEW."sessionId" AND s."revokedAt" IS NULL AND s."expiresAt">clock_timestamp())
    THEN RAISE EXCEPTION 'ADMIN_REVISION_AUTHORITY_REQUIRED'; END IF;
  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER "AdminRecordRevision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AdminRecordRevision"
  FOR EACH ROW EXECUTE FUNCTION fai_admin_record_revision_guard();
CREATE TRIGGER "AdminRecordRevision_no_truncate" BEFORE TRUNCATE ON "AdminRecordRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION fai_admin_record_revision_guard();

CREATE FUNCTION fai_admin_record_revision_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "AuditLog"%ROWTYPE; expected_audit jsonb;
BEGIN
  SELECT * INTO a FROM "AuditLog" WHERE id='admin-record:'||NEW."commandId"::text;
  -- Audit privacy minimization also applies to UUIDs containing phone-like
  -- digit runs. Bind the exact command through the immutable row ID and compare
  -- the same minimized JSON; never change or bypass the privacy filter.
  expected_audit := audit_sanitize_json_n04_v1(jsonb_build_object('commandId',NEW."commandId"::text));
  IF NEW.operation<>'CLOSE' THEN
    expected_audit := audit_sanitize_json_n04_v1(jsonb_build_object('commandId',NEW."commandId"::text,
      'action',NEW.operation,'beforeHash',NEW."beforeHash",'afterHash',NEW."afterHash"));
  END IF;
  IF NOT FOUND OR a."actorId" IS DISTINCT FROM NEW."actorId" OR a."entityType" IS DISTINCT FROM NEW.model
    OR a."entityId" IS DISTINCT FROM NEW."recordId" OR NOT COALESCE(a.after @> expected_audit, false)
    OR (NEW.operation='CLOSE' AND a.event<>'admin_record_attempt_closed')
    OR (NEW.operation<>'CLOSE' AND a.event<>'admin_record_changed')
    THEN RAISE EXCEPTION 'ADMIN_REVISION_ATOMIC_AUDIT_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "AdminRecordRevision_atomic_audit" AFTER INSERT ON "AdminRecordRevision"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_admin_record_revision_audit_guard();

-- These new command receipts and terminal closures prevent blind retries.
-- They must not disappear or change after a successful commit.
CREATE FUNCTION fai_admin_record_revision_audit_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM "AuditLog" WHERE id LIKE 'admin-record:%'
      OR id LIKE 'technical-attempt:%' OR id LIKE 'technical-private-attempt:%')
      THEN RAISE EXCEPTION 'ADMIN_COMMAND_AUDIT_RETAINED'; END IF;
    RETURN NULL;
  END IF;
  IF OLD.id LIKE 'admin-record:%' OR OLD.id LIKE 'technical-attempt:%' OR OLD.id LIKE 'technical-private-attempt:%'
    THEN RAISE EXCEPTION 'ADMIN_COMMAND_AUDIT_RETAINED'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AdminCommandAudit_retained" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION fai_admin_record_revision_audit_retained();
CREATE TRIGGER "AdminCommandAudit_no_truncate" BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION fai_admin_record_revision_audit_retained();
COMMIT;
