-- LOCAL DRAFT. Not in prisma/migrations, not applied or PostgreSQL-qualified.
-- Empty structures only; no authority, capability, recipient or mutation is enrolled.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>62
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations"
  WHERE migration_name='20261021220000_selective_client_person_fields_v1'
   AND checksum='984a2706bf907492c01aac9ae04889471918244ebeb816564854c9ccc29b0603'
   AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 THEN RAISE EXCEPTION 'SELECTIVE_LEAD_EDIT_SCHEMA62_REQUIRED'; END IF;
END $$;

CREATE TABLE "SelectiveLeadEditAuthority" (
 "id" TEXT PRIMARY KEY DEFAULT 'lead-edit' CHECK ("id"='lead-edit'),
 "userId" TEXT NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0),
 "enabled" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "SelectiveLeadEditGrant" (
 "id" UUID PRIMARY KEY,
 "leadId" TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "recipientId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "readGrantId" UUID NOT NULL REFERENCES "SelectiveLeadGrant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" INTEGER NOT NULL CHECK ("revision">0),
 "payload" JSONB NOT NULL CHECK (jsonb_typeof("payload")='object'),
 "proof" TEXT NOT NULL CHECK ("proof" ~ '^[a-f0-9]{64}$'),
 "revokedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("leadId","recipientId"),
 CONSTRAINT selective_lead_edit_payload_structure CHECK ((
  payload->>'protocol'='SELECTIVE_LEAD_EDIT_GRANT_V1'
  AND payload->>'id'=id::text AND payload->>'revision'=revision::text
  AND payload->'selection'->>'protocol'='SELECTIVE_LEAD_EDIT_SELECTION_V1'
  AND payload->'selection'->>'leadId'="leadId" AND payload->'selection'->>'recipientId'="recipientId"
  AND payload->'selection'->>'readGrantId'="readGrantId"::text
  AND payload->'selection'->>'revision'=(revision-1)::text
  AND jsonb_typeof(payload->'selection'->'fields')='array'
  AND payload->'selection'->'fields' IN ('["interest"]'::jsonb,'["priority"]'::jsonb,
    '["interest","priority"]'::jsonb,'["priority","interest"]'::jsonb)
 ) IS TRUE)
);
CREATE INDEX "SelectiveLeadEditGrant_recipientId_idx" ON "SelectiveLeadEditGrant"("recipientId");

CREATE TABLE "SelectiveLeadEditDecision" (
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
CREATE INDEX "SelectiveLeadEditDecision_actorId_createdAt_idx" ON "SelectiveLeadEditDecision"("actorId","createdAt");
CREATE TABLE "SelectiveLeadEditRevision" (
 "id" UUID PRIMARY KEY,
 "grantId" UUID NOT NULL REFERENCES "SelectiveLeadEditGrant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" INTEGER NOT NULL CHECK ("revision">0),
 "commandId" UUID NOT NULL UNIQUE REFERENCES "SelectiveLeadEditDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "payload" JSONB NOT NULL CHECK (jsonb_typeof("payload")='object'),
 "proof" TEXT NOT NULL CHECK ("proof" ~ '^[a-f0-9]{64}$'),
 "revokedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
 UNIQUE ("grantId","revision")
);

-- A recipient's data-changing command is distinct from the personal decision
-- which granted that capability. No old/new business values are copied here.
CREATE TABLE "SelectiveLeadEditCommand" (
 "id" UUID PRIMARY KEY,
 "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sessionId" UUID NOT NULL,
 "leadId" TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "capabilityId" UUID NOT NULL REFERENCES "SelectiveLeadEditGrant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "capabilityRevision" INTEGER NOT NULL CHECK ("capabilityRevision">0),
 "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
 "beforeVersion" TIMESTAMP(3) NOT NULL,
 "afterVersion" TIMESTAMP(3) NOT NULL,
 "changedFields" TEXT[] NOT NULL,
 "receipt" JSONB NOT NULL CHECK (jsonb_typeof("receipt")='object'),
 "receiptProof" VARCHAR(64) NOT NULL CHECK ("receiptProof" ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
 UNIQUE ("leadId","transactionId"),
 CHECK ("afterVersion">"beforeVersion"),
 CHECK ("changedFields" IN (ARRAY['interest']::text[],ARRAY['priority']::text[],ARRAY['interest','priority']::text[])),
 CONSTRAINT selective_lead_edit_result_structure CHECK ((
  receipt->>'protocol'='SELECTIVE_LEAD_EDIT_RESULT_V1'
  AND receipt->>'commandId'=id::text AND receipt->>'actorId'="actorId" AND receipt->>'leadId'="leadId"
  AND receipt->>'capabilityId'="capabilityId"::text AND receipt->>'capabilityRevision'="capabilityRevision"::text
  AND receipt->>'requestDigest'="requestDigest" AND receipt->'changedFields'=to_jsonb("changedFields")
  AND (receipt->>'beforeVersion')::timestamptz AT TIME ZONE 'UTC'="beforeVersion"
  AND (receipt->>'afterVersion')::timestamptz AT TIME ZONE 'UTC'="afterVersion"
  AND (receipt->>'recordedAt')::timestamptz AT TIME ZONE 'UTC'="createdAt"
  AND jsonb_typeof(receipt->'keyVersion')='number' AND (receipt->>'keyVersion')::integer>0
  AND receipt-ARRAY['protocol','commandId','leadId','actorId','capabilityId','capabilityRevision',
    'requestDigest','beforeVersion','afterVersion','changedFields','recordedAt','keyVersion']='{}'::jsonb
 ) IS TRUE)
);
CREATE INDEX "SelectiveLeadEditCommand_actorId_createdAt_idx" ON "SelectiveLeadEditCommand"("actorId","createdAt");

CREATE FUNCTION fai_selective_lead_edit_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SELECTIVE_LEAD_EDIT_HISTORY_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'SELECTIVE_LEAD_EDIT_INITIAL_REVISION'; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='SelectiveLeadEditGrant' THEN
  IF NEW.id<>OLD.id OR NEW."leadId"<>OLD."leadId" OR NEW."recipientId"<>OLD."recipientId"
   OR NEW."readGrantId"<>OLD."readGrantId" OR NEW."createdAt"<>OLD."createdAt" OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'SELECTIVE_LEAD_EDIT_IDENTITY_OR_REVISION';
  END IF;
 ELSIF TG_TABLE_NAME='SelectiveLeadEditAuthority' THEN
  IF NEW.id<>OLD.id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'SELECTIVE_LEAD_EDIT_AUTHORITY_REVISION'; END IF;
 ELSE RAISE EXCEPTION 'SELECTIVE_LEAD_EDIT_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selective_lead_edit_grant_retention BEFORE INSERT OR UPDATE OR DELETE ON "SelectiveLeadEditGrant"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_edit_retained();
CREATE TRIGGER selective_lead_edit_authority_retention BEFORE UPDATE OR DELETE ON "SelectiveLeadEditAuthority"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_edit_retained();
CREATE TRIGGER selective_lead_edit_decision_immutable BEFORE UPDATE OR DELETE ON "SelectiveLeadEditDecision"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_edit_retained();
CREATE TRIGGER selective_lead_edit_revision_immutable BEFORE UPDATE OR DELETE ON "SelectiveLeadEditRevision"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_edit_retained();
CREATE TRIGGER selective_lead_edit_command_immutable BEFORE UPDATE OR DELETE ON "SelectiveLeadEditCommand"
 FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_edit_retained();

CREATE FUNCTION fai_selective_lead_edit_decision_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g "SelectiveLeadEditGrant"%ROWTYPE; h "SelectiveLeadEditRevision"%ROWTYPE;
 c "SelectiveLeadEditDecision"%ROWTYPE; r "SelectiveLeadGrant"%ROWTYPE; a "AuditLog"%ROWTYPE; grant_id uuid; rev integer;
BEGIN
 IF TG_TABLE_NAME='SelectiveLeadEditGrant' THEN grant_id:=NEW.id;rev:=NEW.revision;
 ELSIF TG_TABLE_NAME='SelectiveLeadEditRevision' THEN grant_id:=NEW."grantId";rev:=NEW.revision;
 ELSE
  SELECT * INTO h FROM "SelectiveLeadEditRevision" WHERE "commandId"=NEW.id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'SELECTIVE_LEAD_EDIT_ATOMIC_DECISION'; END IF;
  grant_id:=h."grantId";rev:=h.revision;
 END IF;
 SELECT * INTO g FROM "SelectiveLeadEditGrant" WHERE id=grant_id;
 SELECT * INTO h FROM "SelectiveLeadEditRevision" WHERE "grantId"=grant_id AND revision=rev;
 SELECT * INTO c FROM "SelectiveLeadEditDecision" WHERE id=h."commandId";
 SELECT * INTO r FROM "SelectiveLeadGrant" WHERE id=g."readGrantId";
 SELECT * INTO a FROM "AuditLog" WHERE id=h.id::text;
 IF g.id IS NULL OR h.id IS NULL OR c.id IS NULL OR r.id IS NULL OR a.id IS NULL
  OR g.revision<>rev OR h."transactionId"<>txid_current() OR c."transactionId"<>txid_current()
  OR c."leadId"<>g."leadId" OR c."recipientId"<>g."recipientId" OR c."expectedRevision"+1<>rev
  OR r."leadId"<>g."leadId" OR r."recipientId"<>g."recipientId"
  OR g.payload->>'approvedById' IS DISTINCT FROM c."actorId"
  OR g.payload->'selection'->>'commandId' IS DISTINCT FROM c.id::text
  OR (rev>1 AND NOT EXISTS (SELECT 1 FROM "SelectiveLeadEditRevision" WHERE "grantId"=g.id AND revision=rev-1))
  OR c.receipt->>'protocol' IS DISTINCT FROM 'SELECTIVE_LEAD_EDIT_DECISION_RECEIPT_V1'
  OR c.receipt->>'commandId' IS DISTINCT FROM c.id::text
  OR c.receipt->>'grantId' IS DISTINCT FROM g.id::text OR c.receipt->>'revisionId' IS DISTINCT FROM h.id::text
  OR c.receipt->>'revision' IS DISTINCT FROM rev::text OR c.receipt->>'operation' IS DISTINCT FROM c.operation
  OR c.receipt->>'fieldCount' IS DISTINCT FROM jsonb_array_length(g.payload->'selection'->'fields')::text
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=h.id::text AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR h.payload IS DISTINCT FROM g.payload OR h.proof<>g.proof OR h."revokedAt" IS DISTINCT FROM g."revokedAt"
  OR (c.operation='REVOKE') IS DISTINCT FROM (g."revokedAt" IS NOT NULL)
  OR a."actorId" IS DISTINCT FROM c."actorId" OR a.event<>'selective_lead_edit_capability_changed'
  OR a."entityType"<>'SelectiveLeadEditRevision' OR a."entityId"<>h.id::text
  OR a."before" IS DISTINCT FROM jsonb_build_object('version',c."expectedRevision")
  OR a."after" IS DISTINCT FROM jsonb_build_object('version',rev,'action',c.operation,
    'fieldCount',jsonb_array_length(g.payload->'selection'->'fields')) THEN
  RAISE EXCEPTION 'SELECTIVE_LEAD_EDIT_ATOMIC_DECISION';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER selective_lead_edit_grant_atomic AFTER INSERT OR UPDATE ON "SelectiveLeadEditGrant"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_edit_decision_atomic();
CREATE CONSTRAINT TRIGGER selective_lead_edit_revision_atomic AFTER INSERT ON "SelectiveLeadEditRevision"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_edit_decision_atomic();
CREATE CONSTRAINT TRIGGER selective_lead_edit_decision_atomic AFTER INSERT ON "SelectiveLeadEditDecision"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_edit_decision_atomic();

-- Complements application admission/HMAC, expected-version compare and exact
-- field patching; it does not replace those checks or prove authorization.
CREATE FUNCTION fai_selective_lead_edit_command_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g "SelectiveLeadEditGrant"%ROWTYPE; a "AuditLog"%ROWTYPE;
BEGIN
 SELECT * INTO g FROM "SelectiveLeadEditGrant" WHERE id=NEW."capabilityId";
 SELECT * INTO a FROM "AuditLog" WHERE id=NEW.id::text;
 IF g.id IS NULL OR a.id IS NULL OR NEW."transactionId"<>txid_current()
  OR g."leadId"<>NEW."leadId" OR g."recipientId"<>NEW."actorId" OR g.revision<>NEW."capabilityRevision"
  OR g."revokedAt" IS NOT NULL OR NOT (g.payload->'selection'->'fields' @> to_jsonb(NEW."changedFields"))
  OR NOT EXISTS(SELECT 1 FROM "Lead" l WHERE l.id=NEW."leadId" AND l."updatedAt"=NEW."afterVersion"
    AND l."deletedAt" IS NULL AND l."clientId" IS NULL AND l.status::text<>'archiviato'
    AND l.xmin::text::bigint=(txid_current()%4294967296))
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=NEW.id::text AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR a."actorId" IS DISTINCT FROM NEW."actorId" OR a.event<>'selective_lead_edit_applied'
  OR a."entityType"<>'SelectiveLeadEditCommand' OR a."entityId"<>NEW.id::text
  OR a."before" IS DISTINCT FROM jsonb_build_object('version',NEW.receipt->>'beforeVersion')
  OR a."after" IS DISTINCT FROM jsonb_build_object('version',NEW.receipt->>'afterVersion','fields',to_jsonb(NEW."changedFields")) THEN
  RAISE EXCEPTION 'SELECTIVE_LEAD_EDIT_ATOMIC_COMMAND';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER selective_lead_edit_command_atomic AFTER INSERT ON "SelectiveLeadEditCommand"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_selective_lead_edit_command_atomic();
COMMIT;
