BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>55
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261018060000_record_update_email_drafts_v1'
  AND checksum='91fa5bb389f9d5f9bf61f4cbb156d36de4aa48ddb5d75f41bf305849962dcee4' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 THEN RAISE EXCEPTION 'SELECTIVE_LEAD_SCHEMA55_REQUIRED'; END IF;
END $$;

-- A distinct generation preserves other lead grants when one selection changes.
-- Role, membership and explicit permission changes still invalidate old proofs,
-- including a change subsequently reverted to its former value.
ALTER TABLE "User" ADD COLUMN "selectiveLeadEpoch" INTEGER NOT NULL DEFAULT 1 CHECK ("selectiveLeadEpoch">0);
CREATE FUNCTION fai_selective_lead_user_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.role,NEW.active,NEW."deletedAt",NEW.name,NEW.email) IS DISTINCT FROM
    (OLD.role,OLD.active,OLD."deletedAt",OLD.name,OLD.email) THEN
  NEW."selectiveLeadEpoch":=OLD."selectiveLeadEpoch"+1;
 END IF;
 IF NEW."selectiveLeadEpoch"<OLD."selectiveLeadEpoch" THEN RAISE EXCEPTION 'SELECTIVE_LEAD_EPOCH_MONOTONIC'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selective_lead_user_epoch BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_user_epoch();
CREATE FUNCTION fai_selective_lead_permission_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN UPDATE "User" SET "selectiveLeadEpoch"="selectiveLeadEpoch"+1 WHERE id=OLD."userId"; END IF;
 IF TG_OP<>'DELETE' AND (TG_OP='INSERT' OR NEW."userId" IS DISTINCT FROM OLD."userId") THEN
  UPDATE "User" SET "selectiveLeadEpoch"="selectiveLeadEpoch"+1 WHERE id=NEW."userId";
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER selective_lead_permission_epoch AFTER INSERT OR UPDATE OR DELETE ON "UserPermissionOverride"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_permission_epoch();

-- Empty structures only: no personal authority, recipient or real grant enrolled.
CREATE TABLE "SelectiveLeadAuthority" (
 "id" TEXT PRIMARY KEY DEFAULT 'lead-sharing',
 "userId" TEXT NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0),
 "enabled" BOOLEAN NOT NULL DEFAULT false,
 CHECK ("id"='lead-sharing')
);
CREATE TABLE "SelectiveLeadGrant" (
 "id" UUID PRIMARY KEY,
 "leadId" TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "recipientId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" INTEGER NOT NULL CHECK ("revision">0),
 "payload" JSONB NOT NULL CHECK (jsonb_typeof("payload")='object'),
 "proof" TEXT NOT NULL CHECK ("proof" ~ '^[a-f0-9]{64}$'),
 "revokedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("leadId","recipientId")
);
ALTER TABLE "SelectiveLeadGrant" ADD CONSTRAINT selective_lead_payload_structure CHECK ((
 jsonb_typeof(payload->'selection')='object' AND jsonb_typeof(payload->'selection'->'fields')='array'
 AND jsonb_array_length(payload->'selection'->'fields') BETWEEN 1 AND 12
 AND payload->>'id'=id::text AND payload->>'revision'=revision::text
 AND payload->'selection'->>'leadId'="leadId" AND payload->'selection'->>'recipientId'="recipientId"
 AND payload->'selection'->>'revision'=(revision-1)::text
) IS TRUE);
CREATE INDEX "SelectiveLeadGrant_recipientId_idx" ON "SelectiveLeadGrant"("recipientId");
CREATE TABLE "SelectiveLeadCommand" (
 "id" UUID PRIMARY KEY,
 "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sessionId" UUID NOT NULL,
 "leadId" TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
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
CREATE INDEX "SelectiveLeadCommand_actorId_createdAt_idx" ON "SelectiveLeadCommand"("actorId","createdAt");
CREATE TABLE "SelectiveLeadRevision" (
 "id" UUID PRIMARY KEY,
 "grantId" UUID NOT NULL REFERENCES "SelectiveLeadGrant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" INTEGER NOT NULL CHECK ("revision">0),
 "commandId" UUID NOT NULL UNIQUE REFERENCES "SelectiveLeadCommand"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "payload" JSONB NOT NULL CHECK (jsonb_typeof("payload")='object'),
 "proof" TEXT NOT NULL CHECK ("proof" ~ '^[a-f0-9]{64}$'),
 "revokedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
 UNIQUE ("grantId","revision")
);

CREATE FUNCTION fai_selective_lead_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SELECTIVE_LEAD_HISTORY_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'SELECTIVE_LEAD_INITIAL_REVISION'; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='SelectiveLeadGrant' THEN
  IF NEW.id<>OLD.id OR NEW."leadId"<>OLD."leadId" OR NEW."recipientId"<>OLD."recipientId"
   OR NEW."createdAt"<>OLD."createdAt" OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'SELECTIVE_LEAD_IDENTITY_OR_REVISION';
  END IF;
 ELSIF TG_TABLE_NAME='SelectiveLeadAuthority' THEN
  IF NEW.id<>OLD.id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'SELECTIVE_LEAD_AUTHORITY_REVISION'; END IF;
 ELSE RAISE EXCEPTION 'SELECTIVE_LEAD_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selective_lead_grant_retention BEFORE INSERT OR UPDATE OR DELETE ON "SelectiveLeadGrant"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_retained();
CREATE TRIGGER selective_lead_authority_retention BEFORE UPDATE OR DELETE ON "SelectiveLeadAuthority"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_retained();
CREATE TRIGGER selective_lead_command_immutable BEFORE UPDATE OR DELETE ON "SelectiveLeadCommand"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_retained();
CREATE TRIGGER selective_lead_revision_immutable BEFORE UPDATE OR DELETE ON "SelectiveLeadRevision"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_retained();

-- Existing notification generations invalidate outstanding recipient admissions.
-- Grant proofs use their separate selectiveLeadEpoch, so another lead selection
-- does not invalidate an unrelated grant.
CREATE TRIGGER record_update_lead_grant_epoch AFTER INSERT OR UPDATE ON "SelectiveLeadGrant"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_grant_epoch('recipientId');

-- Every current revision requires its immutable command, history and minimized
-- audit in the same transaction. The application separately verifies HMAC,
-- personal authority, current sessions/permissions, locks and wall-clock expiry.
CREATE FUNCTION fai_selective_lead_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g "SelectiveLeadGrant"%ROWTYPE; h "SelectiveLeadRevision"%ROWTYPE;
 c "SelectiveLeadCommand"%ROWTYPE; a "AuditLog"%ROWTYPE; grant_id uuid; rev integer;
BEGIN
 IF TG_TABLE_NAME='SelectiveLeadGrant' THEN grant_id:=NEW.id;rev:=NEW.revision;
 ELSIF TG_TABLE_NAME='SelectiveLeadRevision' THEN grant_id:=NEW."grantId";rev:=NEW.revision;
 ELSE
  SELECT * INTO h FROM "SelectiveLeadRevision" WHERE "commandId"=NEW.id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'SELECTIVE_LEAD_ATOMIC_HISTORY'; END IF;
  grant_id:=h."grantId";rev:=h.revision;
 END IF;
 SELECT * INTO g FROM "SelectiveLeadGrant" WHERE id=grant_id;
 SELECT * INTO h FROM "SelectiveLeadRevision" WHERE "grantId"=grant_id AND revision=rev;
 SELECT * INTO c FROM "SelectiveLeadCommand" WHERE id=h."commandId";
 SELECT * INTO a FROM "AuditLog" WHERE id=h.id::text;
 IF g.id IS NULL OR h.id IS NULL OR c.id IS NULL OR a.id IS NULL
  OR g.revision<>rev OR h."transactionId"<>txid_current() OR c."transactionId"<>txid_current()
  OR c."leadId"<>g."leadId" OR c."recipientId"<>g."recipientId" OR c."expectedRevision"+1<>rev
  OR g.payload->>'approvedById' IS DISTINCT FROM c."actorId"
  OR g.payload->'selection'->>'commandId' IS DISTINCT FROM c.id::text
  OR (rev>1 AND NOT EXISTS (SELECT 1 FROM "SelectiveLeadRevision" WHERE "grantId"=g.id AND revision=rev-1))
  OR c.receipt->>'commandId' IS DISTINCT FROM c.id::text
  OR c.receipt->>'grantId' IS DISTINCT FROM g.id::text OR c.receipt->>'revisionId' IS DISTINCT FROM h.id::text
  OR c.receipt->>'revision' IS DISTINCT FROM rev::text OR c.receipt->>'operation' IS DISTINCT FROM c.operation
  OR c.receipt->>'fieldCount' IS DISTINCT FROM jsonb_array_length(g.payload->'selection'->'fields')::text
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=h.id::text AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR h.payload IS DISTINCT FROM g.payload OR h.proof<>g.proof OR h."revokedAt" IS DISTINCT FROM g."revokedAt"
  OR (c.operation='REVOKE') IS DISTINCT FROM (g."revokedAt" IS NOT NULL)
  OR a."actorId" IS DISTINCT FROM c."actorId" OR a.event<>'selective_lead_changed'
  OR a."entityType"<>'SelectiveLeadRevision' OR a."entityId"<>h.id::text
  OR a."before" IS DISTINCT FROM jsonb_build_object('version',c."expectedRevision")
  OR a."after" IS DISTINCT FROM jsonb_build_object('version',rev,'action',c.operation,
    'fieldCount',jsonb_array_length(g.payload->'selection'->'fields')) THEN
  RAISE EXCEPTION 'SELECTIVE_LEAD_ATOMIC_HISTORY';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER selective_lead_grant_atomic AFTER INSERT OR UPDATE ON "SelectiveLeadGrant"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_atomic();
CREATE CONSTRAINT TRIGGER selective_lead_revision_atomic AFTER INSERT ON "SelectiveLeadRevision"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_atomic();
CREATE CONSTRAINT TRIGGER selective_lead_command_atomic AFTER INSERT ON "SelectiveLeadCommand"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_atomic();
COMMIT;
