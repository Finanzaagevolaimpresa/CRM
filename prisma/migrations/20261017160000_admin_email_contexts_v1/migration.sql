BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Migration52. No existing content, decision, binding, cursor or grant is rewritten.
DO $$ BEGIN
  IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> 51
    OR NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261017120000_ordinary_email_v1'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
    OR EXISTS (SELECT 1 FROM pg_tables WHERE schemaname=current_schema()
      AND tablename IN ('InternalCommunicationThread','InternalCommunicationParticipant','CommunicationContextFile')) THEN
    RAISE EXCEPTION 'ADMIN_EMAIL_MIGRATION52_BASE_REQUIRED';
  END IF;
END $$;

CREATE TABLE "InternalCommunicationThread" (
  "id" UUID PRIMARY KEY,
  "title" VARCHAR(200) NOT NULL CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  "ownerUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version">0),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(3)
);
CREATE TABLE "InternalCommunicationParticipant" (
  "threadId" UUID NOT NULL REFERENCES "InternalCommunicationThread"("id") ON DELETE RESTRICT,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version">0),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("threadId","userId")
);
CREATE INDEX "InternalCommunicationParticipant_userId_active_idx" ON "InternalCommunicationParticipant"("userId","active");
CREATE INDEX "InternalCommunicationThread_ownerUserId_updatedAt_idx" ON "InternalCommunicationThread"("ownerUserId","updatedAt");

ALTER TABLE "ApprovedCommunication" ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "ApprovedCommunication" ADD COLUMN "contextKind" VARCHAR(20) NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "ApprovedCommunication" ADD COLUMN "leadId" TEXT REFERENCES "Lead"("id") ON DELETE RESTRICT;
ALTER TABLE "ApprovedCommunication" ADD COLUMN "internalThreadId" UUID REFERENCES "InternalCommunicationThread"("id") ON DELETE RESTRICT;
ALTER TABLE "ApprovedCommunication" DROP CONSTRAINT "ApprovedCommunication_context_state_ck";
ALTER TABLE "ApprovedCommunication" ADD CONSTRAINT "ApprovedCommunication_context_state_ck" CHECK (
  "currentRevision">0 AND "state" IN ('DRAFT','PENDING','APPROVED','SENDING','SENT','ERROR','UNCERTAIN')
  AND CASE "contextKind"
    WHEN 'LEGACY' THEN "clientId" IS NOT NULL AND ("readinessId" IS NULL) <> ("technicalPracticeId" IS NULL)
      AND "leadId" IS NULL AND "internalThreadId" IS NULL
    WHEN 'CLIENT' THEN "clientId" IS NOT NULL AND "readinessId" IS NULL AND "technicalPracticeId" IS NULL
      AND "leadId" IS NULL AND "internalThreadId" IS NULL
    WHEN 'LEAD' THEN "clientId" IS NULL AND "readinessId" IS NULL AND "technicalPracticeId" IS NULL
      AND "leadId" IS NOT NULL AND "internalThreadId" IS NULL
    WHEN 'INTERNAL' THEN "clientId" IS NULL AND "readinessId" IS NULL AND "technicalPracticeId" IS NULL
      AND "leadId" IS NULL AND "internalThreadId" IS NOT NULL
    ELSE false END
);
CREATE INDEX "ApprovedCommunication_leadId_updatedAt_idx" ON "ApprovedCommunication"("leadId","updatedAt");
CREATE INDEX "ApprovedCommunication_internalThreadId_updatedAt_idx" ON "ApprovedCommunication"("internalThreadId","updatedAt");
CREATE INDEX "ApprovedCommunication_contextKind_clientId_updatedAt_idx" ON "ApprovedCommunication"("contextKind","clientId","updatedAt");

ALTER TABLE "CommunicationVersion" DROP CONSTRAINT "CommunicationVersion_snapshot_ck";
ALTER TABLE "CommunicationVersion" ADD CONSTRAINT "CommunicationVersion_snapshot_ck" CHECK (
  "revision">0 AND "snapshotHash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("snapshot")='object'
  AND "snapshot" ?& ARRAY['schema','messageId','revision','mailboxRevision']
  AND jsonb_typeof("snapshot"->'schema')='string' AND jsonb_typeof("snapshot"->'messageId')='string'
  AND jsonb_typeof("snapshot"->'revision')='number' AND jsonb_typeof("snapshot"->'mailboxRevision')='number'
  AND "snapshot"->>'schema' IN ('fai.approved-email.v1','fai.approved-email.v2')
  AND "snapshot"->>'messageId'="messageId"::text AND ("snapshot"->>'revision')::integer="revision"
  AND ("snapshot"->>'schema'='fai.approved-email.v1' OR (
    "snapshot" ?& ARRAY['context','clientId','recipientSelection','externalRecipients','recipientEvidenceHash','contextEvidenceHash']
    AND jsonb_typeof("snapshot"->'recipientSelection')='object'
    AND jsonb_typeof("snapshot"->'externalRecipients')='object'
    AND jsonb_typeof("snapshot"->'recipientEvidenceHash')='string'
    AND jsonb_typeof("snapshot"->'contextEvidenceHash')='string'
    AND "snapshot"->>'recipientEvidenceHash' ~ '^[a-f0-9]{64}$'
    AND "snapshot"->>'contextEvidenceHash' ~ '^[a-f0-9]{64}$'))
);

-- Context uploads reuse the existing private local storage and bounded reader.
-- They are not general dossier documents: no broad document index can expose them.
CREATE TABLE "CommunicationContextFile" (
  "id" UUID PRIMARY KEY,
  "contextKind" VARCHAR(20) NOT NULL,
  "clientId" TEXT REFERENCES "Client"("id") ON DELETE RESTRICT,
  "leadId" TEXT REFERENCES "Lead"("id") ON DELETE RESTRICT,
  "readinessId" UUID REFERENCES "PracticeReadiness"("id") ON DELETE RESTRICT,
  "technicalPracticeId" TEXT REFERENCES "TechnicalPractice"("id") ON DELETE RESTRICT,
  "internalThreadId" UUID REFERENCES "InternalCommunicationThread"("id") ON DELETE RESTRICT,
  "uploadedById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "fileName" VARCHAR(200) NOT NULL CHECK (length("fileName")>0),
  "mimeType" VARCHAR(120) NOT NULL,
  "classification" VARCHAR(20) NOT NULL DEFAULT 'ORDINARY' CHECK ("classification" IN ('ORDINARY','SENSITIVE','COMPLAINT')),
  "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes">0 AND "sizeBytes"<=20971520),
  "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "storagePath" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMPTZ(3),
  CONSTRAINT "CommunicationContextFile_context_ck" CHECK (
    num_nonnulls("clientId","leadId","readinessId","technicalPracticeId","internalThreadId")=1
    AND CASE "contextKind"
      WHEN 'CLIENT' THEN "clientId" IS NOT NULL
      WHEN 'LEAD' THEN "leadId" IS NOT NULL
      WHEN 'READINESS' THEN "readinessId" IS NOT NULL
      WHEN 'TECHNICAL' THEN "technicalPracticeId" IS NOT NULL
      WHEN 'INTERNAL' THEN "internalThreadId" IS NOT NULL
      ELSE false END
  )
);
CREATE INDEX "CommunicationContextFile_clientId_createdAt_idx" ON "CommunicationContextFile"("clientId","createdAt");
CREATE INDEX "CommunicationContextFile_leadId_createdAt_idx" ON "CommunicationContextFile"("leadId","createdAt");
CREATE INDEX "CommunicationContextFile_readinessId_createdAt_idx" ON "CommunicationContextFile"("readinessId","createdAt");
CREATE INDEX "CommunicationContextFile_technicalPracticeId_createdAt_idx" ON "CommunicationContextFile"("technicalPracticeId","createdAt");
CREATE INDEX "CommunicationContextFile_internalThreadId_createdAt_idx" ON "CommunicationContextFile"("internalThreadId","createdAt");

CREATE FUNCTION "admin_email_context_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW."id",NEW."clientId",NEW."readinessId",NEW."technicalPracticeId",NEW."contextKind",NEW."leadId",NEW."internalThreadId",NEW."createdById",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id",OLD."clientId",OLD."readinessId",OLD."technicalPracticeId",OLD."contextKind",OLD."leadId",OLD."internalThreadId",OLD."createdById",OLD."createdAt") THEN
    RAISE EXCEPTION 'COMMUNICATION_CONTEXT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ApprovedCommunication_context_immutable" BEFORE UPDATE ON "ApprovedCommunication" FOR EACH ROW EXECUTE FUNCTION "admin_email_context_immutable"();
CREATE TRIGGER "InternalCommunicationThread_no_delete" BEFORE DELETE ON "InternalCommunicationThread" FOR EACH ROW EXECUTE FUNCTION "m4_immutable_evidence"();
CREATE TRIGGER "InternalCommunicationParticipant_no_delete" BEFORE DELETE ON "InternalCommunicationParticipant" FOR EACH ROW EXECUTE FUNCTION "m4_immutable_evidence"();
CREATE TRIGGER "CommunicationContextFile_no_delete" BEFORE DELETE ON "CommunicationContextFile" FOR EACH ROW EXECUTE FUNCTION "m4_immutable_evidence"();
CREATE FUNCTION "communication_file_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (to_jsonb(NEW)-'revokedAt') IS DISTINCT FROM (to_jsonb(OLD)-'revokedAt')
    OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
    RAISE EXCEPTION 'COMMUNICATION_FILE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CommunicationContextFile_immutable" BEFORE UPDATE ON "CommunicationContextFile" FOR EACH ROW EXECUTE FUNCTION "communication_file_immutable"();
-- No seed, provider change, scheduler, personal authority or recipient grant.
COMMIT;
