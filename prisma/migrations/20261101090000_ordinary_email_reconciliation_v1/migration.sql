BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Additive schema75: preserve every original decision, claim and receipt.
-- No bootstrap, send, activation, credential change or existing-data rewrite.
DO $$ BEGIN
  IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> 74
    OR NOT EXISTS (SELECT 1 FROM "_prisma_migrations"
      WHERE migration_name='20261030190000_admin_residual_provenance_v1' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
    OR to_regclass('public."OrdinaryEmailReconciliation"') IS NOT NULL THEN
    RAISE EXCEPTION 'ORDINARY_EMAIL_RECONCILIATION_SCHEMA74_REQUIRED';
  END IF;
END $$;
CREATE TABLE "OrdinaryEmailReconciliation" (
  "id" UUID PRIMARY KEY,
  "attemptId" UUID NOT NULL UNIQUE REFERENCES "OrdinaryEmailAttempt"("id") ON DELETE RESTRICT,
  "claimId" UUID NOT NULL UNIQUE REFERENCES "OrdinaryEmailClaim"("id") ON DELETE RESTRICT,
  "previousOutcomeId" UUID UNIQUE REFERENCES "OrdinaryEmailOutcome"("id") ON DELETE RESTRICT,
  "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "sessionId" UUID NOT NULL REFERENCES "InternalSession"("id") ON DELETE RESTRICT,
  "keyVersion" INTEGER NOT NULL CHECK ("keyVersion">0),
  "reason" VARCHAR(500) NOT NULL CHECK (length(trim("reason")) BETWEEN 3 AND 500),
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('ACCEPTED','NOT_SENT')),
  "phase" TEXT NOT NULL CHECK ("phase" IN ('CLAIM','CONNECT','GREETING','EHLO','AUTH','MAIL','RCPT','DATA','CONTENT')),
  "replyCode" INTEGER CHECK ("replyCode" BETWEEN 200 AND 599),
  "observation" JSONB NOT NULL CHECK (jsonb_typeof("observation")='object'),
  "sourceHash" CHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ("outcome"<>'ACCEPTED' OR ("phase"='CONTENT' AND "replyCode" IS NOT NULL AND "replyCode"=250)),
  CHECK ("phase"<>'CONTENT' OR "outcome"<>'NOT_SENT' OR ("replyCode" IS NOT NULL AND "replyCode" BETWEEN 400 AND 599))
);
CREATE FUNCTION "ordinary_email_reconciliation_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "OrdinaryEmailAttempt" a
    JOIN "OrdinaryEmailDecision" d ON d."id"=a."decisionId"
    JOIN "OrdinaryEmailClaim" c ON c."attemptId"=a."id"
    LEFT JOIN "OrdinaryEmailOutcome" o ON o."attemptId"=a."id"
    WHERE a."id"=NEW."attemptId" AND c."id"=NEW."claimId" AND c."expiresAt"<=clock_timestamp()
      AND ((a."state"='CLAIMED' AND o."id" IS NULL AND NEW."previousOutcomeId" IS NULL)
        OR (a."state"='UNCERTAIN' AND o."outcome"='UNCERTAIN' AND NEW."previousOutcomeId"=o."id"))
      AND NEW."observation"->'observation'->>'protocol'='FAI_ORDINARY_TRANSPORT_OBSERVATION_V1'
      AND NEW."observation"->'observation'->>'attemptId'=a."id"::text
      AND (NEW."observation"->'observation'->>'claimExpiresAt')::timestamptz=c."expiresAt"
      AND NEW."observation"->'observation'->>'intentHash'=d."decision"->>'intentHash'
      AND NEW."observation"->'observation'->>'mimeHash'=d."decision"->>'mimeHash'
      AND NEW."observation"->'observation'->>'envelopeHash'=d."envelopeHash"
      AND NEW."observation"->'observation'->>'outcome'=NEW."outcome"
      AND NEW."observation"->'observation'->>'phase'=NEW."phase"
      AND (NEW."observation"->'observation'->>'replyCode')::integer IS NOT DISTINCT FROM NEW."replyCode"
      AND NEW."observation"->>'mac' ~ '^[a-f0-9]{64}$'
  ) OR NOT EXISTS (SELECT 1 FROM "InternalSession" s JOIN "User" u ON u."id"=s."userId"
    WHERE s."id"=NEW."sessionId" AND s."userId"=NEW."actorId" AND s."revokedAt" IS NULL
      AND s."expiresAt">clock_timestamp() AND u."active" AND u."deletedAt" IS NULL AND u."role"='admin') THEN
    RAISE EXCEPTION 'ORDINARY_EMAIL_RECONCILIATION_BINDING';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrdinaryEmailReconciliation_binding" BEFORE INSERT ON "OrdinaryEmailReconciliation"
  FOR EACH ROW EXECUTE FUNCTION "ordinary_email_reconciliation_binding"();
CREATE TRIGGER "OrdinaryEmailReconciliation_immutable" BEFORE UPDATE OR DELETE ON "OrdinaryEmailReconciliation"
  FOR EACH ROW EXECUTE FUNCTION "ordinary_email_immutable"();
CREATE TRIGGER "OrdinaryEmailReconciliation_no_truncate" BEFORE TRUNCATE ON "OrdinaryEmailReconciliation"
  EXECUTE FUNCTION "ordinary_email_immutable"();

CREATE OR REPLACE FUNCTION "ordinary_email_attempt_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
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
       (OLD."state"='CLAIMED' AND EXISTS (SELECT 1 FROM "OrdinaryEmailOutcome" WHERE "attemptId"=NEW."id" AND "outcome"=NEW."state")) OR
       (OLD."state"='UNCERTAIN' AND NEW."state" IN ('ACCEPTED','NOT_SENT') AND EXISTS (
         SELECT 1 FROM "OrdinaryEmailReconciliation" r JOIN "OrdinaryEmailOutcome" o ON o."id"=r."previousOutcomeId"
         WHERE r."attemptId"=NEW."id" AND r."outcome"=NEW."state" AND o."attemptId"=NEW."id" AND o."outcome"='UNCERTAIN'))) THEN
      RAISE EXCEPTION 'ORDINARY_EMAIL_STATE_TRANSITION';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
COMMIT;
