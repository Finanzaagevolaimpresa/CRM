-- Additive technical-practice selection structures; no authority, recipient or grant is activated.
-- Production execution requires this exact reviewed SQL and human authority.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>57
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261018190000_selective_client_read_v1'
  AND checksum='55cdaf7e5c714d1fc498ce2bf5131dedc1f05bbafdbb61de5d8dde7ffa753299' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 THEN RAISE EXCEPTION 'SELECTIVE_PRACTICE_SCHEMA57_REQUIRED'; END IF;
END $$;

-- A distinct generation preserves other practice grants when one selection changes.
-- Role, membership and explicit permission changes still invalidate old proofs,
-- including a change subsequently reverted to its former value.
ALTER TABLE "User" ADD COLUMN "selectivePracticeEpoch" INTEGER NOT NULL DEFAULT 1 CHECK ("selectivePracticeEpoch">0);
CREATE FUNCTION fai_selective_practice_user_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.role,NEW.active,NEW."deletedAt",NEW.name,NEW.email) IS DISTINCT FROM
    (OLD.role,OLD.active,OLD."deletedAt",OLD.name,OLD.email) THEN
  NEW."selectivePracticeEpoch":=OLD."selectivePracticeEpoch"+1;
 END IF;
 IF NEW."selectivePracticeEpoch"<OLD."selectivePracticeEpoch" THEN RAISE EXCEPTION 'SELECTIVE_PRACTICE_EPOCH_MONOTONIC'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selective_practice_user_epoch BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION fai_selective_practice_user_epoch();
CREATE FUNCTION fai_selective_practice_permission_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN UPDATE "User" SET "selectivePracticeEpoch"="selectivePracticeEpoch"+1 WHERE id=OLD."userId"; END IF;
 IF TG_OP<>'DELETE' AND (TG_OP='INSERT' OR NEW."userId" IS DISTINCT FROM OLD."userId") THEN
  UPDATE "User" SET "selectivePracticeEpoch"="selectivePracticeEpoch"+1 WHERE id=NEW."userId";
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER selective_practice_permission_epoch AFTER INSERT OR UPDATE OR DELETE ON "UserPermissionOverride"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_practice_permission_epoch();

-- Empty structures only: no personal authority, recipient or real grant enrolled.
CREATE TABLE "SelectivePracticeAuthority" (
 "id" TEXT PRIMARY KEY DEFAULT 'practice-sharing',
 "userId" TEXT NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0),
 "enabled" BOOLEAN NOT NULL DEFAULT false,
 CHECK ("id"='practice-sharing')
);
CREATE TABLE "SelectivePracticeGrant" (
 "id" UUID PRIMARY KEY,
 "practiceId" TEXT NOT NULL REFERENCES "TechnicalPractice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "recipientId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" INTEGER NOT NULL CHECK ("revision">0),
 "payload" JSONB NOT NULL CHECK (jsonb_typeof("payload")='object'),
 "proof" TEXT NOT NULL CHECK ("proof" ~ '^[a-f0-9]{64}$'),
 "revokedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("practiceId","recipientId")
);
ALTER TABLE "SelectivePracticeGrant" ADD CONSTRAINT selective_practice_payload_structure CHECK ((
 jsonb_typeof(payload->'selection')='object' AND (payload->>'contextHash') ~ '^[a-f0-9]{64}$' AND jsonb_typeof(payload->'selection'->'fields')='array'
 AND jsonb_array_length(payload->'selection'->'fields') BETWEEN 1 AND 6
 AND payload->>'id'=id::text AND payload->>'revision'=revision::text
 AND payload->'selection'->>'practiceId'="practiceId" AND payload->'selection'->>'recipientId'="recipientId"
 AND payload->'selection'->>'revision'=(revision-1)::text
) IS TRUE);
CREATE INDEX "SelectivePracticeGrant_recipientId_idx" ON "SelectivePracticeGrant"("recipientId");
CREATE TABLE "SelectivePracticeCommand" (
 "id" UUID PRIMARY KEY,
 "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sessionId" UUID NOT NULL,
 "practiceId" TEXT NOT NULL REFERENCES "TechnicalPractice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "recipientId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "expectedRevision" INTEGER NOT NULL CHECK ("expectedRevision">=0),
 "operation" VARCHAR(12) NOT NULL CHECK ("operation" IN ('GRANT','REVOKE')),
 "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
 "receipt" JSONB NOT NULL CHECK (jsonb_typeof("receipt")='object'),
 "receiptProof" VARCHAR(64) NOT NULL CHECK ("receiptProof" ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
 CHECK ("actorId"<>"recipientId")
);
CREATE INDEX "SelectivePracticeCommand_actorId_createdAt_idx" ON "SelectivePracticeCommand"("actorId","createdAt");
CREATE TABLE "SelectivePracticeRevision" (
 "id" UUID PRIMARY KEY,
 "grantId" UUID NOT NULL REFERENCES "SelectivePracticeGrant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" INTEGER NOT NULL CHECK ("revision">0),
 "commandId" UUID NOT NULL UNIQUE REFERENCES "SelectivePracticeCommand"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "payload" JSONB NOT NULL CHECK (jsonb_typeof("payload")='object'),
 "proof" TEXT NOT NULL CHECK ("proof" ~ '^[a-f0-9]{64}$'),
 "revokedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
 UNIQUE ("grantId","revision")
);

CREATE FUNCTION fai_selective_practice_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SELECTIVE_PRACTICE_HISTORY_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'SELECTIVE_PRACTICE_INITIAL_REVISION'; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='SelectivePracticeGrant' THEN
  IF NEW.id<>OLD.id OR NEW."practiceId"<>OLD."practiceId" OR NEW."recipientId"<>OLD."recipientId"
   OR NEW."createdAt"<>OLD."createdAt" OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'SELECTIVE_PRACTICE_IDENTITY_OR_REVISION';
  END IF;
 ELSIF TG_TABLE_NAME='SelectivePracticeAuthority' THEN
  IF NEW.id<>OLD.id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'SELECTIVE_PRACTICE_AUTHORITY_REVISION'; END IF;
 ELSE RAISE EXCEPTION 'SELECTIVE_PRACTICE_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selective_practice_grant_retention BEFORE INSERT OR UPDATE OR DELETE ON "SelectivePracticeGrant"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_practice_retained();
CREATE TRIGGER selective_practice_authority_retention BEFORE UPDATE OR DELETE ON "SelectivePracticeAuthority"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_practice_retained();
CREATE TRIGGER selective_practice_command_immutable BEFORE UPDATE OR DELETE ON "SelectivePracticeCommand"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_practice_retained();
CREATE TRIGGER selective_practice_revision_immutable BEFORE UPDATE OR DELETE ON "SelectivePracticeRevision"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_practice_retained();

-- Existing notification generations invalidate outstanding recipient admissions.
-- Grant proofs use their separate selectivePracticeEpoch, so another practice selection
-- does not invalidate an unrelated grant.
CREATE TRIGGER record_update_selective_practice_grant_epoch AFTER INSERT OR UPDATE ON "SelectivePracticeGrant"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_grant_epoch('recipientId');

-- Every current revision requires its immutable command, history and minimized
-- audit in the same transaction. The application separately verifies HMAC,
-- personal authority, current sessions/permissions, locks and wall-clock expiry.
CREATE FUNCTION fai_selective_practice_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g "SelectivePracticeGrant"%ROWTYPE; h "SelectivePracticeRevision"%ROWTYPE;
 c "SelectivePracticeCommand"%ROWTYPE; a "AuditLog"%ROWTYPE; grant_id uuid; rev integer;
BEGIN
 IF TG_TABLE_NAME='SelectivePracticeGrant' THEN grant_id:=NEW.id;rev:=NEW.revision;
 ELSIF TG_TABLE_NAME='SelectivePracticeRevision' THEN grant_id:=NEW."grantId";rev:=NEW.revision;
 ELSE
  SELECT * INTO h FROM "SelectivePracticeRevision" WHERE "commandId"=NEW.id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'SELECTIVE_PRACTICE_ATOMIC_HISTORY'; END IF;
  grant_id:=h."grantId";rev:=h.revision;
 END IF;
 SELECT * INTO g FROM "SelectivePracticeGrant" WHERE id=grant_id;
 SELECT * INTO h FROM "SelectivePracticeRevision" WHERE "grantId"=grant_id AND revision=rev;
 SELECT * INTO c FROM "SelectivePracticeCommand" WHERE id=h."commandId";
 SELECT * INTO a FROM "AuditLog" WHERE id=h.id::text;
 IF g.id IS NULL OR h.id IS NULL OR c.id IS NULL OR a.id IS NULL
  OR g.revision<>rev OR h."transactionId"<>txid_current() OR c."transactionId"<>txid_current()
  OR c."practiceId"<>g."practiceId" OR c."recipientId"<>g."recipientId" OR c."expectedRevision"+1<>rev
  OR g.payload->>'approvedById' IS DISTINCT FROM c."actorId"
  OR g.payload->'selection'->>'commandId' IS DISTINCT FROM c.id::text
  OR (rev>1 AND NOT EXISTS (SELECT 1 FROM "SelectivePracticeRevision" WHERE "grantId"=g.id AND revision=rev-1))
  OR c.receipt->>'commandId' IS DISTINCT FROM c.id::text
  OR c.receipt->>'grantId' IS DISTINCT FROM g.id::text OR c.receipt->>'revisionId' IS DISTINCT FROM h.id::text
  OR c.receipt->>'revision' IS DISTINCT FROM rev::text OR c.receipt->>'operation' IS DISTINCT FROM c.operation
  OR c.receipt->>'fieldCount' IS DISTINCT FROM jsonb_array_length(g.payload->'selection'->'fields')::text
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=h.id::text AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR h.payload IS DISTINCT FROM g.payload OR h.proof<>g.proof OR h."revokedAt" IS DISTINCT FROM g."revokedAt"
  OR (c.operation='REVOKE') IS DISTINCT FROM (g."revokedAt" IS NOT NULL)
  OR a."actorId" IS DISTINCT FROM c."actorId" OR a.event<>'selective_practice_changed'
  OR a."entityType"<>'SelectivePracticeRevision' OR a."entityId"<>h.id::text
  OR a."before" IS DISTINCT FROM jsonb_build_object('version',c."expectedRevision")
  OR a."after" IS DISTINCT FROM jsonb_build_object('version',rev,'action',c.operation,
    'fieldCount',jsonb_array_length(g.payload->'selection'->'fields')) THEN
  RAISE EXCEPTION 'SELECTIVE_PRACTICE_ATOMIC_HISTORY';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER selective_practice_grant_atomic AFTER INSERT OR UPDATE ON "SelectivePracticeGrant"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_selective_practice_atomic();
CREATE CONSTRAINT TRIGGER selective_practice_revision_atomic AFTER INSERT ON "SelectivePracticeRevision"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_selective_practice_atomic();
CREATE CONSTRAINT TRIGGER selective_practice_command_atomic AFTER INSERT ON "SelectivePracticeCommand"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_selective_practice_atomic();
COMMIT;
