BEGIN;
-- CreateTable
CREATE TABLE "CommunicationMailbox" (
    "id" UUID NOT NULL,
    "address" VARCHAR(254) NOT NULL,
    "purpose" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'UNATTESTED',
    "providerReference" VARCHAR(128),
    "canonicalMailboxId" UUID,
    "canonicalRevision" INTEGER,
    "responsibleUserId" TEXT,
    "canSend" BOOLEAN NOT NULL DEFAULT false,
    "canReceive" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "configuredRevision" INTEGER,
    "configurationReference" VARCHAR(128),
    "testedRevision" INTEGER,
    "testReference" VARCHAR(128),
    "testedAt" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommunicationMailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationMailboxHistory" (
    "id" UUID NOT NULL,
    "mailboxId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "actorId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationMailboxHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovedCommunication" (
    "id" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "readinessId" UUID,
    "technicalPracticeId" TEXT,
    "mailboxId" UUID NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "currentRevision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ApprovedCommunication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationVersion" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotHash" CHAR(64) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationApproval" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "snapshotHash" CHAR(64) NOT NULL,
    "mailboxRevision" INTEGER NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "approverSessionId" UUID NOT NULL,
    "approvedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationAttempt" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "startedById" TEXT NOT NULL,
    "startedSessionId" UUID NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'SENDING',
    "artifactHash" CHAR(64) NOT NULL,
    "evidence" JSONB,
    "evidenceHash" CHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommunicationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationReply" (
    "id" UUID NOT NULL,
    "canonicalMailboxId" UUID NOT NULL,
    "externalMessageId" VARCHAR(255) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "inReplyTo" VARCHAR(255),
    "sender" VARCHAR(254) NOT NULL,
    "subject" VARCHAR(998) NOT NULL,
    "body" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "evidenceReference" VARCHAR(128) NOT NULL,
    "messageId" UUID,
    "acquiredById" TEXT NOT NULL,
    "linkedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationEvent" (
    "id" UUID NOT NULL,
    "messageId" UUID,
    "replyId" UUID,
    "actorId" TEXT NOT NULL,
    "event" VARCHAR(50) NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationMailbox_address_key" ON "CommunicationMailbox"("address");

-- CreateIndex
CREATE INDEX "CommunicationMailboxHistory_mailboxId_createdAt_idx" ON "CommunicationMailboxHistory"("mailboxId", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovedCommunication_readinessId_updatedAt_idx" ON "ApprovedCommunication"("readinessId", "updatedAt");

-- CreateIndex
CREATE INDEX "ApprovedCommunication_technicalPracticeId_updatedAt_idx" ON "ApprovedCommunication"("technicalPracticeId", "updatedAt");

-- CreateIndex
CREATE INDEX "ApprovedCommunication_state_updatedAt_idx" ON "ApprovedCommunication"("state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationVersion_messageId_revision_key" ON "CommunicationVersion"("messageId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationApproval_versionId_key" ON "CommunicationApproval"("versionId");

-- CreateIndex
CREATE INDEX "CommunicationAttempt_messageId_createdAt_idx" ON "CommunicationAttempt"("messageId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAttempt_messageId_requestId_key" ON "CommunicationAttempt"("messageId", "requestId");

-- CreateIndex
CREATE INDEX "CommunicationReply_messageId_receivedAt_idx" ON "CommunicationReply"("messageId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationReply_canonicalMailboxId_externalMessageId_key" ON "CommunicationReply"("canonicalMailboxId", "externalMessageId");

-- CreateIndex
CREATE INDEX "CommunicationEvent_messageId_createdAt_idx" ON "CommunicationEvent"("messageId", "createdAt");

-- AddForeignKey
ALTER TABLE "CommunicationMailbox" ADD CONSTRAINT "CommunicationMailbox_canonicalMailboxId_fkey" FOREIGN KEY ("canonicalMailboxId") REFERENCES "CommunicationMailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationMailbox" ADD CONSTRAINT "CommunicationMailbox_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationMailboxHistory" ADD CONSTRAINT "CommunicationMailboxHistory_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "CommunicationMailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovedCommunication" ADD CONSTRAINT "ApprovedCommunication_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovedCommunication" ADD CONSTRAINT "ApprovedCommunication_readinessId_fkey" FOREIGN KEY ("readinessId") REFERENCES "PracticeReadiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovedCommunication" ADD CONSTRAINT "ApprovedCommunication_technicalPracticeId_fkey" FOREIGN KEY ("technicalPracticeId") REFERENCES "TechnicalPractice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovedCommunication" ADD CONSTRAINT "ApprovedCommunication_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "CommunicationMailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovedCommunication" ADD CONSTRAINT "ApprovedCommunication_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationVersion" ADD CONSTRAINT "CommunicationVersion_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ApprovedCommunication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationApproval" ADD CONSTRAINT "CommunicationApproval_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "CommunicationVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationApproval" ADD CONSTRAINT "CommunicationApproval_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationAttempt" ADD CONSTRAINT "CommunicationAttempt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ApprovedCommunication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationAttempt" ADD CONSTRAINT "CommunicationAttempt_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "CommunicationVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationAttempt" ADD CONSTRAINT "CommunicationAttempt_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "CommunicationApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationReply" ADD CONSTRAINT "CommunicationReply_canonicalMailboxId_fkey" FOREIGN KEY ("canonicalMailboxId") REFERENCES "CommunicationMailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationReply" ADD CONSTRAINT "CommunicationReply_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ApprovedCommunication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationEvent" ADD CONSTRAINT "CommunicationEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ApprovedCommunication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationEvent" ADD CONSTRAINT "CommunicationEvent_replyId_fkey" FOREIGN KEY ("replyId") REFERENCES "CommunicationReply"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only registration is migrated. No provider, account, alias, forwarding or sender is enabled.
INSERT INTO "CommunicationMailbox" ("id", "address", "purpose", "restricted", "updatedAt") VALUES
  (gen_random_uuid(), 'info@finanzaagevolaimpresa.it', 'Primo contatto e commerciale', false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'amministrazione@finanzaagevolaimpresa.it', 'Incarichi, fatture e pagamenti', false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'assistenza@finanzaagevolaimpresa.it', 'Dialogo tecnico', false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'comunicazioni@finanzaagevolaimpresa.it', 'Avanzamenti e report approvati', false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'documenti@finanzaagevolaimpresa.it', 'Documenti della pratica', false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'reclami@finanzaagevolaimpresa.it', 'Reclami riservati', true, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'admin@finanzaagevolaimpresa.it', 'Gestione interna', true, CURRENT_TIMESTAMP);

ALTER TABLE "CommunicationMailbox" ADD CONSTRAINT "CommunicationMailbox_qualification_ck" CHECK (
  "revision" > 0 AND "kind" IN ('UNATTESTED', 'MAILBOX', 'ALIAS', 'FORWARD')
  AND ("canonicalMailboxId" IS NULL OR "canonicalMailboxId" <> "id")
  AND ("address" NOT IN ('reclami@finanzaagevolaimpresa.it', 'admin@finanzaagevolaimpresa.it') OR "restricted")
  AND (NOT "enabled" OR ("configuredRevision" IS NOT NULL AND "testedRevision" IS NOT NULL AND "configuredRevision" = "revision" AND "testedRevision" = "revision"
    AND "configurationReference" IS NOT NULL AND "testReference" IS NOT NULL AND "testedAt" IS NOT NULL
    AND "responsibleUserId" IS NOT NULL AND "canSend" AND "canReceive"))
);
ALTER TABLE "ApprovedCommunication" ADD CONSTRAINT "ApprovedCommunication_context_state_ck" CHECK (
  ("readinessId" IS NULL) <> ("technicalPracticeId" IS NULL)
  AND "currentRevision" > 0 AND "state" IN ('DRAFT', 'PENDING', 'APPROVED', 'SENDING', 'SENT', 'ERROR', 'UNCERTAIN')
);
ALTER TABLE "CommunicationVersion" ADD CONSTRAINT "CommunicationVersion_snapshot_ck" CHECK (
  "revision" > 0 AND "snapshotHash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("snapshot") = 'object'
  AND "snapshot" ?& ARRAY['schema','messageId','revision','mailboxRevision']
  AND jsonb_typeof("snapshot"->'schema') = 'string' AND jsonb_typeof("snapshot"->'messageId') = 'string'
  AND jsonb_typeof("snapshot"->'revision') = 'number' AND jsonb_typeof("snapshot"->'mailboxRevision') = 'number'
  AND "snapshot"->>'schema' = 'fai.approved-email.v1'
  AND "snapshot"->>'messageId' = "messageId"::text
  AND ("snapshot"->>'revision')::integer = "revision"
);
ALTER TABLE "CommunicationAttempt" ADD CONSTRAINT "CommunicationAttempt_state_ck" CHECK (
  "state" IN ('SENDING', 'SENT', 'ERROR', 'UNCERTAIN') AND "artifactHash" ~ '^[a-f0-9]{64}$'
  AND (("evidence" IS NULL AND "evidenceHash" IS NULL AND "state"='SENDING') OR
    ("evidence" IS NOT NULL AND "evidenceHash" IS NOT NULL AND "evidenceHash" ~ '^[a-f0-9]{64}$'))
);
CREATE UNIQUE INDEX "CommunicationAttempt_one_open_idx" ON "CommunicationAttempt" ("messageId") WHERE "state" IN ('SENDING', 'UNCERTAIN');

CREATE FUNCTION "m4_immutable_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'M4_IMMUTABLE_EVIDENCE'; END;
$$;
CREATE TRIGGER "CommunicationVersion_immutable" BEFORE UPDATE OR DELETE ON "CommunicationVersion" FOR EACH ROW EXECUTE FUNCTION "m4_immutable_evidence"();
CREATE TRIGGER "CommunicationApproval_immutable" BEFORE UPDATE OR DELETE ON "CommunicationApproval" FOR EACH ROW EXECUTE FUNCTION "m4_immutable_evidence"();
CREATE TRIGGER "CommunicationMailboxHistory_immutable" BEFORE UPDATE OR DELETE ON "CommunicationMailboxHistory" FOR EACH ROW EXECUTE FUNCTION "m4_immutable_evidence"();
CREATE TRIGGER "CommunicationEvent_immutable" BEFORE UPDATE OR DELETE ON "CommunicationEvent" FOR EACH ROW EXECUTE FUNCTION "m4_immutable_evidence"();

CREATE FUNCTION "m4_approval_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v "CommunicationVersion";
BEGIN
  SELECT * INTO v FROM "CommunicationVersion" WHERE "id"=NEW."versionId";
  IF v."snapshotHash" IS DISTINCT FROM NEW."snapshotHash" OR (v."snapshot"->>'mailboxRevision')::integer IS DISTINCT FROM NEW."mailboxRevision" THEN
    RAISE EXCEPTION 'M4_APPROVAL_BINDING';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CommunicationApproval_binding" BEFORE INSERT ON "CommunicationApproval" FOR EACH ROW EXECUTE FUNCTION "m4_approval_binding"();

CREATE FUNCTION "m4_attempt_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "CommunicationVersion" v JOIN "CommunicationApproval" a ON a."versionId"=v."id"
    WHERE v."id"=NEW."versionId" AND v."messageId"=NEW."messageId" AND a."id"=NEW."approvalId") THEN
    RAISE EXCEPTION 'M4_ATTEMPT_BINDING';
  END IF;
  IF TG_OP='UPDATE' AND (NEW."requestId", NEW."messageId", NEW."versionId", NEW."approvalId", NEW."artifactHash", NEW."startedById", NEW."startedSessionId", NEW."createdAt")
    IS DISTINCT FROM (OLD."requestId", OLD."messageId", OLD."versionId", OLD."approvalId", OLD."artifactHash", OLD."startedById", OLD."startedSessionId", OLD."createdAt") THEN
    RAISE EXCEPTION 'M4_ATTEMPT_IMMUTABLE_BINDING';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CommunicationAttempt_binding" BEFORE INSERT OR UPDATE ON "CommunicationAttempt" FOR EACH ROW EXECUTE FUNCTION "m4_attempt_binding"();
CREATE TRIGGER "CommunicationAttempt_no_delete" BEFORE DELETE ON "CommunicationAttempt" FOR EACH ROW EXECUTE FUNCTION "m4_immutable_evidence"();

CREATE FUNCTION "m4_reply_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."canonicalMailboxId", NEW."externalMessageId", NEW."contentHash", NEW."inReplyTo",
      NEW."sender", NEW."subject", NEW."body", NEW."receivedAt", NEW."evidenceReference", NEW."acquiredById", NEW."createdAt")
    IS DISTINCT FROM
     (OLD."id", OLD."canonicalMailboxId", OLD."externalMessageId", OLD."contentHash", OLD."inReplyTo",
      OLD."sender", OLD."subject", OLD."body", OLD."receivedAt", OLD."evidenceReference", OLD."acquiredById", OLD."createdAt")
    OR (OLD."messageId" IS NOT NULL AND (NEW."messageId", NEW."linkedById") IS DISTINCT FROM (OLD."messageId", OLD."linkedById")) THEN
    RAISE EXCEPTION 'M4_REPLY_IMMUTABLE_EVIDENCE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CommunicationReply_binding" BEFORE UPDATE ON "CommunicationReply" FOR EACH ROW EXECUTE FUNCTION "m4_reply_binding"();
CREATE TRIGGER "CommunicationReply_no_delete" BEFORE DELETE ON "CommunicationReply" FOR EACH ROW EXECUTE FUNCTION "m4_immutable_evidence"();
COMMIT;
