-- Explicit technical assignments: empty structures, no personal enrollment,
-- no conversion of legacy owners into new grants, no operational activation.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>63
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261022110000_selective_lead_edit_v1'
   AND checksum='4534f290bc80f9b41f1c4de1f9df8d88f7402c02c0604797351c07e187c6961c'
   AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 OR EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL
   AND migration_name<>'20261022200000_technical_assignments_v1')
 THEN RAISE EXCEPTION 'TECHNICAL_ASSIGNMENT_SCHEMA63_REQUIRED'; END IF;
END $$;

CREATE TABLE "TechnicalAssignmentAuthority" (
 id TEXT PRIMARY KEY DEFAULT 'technical-assignment' CHECK(id='technical-assignment'),
 "userId" TEXT NOT NULL UNIQUE REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), enabled BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "TechnicalAssignment" (
 id UUID PRIMARY KEY, kind VARCHAR(17) NOT NULL CHECK(kind IN ('Project','TechnicalPractice')),
 "projectId" TEXT REFERENCES "Project"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "practiceId" TEXT REFERENCES "TechnicalPractice"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "recipientId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 revision INTEGER NOT NULL CHECK(revision>0), payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'),
 proof TEXT NOT NULL CHECK(proof ~ '^[a-f0-9]{64}$'), "revokedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("projectId","recipientId"), UNIQUE("practiceId","recipientId"),
 CHECK((kind='Project' AND "projectId" IS NOT NULL AND "practiceId" IS NULL)
    OR (kind='TechnicalPractice' AND "projectId" IS NULL AND "practiceId" IS NOT NULL)),
 CONSTRAINT technical_assignment_payload_structure CHECK ((
  payload->>'protocol'='TECHNICAL_ASSIGNMENT_V1' AND payload->>'id'=id::text
  AND payload->>'revision'=revision::text AND payload->>'targetId'=COALESCE("projectId","practiceId")
  AND payload->'selection'->>'kind'=kind AND payload->'selection'->>'userId'="recipientId"
  AND jsonb_typeof(payload->'selection'->'actions')='array'
  AND jsonb_array_length(payload->'selection'->'actions') BETWEEN 1 AND 6
  AND jsonb_typeof(payload->'selection'->'readableFields')='array'
  AND jsonb_array_length(payload->'selection'->'readableFields') BETWEEN 1 AND 12
  AND jsonb_typeof(payload->'selection'->'editableFields')='array'
  AND jsonb_typeof(payload->'selection'->'documents')='array'
  AND jsonb_array_length(payload->'selection'->'documents') BETWEEN 0 AND 20
 ) IS TRUE)
);
CREATE INDEX "TechnicalAssignment_recipientId_kind_idx" ON "TechnicalAssignment"("recipientId",kind);
CREATE TABLE "TechnicalAssignmentDecision" (
 id UUID PRIMARY KEY, "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sessionId" UUID NOT NULL, kind VARCHAR(17) NOT NULL CHECK(kind IN ('Project','TechnicalPractice')),
 "targetId" TEXT NOT NULL, "recipientId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "expectedRevision" INTEGER NOT NULL CHECK("expectedRevision">=0),
 operation VARCHAR(12) NOT NULL CHECK(operation IN ('ASSIGN','REVOKE')),
 "requestDigest" TEXT NOT NULL CHECK("requestDigest" ~ '^[a-f0-9]{64}$'),
 receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 "receiptProof" TEXT NOT NULL CHECK("receiptProof" ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "transactionId" BIGINT NOT NULL DEFAULT txid_current(), CHECK("actorId"<>"recipientId")
);
CREATE INDEX "TechnicalAssignmentDecision_actorId_createdAt_idx" ON "TechnicalAssignmentDecision"("actorId","createdAt");
CREATE TABLE "TechnicalAssignmentRevision" (
 id UUID PRIMARY KEY, "assignmentId" UUID NOT NULL REFERENCES "TechnicalAssignment"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 revision INTEGER NOT NULL CHECK(revision>0),
 "commandId" UUID NOT NULL UNIQUE REFERENCES "TechnicalAssignmentDecision"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'), proof TEXT NOT NULL CHECK(proof ~ '^[a-f0-9]{64}$'),
 "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "transactionId" BIGINT NOT NULL DEFAULT txid_current(), UNIQUE("assignmentId",revision)
);

CREATE FUNCTION fai_technical_assignment_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'TECHNICAL_ASSIGNMENT_HISTORY_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'TECHNICAL_ASSIGNMENT_INITIAL_REVISION'; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='TechnicalAssignment' THEN
  IF NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
   OR NEW."practiceId" IS DISTINCT FROM OLD."practiceId" OR NEW."recipientId"<>OLD."recipientId"
   OR NEW."createdAt"<>OLD."createdAt" OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'TECHNICAL_ASSIGNMENT_IDENTITY_OR_REVISION'; END IF;
 ELSIF TG_TABLE_NAME='TechnicalAssignmentAuthority' THEN
  IF NEW.id<>OLD.id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'TECHNICAL_ASSIGNMENT_AUTHORITY_REVISION'; END IF;
 ELSE RAISE EXCEPTION 'TECHNICAL_ASSIGNMENT_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER technical_assignment_retention BEFORE INSERT OR UPDATE OR DELETE ON "TechnicalAssignment"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_assignment_authority_retention BEFORE INSERT OR UPDATE OR DELETE ON "TechnicalAssignmentAuthority"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_assignment_decision_immutable BEFORE UPDATE OR DELETE ON "TechnicalAssignmentDecision"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_assignment_revision_immutable BEFORE UPDATE OR DELETE ON "TechnicalAssignmentRevision"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_assignment_no_truncate BEFORE TRUNCATE ON "TechnicalAssignment"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_assignment_authority_no_truncate BEFORE TRUNCATE ON "TechnicalAssignmentAuthority"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_assignment_decision_no_truncate BEFORE TRUNCATE ON "TechnicalAssignmentDecision"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_assignment_revision_no_truncate BEFORE TRUNCATE ON "TechnicalAssignmentRevision"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_technical_assignment_retained();

-- Structural atomicity complements, but does not replace, current admission,
-- registered HMAC proofs, exact preview and current session/permission locks.
CREATE FUNCTION fai_technical_assignment_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g "TechnicalAssignment"%ROWTYPE; h "TechnicalAssignmentRevision"%ROWTYPE;
 c "TechnicalAssignmentDecision"%ROWTYPE; a "AuditLog"%ROWTYPE; assignment_id uuid; rev integer;
 field_count integer; action_count integer; document_count integer;
BEGIN
 IF TG_TABLE_NAME='TechnicalAssignment' THEN assignment_id:=NEW.id; rev:=NEW.revision;
 ELSIF TG_TABLE_NAME='TechnicalAssignmentRevision' THEN assignment_id:=NEW."assignmentId"; rev:=NEW.revision;
 ELSE
  SELECT * INTO h FROM "TechnicalAssignmentRevision" WHERE "commandId"=NEW.id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'TECHNICAL_ASSIGNMENT_ATOMIC_DECISION'; END IF;
  assignment_id:=h."assignmentId"; rev:=h.revision;
 END IF;
 SELECT * INTO g FROM "TechnicalAssignment" WHERE id=assignment_id;
 SELECT * INTO h FROM "TechnicalAssignmentRevision" WHERE "assignmentId"=assignment_id AND revision=rev;
 SELECT * INTO c FROM "TechnicalAssignmentDecision" WHERE id=h."commandId";
 SELECT * INTO a FROM "AuditLog" WHERE id=h.id::text;
 field_count:=jsonb_array_length(g.payload->'selection'->'readableFields');
 action_count:=jsonb_array_length(g.payload->'selection'->'actions');
 document_count:=jsonb_array_length(g.payload->'selection'->'documents');
 IF g.id IS NULL OR h.id IS NULL OR c.id IS NULL OR a.id IS NULL OR g.revision<>rev
  OR h."transactionId"<>txid_current() OR c."transactionId"<>txid_current()
  OR c.kind<>g.kind OR c."targetId"<>COALESCE(g."projectId",g."practiceId")
  OR c."recipientId"<>g."recipientId" OR c."expectedRevision"+1<>rev
  OR g.payload->>'approvedById' IS DISTINCT FROM c."actorId"
  OR g.payload->>'commandId' IS DISTINCT FROM c.id::text
  OR (rev>1 AND NOT EXISTS(SELECT 1 FROM "TechnicalAssignmentRevision" WHERE "assignmentId"=g.id AND revision=rev-1))
  OR h.payload IS DISTINCT FROM g.payload OR h.proof<>g.proof OR h."revokedAt" IS DISTINCT FROM g."revokedAt"
  OR (c.operation='REVOKE') IS DISTINCT FROM (g."revokedAt" IS NOT NULL)
  OR c.receipt->>'protocol' IS DISTINCT FROM 'TECHNICAL_ASSIGNMENT_RECEIPT_V1'
  OR c.receipt->>'commandId' IS DISTINCT FROM c.id::text
  OR c.receipt->>'assignmentId' IS DISTINCT FROM g.id::text
  OR c.receipt->>'revisionId' IS DISTINCT FROM h.id::text OR c.receipt->>'revision' IS DISTINCT FROM rev::text
  OR c.receipt->>'operation' IS DISTINCT FROM c.operation
  OR c.receipt->>'fieldCount' IS DISTINCT FROM field_count::text
  OR c.receipt->>'actionCount' IS DISTINCT FROM action_count::text
  OR c.receipt->>'documentCount' IS DISTINCT FROM document_count::text
  OR c.receipt->>'keyVersion' IS DISTINCT FROM g.payload->>'keyVersion'
  OR c.receipt->>'actorId' IS DISTINCT FROM c."actorId"
  OR c.receipt->>'sessionId' IS DISTINCT FROM c."sessionId"::text
  OR c.receipt->>'requestDigest' IS DISTINCT FROM c."requestDigest"
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=h.id::text AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR a."actorId" IS DISTINCT FROM c."actorId" OR a.event<>'technical_assignment_changed'
  OR a."entityType"<>'TechnicalAssignmentRevision' OR a."entityId"<>h.id::text
  OR a."before" IS DISTINCT FROM jsonb_build_object('version',c."expectedRevision")
  OR a."after" IS DISTINCT FROM jsonb_build_object('version',rev,'action',c.operation,
    'fieldCount',field_count,'actionCount',action_count,'documentCount',document_count)
 THEN RAISE EXCEPTION 'TECHNICAL_ASSIGNMENT_ATOMIC_DECISION'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER technical_assignment_atomic AFTER INSERT OR UPDATE ON "TechnicalAssignment"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_atomic();
CREATE CONSTRAINT TRIGGER technical_assignment_revision_atomic AFTER INSERT ON "TechnicalAssignmentRevision"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_atomic();
CREATE CONSTRAINT TRIGGER technical_assignment_decision_atomic AFTER INSERT ON "TechnicalAssignmentDecision"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_atomic();
COMMIT;
