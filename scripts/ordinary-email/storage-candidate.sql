BEGIN;
-- Isolated candidate, deliberately outside prisma/migrations. Never production SQL.
DO $$
BEGIN
  IF current_database() <> 'fai_crm_test' OR
    (SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname=current_database())
      IS DISTINCT FROM 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1' THEN
    RAISE EXCEPTION 'ORDINARY_EMAIL_SYNTHETIC_DATABASE_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> 50 THEN
    RAISE EXCEPTION 'ORDINARY_EMAIL_SCHEMA50_REQUIRED';
  END IF;
END;
$$;

CREATE TABLE "OrdinaryEmailAuthority" (
  "id" TEXT PRIMARY KEY CHECK ("id"='ordinary-email'),
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "mailboxId" UUID NOT NULL REFERENCES "CommunicationMailbox"("id") ON DELETE RESTRICT,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0),
  "enabled" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "OrdinaryEmailChannel" (
  "mailboxId" UUID PRIMARY KEY REFERENCES "CommunicationMailbox"("id") ON DELETE RESTRICT,
  "mailboxRevision" INTEGER NOT NULL CHECK ("mailboxRevision">0),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0),
  "qualificationReference" VARCHAR(128) NOT NULL CHECK (length("qualificationReference")>0),
  "enabled" BOOLEAN NOT NULL DEFAULT false
);
-- No bootstrap rows, credentials, hostnames, provider activation or real binding.
CREATE TABLE "OrdinaryEmailDecision" (
  "id" UUID PRIMARY KEY,
  "messageId" UUID NOT NULL REFERENCES "ApprovedCommunication"("id") ON DELETE RESTRICT,
  "versionId" UUID NOT NULL REFERENCES "CommunicationVersion"("id") ON DELETE RESTRICT,
  "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "sessionId" UUID NOT NULL REFERENCES "InternalSession"("id") ON DELETE RESTRICT,
  "decision" JSONB NOT NULL CHECK (jsonb_typeof("decision")='object'),
  "decisionHash" CHAR(64) NOT NULL CHECK ("decisionHash" ~ '^[a-f0-9]{64}$'),
  "proof" CHAR(64) NOT NULL CHECK ("proof" ~ '^[a-f0-9]{64}$'),
  "envelopeHash" CHAR(64) NOT NULL CHECK ("envelopeHash" ~ '^[a-f0-9]{64}$'),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE "OrdinaryEmailAttempt" (
  "id" UUID PRIMARY KEY,
  "requestId" UUID NOT NULL UNIQUE,
  "decisionId" UUID NOT NULL UNIQUE REFERENCES "OrdinaryEmailDecision"("id") ON DELETE RESTRICT,
  "messageId" UUID NOT NULL REFERENCES "ApprovedCommunication"("id") ON DELETE RESTRICT,
  "state" TEXT NOT NULL DEFAULT 'RESERVED' CHECK ("state" IN ('RESERVED','CLAIMED','ACCEPTED','NOT_SENT','UNCERTAIN')),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX "OrdinaryEmailAttempt_blocking" ON "OrdinaryEmailAttempt"("messageId")
  WHERE "state" IN ('RESERVED','CLAIMED','ACCEPTED','UNCERTAIN');
CREATE TABLE "OrdinaryEmailClaim" (
  "id" UUID PRIMARY KEY,
  "attemptId" UUID NOT NULL UNIQUE REFERENCES "OrdinaryEmailAttempt"("id") ON DELETE RESTRICT,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ("expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '15 seconds')
);
CREATE TABLE "OrdinaryEmailOutcome" (
  "id" UUID PRIMARY KEY,
  "attemptId" UUID NOT NULL UNIQUE REFERENCES "OrdinaryEmailAttempt"("id") ON DELETE RESTRICT,
  "claimId" UUID NOT NULL UNIQUE REFERENCES "OrdinaryEmailClaim"("id") ON DELETE RESTRICT,
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('ACCEPTED','NOT_SENT','UNCERTAIN')),
  "phase" TEXT NOT NULL CHECK ("phase" IN ('CLAIM','CONNECT','GREETING','EHLO','AUTH','MAIL','RCPT','DATA','CONTENT')),
  "replyCode" INTEGER CHECK ("replyCode" BETWEEN 200 AND 599),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ("outcome" <> 'ACCEPTED' OR ("phase"='CONTENT' AND "replyCode" IS NOT NULL AND "replyCode"=250)),
  CHECK ("phase" <> 'CONTENT' OR "outcome" <> 'NOT_SENT' OR ("replyCode" IS NOT NULL AND "replyCode" BETWEEN 400 AND 599))
);
CREATE FUNCTION "ordinary_email_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ORDINARY_EMAIL_IMMUTABLE'; END;
$$;
CREATE TRIGGER "OrdinaryEmailDecision_immutable" BEFORE UPDATE OR DELETE ON "OrdinaryEmailDecision" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailClaim_immutable" BEFORE UPDATE OR DELETE ON "OrdinaryEmailClaim" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailOutcome_immutable" BEFORE UPDATE OR DELETE ON "OrdinaryEmailOutcome" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailAttempt_no_delete" BEFORE DELETE ON "OrdinaryEmailAttempt" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE FUNCTION "ordinary_email_decision_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."decision"->>'protocol' IS DISTINCT FROM 'FAI_ORDINARY_EMAIL_PERSONAL_DECISION_V1'
    OR NEW."decision"->>'decisionId' IS DISTINCT FROM NEW."id"::text
    OR NEW."decision"->>'messageId' IS DISTINCT FROM NEW."messageId"::text
    OR NEW."decision"->>'actorId' IS DISTINCT FROM NEW."actorId"
    OR NEW."decision"->>'sessionId' IS DISTINCT FROM NEW."sessionId"::text
    OR NOT EXISTS (SELECT 1 FROM "CommunicationVersion" v JOIN "ApprovedCommunication" m ON m."id"=v."messageId"
       WHERE v."id"=NEW."versionId" AND m."id"=NEW."messageId" AND v."revision"=m."currentRevision"
       AND v."snapshotHash"=NEW."decision"->>'draftHash' AND v."revision"::text=NEW."decision"->>'draftRevision')
    OR NOT EXISTS (SELECT 1 FROM "InternalSession" WHERE "id"=NEW."sessionId" AND "userId"=NEW."actorId") THEN
    RAISE EXCEPTION 'ORDINARY_EMAIL_DECISION_BINDING';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrdinaryEmailDecision_binding" BEFORE INSERT ON "OrdinaryEmailDecision" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_decision_binding"();

CREATE FUNCTION "ordinary_email_attempt_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "OrdinaryEmailDecision" WHERE "id"=NEW."decisionId" AND "messageId"=NEW."messageId") THEN
    RAISE EXCEPTION 'ORDINARY_EMAIL_ATTEMPT_BINDING';
  END IF;
  IF TG_OP='INSERT' AND NEW."state"<>'RESERVED' THEN RAISE EXCEPTION 'ORDINARY_EMAIL_INITIAL_STATE'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW."id",NEW."requestId",NEW."decisionId",NEW."messageId",NEW."createdAt") IS DISTINCT FROM
       (OLD."id",OLD."requestId",OLD."decisionId",OLD."messageId",OLD."createdAt") THEN
      RAISE EXCEPTION 'ORDINARY_EMAIL_ATTEMPT_IMMUTABLE_BINDING';
    END IF;
    IF NOT ((OLD."state"='RESERVED' AND NEW."state"='CLAIMED' AND
          EXISTS (SELECT 1 FROM "OrdinaryEmailClaim" WHERE "attemptId"=NEW."id")) OR
       (OLD."state"='CLAIMED' AND EXISTS (SELECT 1 FROM "OrdinaryEmailOutcome" WHERE "attemptId"=NEW."id" AND "outcome"=NEW."state"))) THEN
      RAISE EXCEPTION 'ORDINARY_EMAIL_STATE_TRANSITION';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrdinaryEmailAttempt_binding" BEFORE INSERT OR UPDATE ON "OrdinaryEmailAttempt" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_attempt_binding"();

CREATE FUNCTION "ordinary_email_receipt_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='OrdinaryEmailClaim' THEN
    IF NOT EXISTS (SELECT 1 FROM "OrdinaryEmailAttempt" WHERE "id"=NEW."attemptId" AND "state"='RESERVED') THEN
      RAISE EXCEPTION 'ORDINARY_EMAIL_CLAIM_STATE';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "OrdinaryEmailClaim" c JOIN "OrdinaryEmailAttempt" a ON a."id"=c."attemptId"
      WHERE c."id"=NEW."claimId" AND a."id"=NEW."attemptId" AND a."state"='CLAIMED') THEN
      RAISE EXCEPTION 'ORDINARY_EMAIL_OUTCOME_BINDING';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrdinaryEmailClaim_binding" BEFORE INSERT ON "OrdinaryEmailClaim" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_receipt_binding"();
CREATE TRIGGER "OrdinaryEmailOutcome_binding" BEFORE INSERT ON "OrdinaryEmailOutcome" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_receipt_binding"();
CREATE FUNCTION "ordinary_email_revision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."revision" <> OLD."revision"+1 THEN RAISE EXCEPTION 'ORDINARY_EMAIL_REVISION_REQUIRED'; END IF;
  IF TG_TABLE_NAME='OrdinaryEmailChannel' AND NEW."mailboxId" IS DISTINCT FROM OLD."mailboxId" THEN
    RAISE EXCEPTION 'ORDINARY_EMAIL_CHANNEL_ID_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrdinaryEmailAuthority_revision" BEFORE UPDATE ON "OrdinaryEmailAuthority" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_revision"();
CREATE TRIGGER "OrdinaryEmailChannel_revision" BEFORE UPDATE ON "OrdinaryEmailChannel" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_revision"();
CREATE TRIGGER "OrdinaryEmailAuthority_no_delete" BEFORE DELETE ON "OrdinaryEmailAuthority" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailChannel_no_delete" BEFORE DELETE ON "OrdinaryEmailChannel" FOR EACH ROW EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailAuthority_no_truncate" BEFORE TRUNCATE ON "OrdinaryEmailAuthority" EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailChannel_no_truncate" BEFORE TRUNCATE ON "OrdinaryEmailChannel" EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailDecision_no_truncate" BEFORE TRUNCATE ON "OrdinaryEmailDecision" EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailAttempt_no_truncate" BEFORE TRUNCATE ON "OrdinaryEmailAttempt" EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailClaim_no_truncate" BEFORE TRUNCATE ON "OrdinaryEmailClaim" EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailOutcome_no_truncate" BEFORE TRUNCATE ON "OrdinaryEmailOutcome" EXECUTE FUNCTION "ordinary_email_immutable"();
COMMIT;
