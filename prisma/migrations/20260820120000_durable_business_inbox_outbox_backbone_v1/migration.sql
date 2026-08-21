-- N11 durable business inbox/outbox backbone v1.
-- Additive and deliberately empty: no backfill, seed, producer, consumer or activation.

BEGIN;

CREATE TABLE "BusinessInboxEvent" (
    "id" UUID NOT NULL,
    "schemaVersion" VARCHAR(80) NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "eventVersion" INTEGER NOT NULL,
    "canonicalizationVersion" INTEGER NOT NULL,
    "eventId" UUID NOT NULL,
    "businessCorrelationId" UUID NOT NULL,
    "occurredAt" CHAR(24) NOT NULL,
    "keyDigest" CHAR(64) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "envelopeJson" TEXT NOT NULL,
    "recordHash" CHAR(64) NOT NULL,
    "classificationCatalogVersion" VARCHAR(32) NOT NULL,
    "classificationContractCode" VARCHAR(80) NOT NULL,
    "state" VARCHAR(24) NOT NULL DEFAULT 'AVAILABLE',
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "fencingToken" BIGINT NOT NULL DEFAULT 0,
    "leaseOwnerId" UUID,
    "leaseTokenHash" CHAR(64),
    "leaseClaimedAt" TIMESTAMPTZ(3),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "leaseMaxExpiresAt" TIMESTAMPTZ(3),
    "terminalAt" TIMESTAMPTZ(3),
    "terminalReasonCode" VARCHAR(64),
    "lastFailureCode" VARCHAR(64),
    "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'LEAD_BUSINESS_EVENT',
    "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
    "retentionEligibleAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessInboxEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BusinessInboxEvent_contract_check" CHECK (
      "schemaVersion" = 'fai.lead-event.v1'
      AND "eventType" = 'LEAD_SUBMITTED'
      AND "eventVersion" = 1
      AND "canonicalizationVersion" = 1
      AND "classificationCatalogVersion" = 'n04-v1'
      AND "classificationContractCode" = 'lead_business_event_v1'
      AND "retentionClass" = 'LEAD_BUSINESS_EVENT'
    ),
    CONSTRAINT "BusinessInboxEvent_uuid_v4_check" CHECK (
      "eventId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "businessCorrelationId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    CONSTRAINT "BusinessInboxEvent_occurredAt_check" CHECK (
      "occurredAt" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    ),
    CONSTRAINT "BusinessInboxEvent_hash_check" CHECK (
      "keyDigest" ~ '^[0-9a-f]{64}$'
      AND "payloadHash" ~ '^[0-9a-f]{64}$'
      AND "recordHash" ~ '^[0-9a-f]{64}$'
      AND ("leaseTokenHash" IS NULL OR "leaseTokenHash" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "BusinessInboxEvent_envelope_check" CHECK (
      OCTET_LENGTH("envelopeJson") BETWEEN 1 AND 16384
    ),
    CONSTRAINT "BusinessInboxEvent_failure_code_check" CHECK (
      ("terminalReasonCode" IS NULL OR "terminalReasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$')
      AND ("lastFailureCode" IS NULL OR "lastFailureCode" ~ '^[A-Z][A-Z0-9_]{2,63}$')
      AND "retentionPolicyVersion" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,63}$'
    ),
    CONSTRAINT "BusinessInboxEvent_attempt_check" CHECK (
      "attemptCount" BETWEEN 0 AND "maxAttempts" AND "maxAttempts" = 5 AND "fencingToken" >= 0
    ),
    CONSTRAINT "BusinessInboxEvent_state_check" CHECK (
      ("state" = 'AVAILABLE'
        AND "leaseOwnerId" IS NULL AND "leaseTokenHash" IS NULL
        AND "leaseClaimedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseMaxExpiresAt" IS NULL
        AND "terminalAt" IS NULL AND "terminalReasonCode" IS NULL)
      OR ("state" = 'LEASED'
        AND "leaseOwnerId" IS NOT NULL AND "leaseTokenHash" IS NOT NULL
        AND "leaseClaimedAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "leaseMaxExpiresAt" IS NOT NULL
        AND "leaseClaimedAt" < "leaseExpiresAt" AND "leaseExpiresAt" <= "leaseMaxExpiresAt"
        AND "terminalAt" IS NULL AND "terminalReasonCode" IS NULL)
      OR ("state" = 'PROCESSED'
        AND "leaseOwnerId" IS NULL AND "leaseTokenHash" IS NULL
        AND "leaseClaimedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseMaxExpiresAt" IS NULL
        AND "terminalAt" IS NOT NULL AND "terminalReasonCode" IS NULL)
      OR ("state" = 'DEAD_LETTER'
        AND "leaseOwnerId" IS NULL AND "leaseTokenHash" IS NULL
        AND "leaseClaimedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseMaxExpiresAt" IS NULL
        AND "terminalAt" IS NOT NULL AND "terminalReasonCode" IS NOT NULL AND "lastFailureCode" IS NOT NULL)
    )
);

CREATE TABLE "BusinessOutboxEvent" (
    "id" UUID NOT NULL,
    "sourceInboxEventId" UUID NOT NULL,
    "producerCode" VARCHAR(80) NOT NULL,
    "destinationCode" VARCHAR(80) NOT NULL,
    "schemaVersion" VARCHAR(80) NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "eventVersion" INTEGER NOT NULL,
    "canonicalizationVersion" INTEGER NOT NULL,
    "eventId" UUID NOT NULL,
    "businessCorrelationId" UUID NOT NULL,
    "occurredAt" CHAR(24) NOT NULL,
    "keyDigest" CHAR(64) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "envelopeJson" TEXT NOT NULL,
    "recordHash" CHAR(64) NOT NULL,
    "classificationCatalogVersion" VARCHAR(32) NOT NULL,
    "classificationContractCode" VARCHAR(80) NOT NULL,
    "state" VARCHAR(24) NOT NULL DEFAULT 'AVAILABLE',
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "fencingToken" BIGINT NOT NULL DEFAULT 0,
    "leaseOwnerId" UUID,
    "leaseTokenHash" CHAR(64),
    "leaseClaimedAt" TIMESTAMPTZ(3),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "leaseMaxExpiresAt" TIMESTAMPTZ(3),
    "terminalAt" TIMESTAMPTZ(3),
    "terminalReasonCode" VARCHAR(64),
    "lastFailureCode" VARCHAR(64),
    "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'LEAD_BUSINESS_EVENT',
    "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
    "retentionEligibleAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessOutboxEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BusinessOutboxEvent_contract_check" CHECK (
      "schemaVersion" = 'fai.lead-event.v1'
      AND "eventType" = 'LEAD_SUBMITTED'
      AND "eventVersion" = 1
      AND "canonicalizationVersion" = 1
      AND "classificationCatalogVersion" = 'n04-v1'
      AND "classificationContractCode" = 'lead_business_event_v1'
      AND "retentionClass" = 'LEAD_BUSINESS_EVENT'
      AND "producerCode" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,79}$'
      AND "destinationCode" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,79}$'
    ),
    CONSTRAINT "BusinessOutboxEvent_uuid_v4_check" CHECK (
      "eventId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "businessCorrelationId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    CONSTRAINT "BusinessOutboxEvent_occurredAt_check" CHECK (
      "occurredAt" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    ),
    CONSTRAINT "BusinessOutboxEvent_hash_check" CHECK (
      "keyDigest" ~ '^[0-9a-f]{64}$'
      AND "payloadHash" ~ '^[0-9a-f]{64}$'
      AND "recordHash" ~ '^[0-9a-f]{64}$'
      AND ("leaseTokenHash" IS NULL OR "leaseTokenHash" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "BusinessOutboxEvent_envelope_check" CHECK (
      OCTET_LENGTH("envelopeJson") BETWEEN 1 AND 16384
    ),
    CONSTRAINT "BusinessOutboxEvent_failure_code_check" CHECK (
      ("terminalReasonCode" IS NULL OR "terminalReasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$')
      AND ("lastFailureCode" IS NULL OR "lastFailureCode" ~ '^[A-Z][A-Z0-9_]{2,63}$')
      AND "retentionPolicyVersion" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,63}$'
    ),
    CONSTRAINT "BusinessOutboxEvent_attempt_check" CHECK (
      "attemptCount" BETWEEN 0 AND "maxAttempts" AND "maxAttempts" = 5 AND "fencingToken" >= 0
    ),
    CONSTRAINT "BusinessOutboxEvent_state_check" CHECK (
      ("state" = 'AVAILABLE'
        AND "leaseOwnerId" IS NULL AND "leaseTokenHash" IS NULL
        AND "leaseClaimedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseMaxExpiresAt" IS NULL
        AND "terminalAt" IS NULL AND "terminalReasonCode" IS NULL)
      OR ("state" = 'LEASED'
        AND "leaseOwnerId" IS NOT NULL AND "leaseTokenHash" IS NOT NULL
        AND "leaseClaimedAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "leaseMaxExpiresAt" IS NOT NULL
        AND "leaseClaimedAt" < "leaseExpiresAt" AND "leaseExpiresAt" <= "leaseMaxExpiresAt"
        AND "terminalAt" IS NULL AND "terminalReasonCode" IS NULL)
      OR ("state" = 'PUBLISHED'
        AND "leaseOwnerId" IS NULL AND "leaseTokenHash" IS NULL
        AND "leaseClaimedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseMaxExpiresAt" IS NULL
        AND "terminalAt" IS NOT NULL AND "terminalReasonCode" IS NULL)
      OR ("state" = 'DEAD_LETTER'
        AND "leaseOwnerId" IS NULL AND "leaseTokenHash" IS NULL
        AND "leaseClaimedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseMaxExpiresAt" IS NULL
        AND "terminalAt" IS NOT NULL AND "terminalReasonCode" IS NOT NULL AND "lastFailureCode" IS NOT NULL)
    )
);

CREATE TABLE "BusinessQueueAttempt" (
    "id" UUID NOT NULL,
    "queueKind" VARCHAR(16) NOT NULL,
    "inboxEventId" UUID,
    "outboxEventId" UUID,
    "attemptSequence" INTEGER NOT NULL,
    "fencingToken" BIGINT NOT NULL,
    "leaseOwnerId" UUID NOT NULL,
    "leaseTokenHash" CHAR(64) NOT NULL,
    "claimedAt" TIMESTAMPTZ(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "leaseMaxExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "attemptHash" CHAR(64) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "outcome" VARCHAR(32),
    "failureCode" VARCHAR(64),
    "retryable" BOOLEAN,
    "nextAvailableAt" TIMESTAMPTZ(3),
    "completionHash" CHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessQueueAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BusinessQueueAttempt_target_check" CHECK (
      ("queueKind" = 'INBOX' AND "inboxEventId" IS NOT NULL AND "outboxEventId" IS NULL)
      OR ("queueKind" = 'OUTBOX' AND "inboxEventId" IS NULL AND "outboxEventId" IS NOT NULL)
    ),
    CONSTRAINT "BusinessQueueAttempt_claim_check" CHECK (
      "attemptSequence" > 0 AND "fencingToken" > 0
      AND "leaseTokenHash" ~ '^[0-9a-f]{64}$'
      AND "attemptHash" ~ '^[0-9a-f]{64}$'
      AND "claimedAt" < "leaseExpiresAt" AND "leaseExpiresAt" <= "leaseMaxExpiresAt"
    ),
    CONSTRAINT "BusinessQueueAttempt_completion_check" CHECK (
      ("finishedAt" IS NULL AND "outcome" IS NULL AND "failureCode" IS NULL
        AND "retryable" IS NULL AND "nextAvailableAt" IS NULL AND "completionHash" IS NULL)
      OR ("finishedAt" IS NOT NULL
        AND "outcome" IN ('PROCESSED', 'PUBLISHED', 'RETRY_SCHEDULED', 'DEAD_LETTER', 'LEASE_EXPIRED')
        AND "completionHash" ~ '^[0-9a-f]{64}$'
        AND (
          ("outcome" IN ('PROCESSED', 'PUBLISHED') AND "failureCode" IS NULL AND "retryable" IS NULL AND "nextAvailableAt" IS NULL)
          OR ("outcome" = 'RETRY_SCHEDULED' AND "failureCode" ~ '^[A-Z][A-Z0-9_]{2,63}$' AND "retryable" = TRUE AND "nextAvailableAt" IS NOT NULL)
          OR ("outcome" = 'DEAD_LETTER' AND "failureCode" ~ '^[A-Z][A-Z0-9_]{2,63}$' AND "retryable" IS NOT NULL AND "nextAvailableAt" IS NULL)
          OR ("outcome" = 'LEASE_EXPIRED' AND "failureCode" = 'LEASE_EXPIRED' AND "retryable" IS NOT NULL)
        )
      )
    )
);

CREATE UNIQUE INDEX "BusinessInboxEvent_eventId_key" ON "BusinessInboxEvent"("eventId");
CREATE UNIQUE INDEX "BusinessInboxEvent_keyDigest_key" ON "BusinessInboxEvent"("keyDigest");
CREATE INDEX "BusinessInboxEvent_claim_idx" ON "BusinessInboxEvent"("state", "availableAt", "id");
CREATE INDEX "BusinessInboxEvent_recovery_idx" ON "BusinessInboxEvent"("state", "leaseExpiresAt", "id");
CREATE INDEX "BusinessInboxEvent_correlation_idx" ON "BusinessInboxEvent"("businessCorrelationId", "createdAt", "id");
CREATE INDEX "BusinessInboxEvent_retention_idx" ON "BusinessInboxEvent"("retentionPolicyVersion", "retentionEligibleAt", "id");

CREATE UNIQUE INDEX "BusinessOutboxEvent_dedupe_key" ON "BusinessOutboxEvent"("producerCode", "destinationCode", "keyDigest");
CREATE INDEX "BusinessOutboxEvent_eventId_idx" ON "BusinessOutboxEvent"("eventId");
CREATE INDEX "BusinessOutboxEvent_claim_idx" ON "BusinessOutboxEvent"("state", "availableAt", "id");
CREATE INDEX "BusinessOutboxEvent_recovery_idx" ON "BusinessOutboxEvent"("state", "leaseExpiresAt", "id");
CREATE INDEX "BusinessOutboxEvent_correlation_idx" ON "BusinessOutboxEvent"("businessCorrelationId", "createdAt", "id");
CREATE INDEX "BusinessOutboxEvent_retention_idx" ON "BusinessOutboxEvent"("retentionPolicyVersion", "retentionEligibleAt", "id");
CREATE INDEX "BusinessOutboxEvent_source_idx" ON "BusinessOutboxEvent"("sourceInboxEventId", "createdAt", "id");

CREATE UNIQUE INDEX "BusinessQueueAttempt_inbox_sequence_key" ON "BusinessQueueAttempt"("inboxEventId", "attemptSequence") WHERE "inboxEventId" IS NOT NULL;
CREATE UNIQUE INDEX "BusinessQueueAttempt_inbox_fence_key" ON "BusinessQueueAttempt"("inboxEventId", "fencingToken") WHERE "inboxEventId" IS NOT NULL;
CREATE UNIQUE INDEX "BusinessQueueAttempt_outbox_sequence_key" ON "BusinessQueueAttempt"("outboxEventId", "attemptSequence") WHERE "outboxEventId" IS NOT NULL;
CREATE UNIQUE INDEX "BusinessQueueAttempt_outbox_fence_key" ON "BusinessQueueAttempt"("outboxEventId", "fencingToken") WHERE "outboxEventId" IS NOT NULL;
CREATE INDEX "BusinessQueueAttempt_open_idx" ON "BusinessQueueAttempt"("queueKind", "finishedAt", "createdAt", "id");

ALTER TABLE "BusinessOutboxEvent"
  ADD CONSTRAINT "BusinessOutboxEvent_sourceInboxEventId_fkey"
  FOREIGN KEY ("sourceInboxEventId") REFERENCES "BusinessInboxEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BusinessQueueAttempt"
  ADD CONSTRAINT "BusinessQueueAttempt_inboxEventId_fkey"
  FOREIGN KEY ("inboxEventId") REFERENCES "BusinessInboxEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BusinessQueueAttempt"
  ADD CONSTRAINT "BusinessQueueAttempt_outboxEventId_fkey"
  FOREIGN KEY ("outboxEventId") REFERENCES "BusinessOutboxEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION fai_business_inbox_event_guard_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'BUSINESS_INBOX_IMMUTABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."schemaVersion", NEW."eventType", NEW."eventVersion", NEW."canonicalizationVersion",
        NEW."eventId", NEW."businessCorrelationId", NEW."occurredAt", NEW."keyDigest", NEW."payloadHash",
        NEW."envelopeJson", NEW."recordHash", NEW."classificationCatalogVersion", NEW."classificationContractCode",
        NEW."maxAttempts", NEW."retentionClass", NEW."retentionPolicyVersion", NEW."retentionEligibleAt", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."id", OLD."schemaVersion", OLD."eventType", OLD."eventVersion", OLD."canonicalizationVersion",
        OLD."eventId", OLD."businessCorrelationId", OLD."occurredAt", OLD."keyDigest", OLD."payloadHash",
        OLD."envelopeJson", OLD."recordHash", OLD."classificationCatalogVersion", OLD."classificationContractCode",
        OLD."maxAttempts", OLD."retentionClass", OLD."retentionPolicyVersion", OLD."retentionEligibleAt", OLD."createdAt") THEN
      RAISE EXCEPTION 'BUSINESS_INBOX_IDENTITY_IMMUTABLE';
    END IF;
    IF NOT (
      (OLD."state" = 'AVAILABLE' AND NEW."state" = 'LEASED'
        AND NEW."attemptCount" = OLD."attemptCount" + 1 AND NEW."fencingToken" = OLD."fencingToken" + 1
        AND NEW."availableAt" = OLD."availableAt" AND NEW."lastFailureCode" IS NOT DISTINCT FROM OLD."lastFailureCode")
      OR (OLD."state" = 'LEASED' AND NEW."state" = 'LEASED'
        AND NEW."attemptCount" = OLD."attemptCount" AND NEW."fencingToken" = OLD."fencingToken"
        AND NEW."leaseOwnerId" = OLD."leaseOwnerId" AND NEW."leaseTokenHash" = OLD."leaseTokenHash"
        AND NEW."leaseClaimedAt" = OLD."leaseClaimedAt" AND NEW."leaseMaxExpiresAt" = OLD."leaseMaxExpiresAt"
        AND NEW."leaseExpiresAt" > OLD."leaseExpiresAt" AND NEW."availableAt" = OLD."availableAt"
        AND NEW."lastFailureCode" IS NOT DISTINCT FROM OLD."lastFailureCode")
      OR (OLD."state" = 'LEASED' AND NEW."state" IN ('AVAILABLE', 'PROCESSED', 'DEAD_LETTER')
        AND NEW."attemptCount" = OLD."attemptCount" AND NEW."fencingToken" = OLD."fencingToken"
        AND ((NEW."state" = 'AVAILABLE' AND NEW."availableAt" >= OLD."availableAt" AND NEW."lastFailureCode" IS NOT NULL)
          OR (NEW."state" = 'PROCESSED' AND NEW."availableAt" = OLD."availableAt" AND NEW."lastFailureCode" IS NOT DISTINCT FROM OLD."lastFailureCode")
          OR (NEW."state" = 'DEAD_LETTER' AND NEW."availableAt" = OLD."availableAt" AND NEW."lastFailureCode" IS NOT NULL)))
    ) THEN
      RAISE EXCEPTION 'BUSINESS_INBOX_STATE_TRANSITION_INVALID';
    END IF;
    NEW."updatedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION fai_business_outbox_event_guard_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'BUSINESS_OUTBOX_IMMUTABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."sourceInboxEventId", NEW."producerCode", NEW."destinationCode", NEW."schemaVersion", NEW."eventType",
        NEW."eventVersion", NEW."canonicalizationVersion", NEW."eventId", NEW."businessCorrelationId", NEW."occurredAt",
        NEW."keyDigest", NEW."payloadHash", NEW."envelopeJson", NEW."recordHash", NEW."classificationCatalogVersion",
        NEW."classificationContractCode", NEW."maxAttempts", NEW."retentionClass", NEW."retentionPolicyVersion",
        NEW."retentionEligibleAt", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."id", OLD."sourceInboxEventId", OLD."producerCode", OLD."destinationCode", OLD."schemaVersion", OLD."eventType",
        OLD."eventVersion", OLD."canonicalizationVersion", OLD."eventId", OLD."businessCorrelationId", OLD."occurredAt",
        OLD."keyDigest", OLD."payloadHash", OLD."envelopeJson", OLD."recordHash", OLD."classificationCatalogVersion",
        OLD."classificationContractCode", OLD."maxAttempts", OLD."retentionClass", OLD."retentionPolicyVersion",
        OLD."retentionEligibleAt", OLD."createdAt") THEN
      RAISE EXCEPTION 'BUSINESS_OUTBOX_IDENTITY_IMMUTABLE';
    END IF;
    IF NOT (
      (OLD."state" = 'AVAILABLE' AND NEW."state" = 'LEASED'
        AND NEW."attemptCount" = OLD."attemptCount" + 1 AND NEW."fencingToken" = OLD."fencingToken" + 1
        AND NEW."availableAt" = OLD."availableAt" AND NEW."lastFailureCode" IS NOT DISTINCT FROM OLD."lastFailureCode")
      OR (OLD."state" = 'LEASED' AND NEW."state" = 'LEASED'
        AND NEW."attemptCount" = OLD."attemptCount" AND NEW."fencingToken" = OLD."fencingToken"
        AND NEW."leaseOwnerId" = OLD."leaseOwnerId" AND NEW."leaseTokenHash" = OLD."leaseTokenHash"
        AND NEW."leaseClaimedAt" = OLD."leaseClaimedAt" AND NEW."leaseMaxExpiresAt" = OLD."leaseMaxExpiresAt"
        AND NEW."leaseExpiresAt" > OLD."leaseExpiresAt" AND NEW."availableAt" = OLD."availableAt"
        AND NEW."lastFailureCode" IS NOT DISTINCT FROM OLD."lastFailureCode")
      OR (OLD."state" = 'LEASED' AND NEW."state" IN ('AVAILABLE', 'PUBLISHED', 'DEAD_LETTER')
        AND NEW."attemptCount" = OLD."attemptCount" AND NEW."fencingToken" = OLD."fencingToken"
        AND ((NEW."state" = 'AVAILABLE' AND NEW."availableAt" >= OLD."availableAt" AND NEW."lastFailureCode" IS NOT NULL)
          OR (NEW."state" = 'PUBLISHED' AND NEW."availableAt" = OLD."availableAt" AND NEW."lastFailureCode" IS NOT DISTINCT FROM OLD."lastFailureCode")
          OR (NEW."state" = 'DEAD_LETTER' AND NEW."availableAt" = OLD."availableAt" AND NEW."lastFailureCode" IS NOT NULL)))
    ) THEN
      RAISE EXCEPTION 'BUSINESS_OUTBOX_STATE_TRANSITION_INVALID';
    END IF;
    NEW."updatedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION fai_business_queue_attempt_guard_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'BUSINESS_QUEUE_ATTEMPT_IMMUTABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."finishedAt" IS NOT NULL OR NEW."finishedAt" IS NULL THEN
      RAISE EXCEPTION 'BUSINESS_QUEUE_ATTEMPT_WRITE_ONCE';
    END IF;
    IF (NEW."id", NEW."queueKind", NEW."inboxEventId", NEW."outboxEventId", NEW."attemptSequence",
        NEW."fencingToken", NEW."leaseOwnerId", NEW."leaseTokenHash", NEW."claimedAt", NEW."leaseExpiresAt",
        NEW."leaseMaxExpiresAt", NEW."attemptHash", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."id", OLD."queueKind", OLD."inboxEventId", OLD."outboxEventId", OLD."attemptSequence",
        OLD."fencingToken", OLD."leaseOwnerId", OLD."leaseTokenHash", OLD."claimedAt", OLD."leaseExpiresAt",
        OLD."leaseMaxExpiresAt", OLD."attemptHash", OLD."createdAt") THEN
      RAISE EXCEPTION 'BUSINESS_QUEUE_ATTEMPT_IDENTITY_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BusinessInboxEvent_guard_v1"
BEFORE UPDATE OR DELETE ON "BusinessInboxEvent"
FOR EACH ROW EXECUTE FUNCTION fai_business_inbox_event_guard_v1();
CREATE TRIGGER "BusinessInboxEvent_deny_truncate_v1"
BEFORE TRUNCATE ON "BusinessInboxEvent"
FOR EACH STATEMENT EXECUTE FUNCTION fai_business_inbox_event_guard_v1();

CREATE TRIGGER "BusinessOutboxEvent_guard_v1"
BEFORE UPDATE OR DELETE ON "BusinessOutboxEvent"
FOR EACH ROW EXECUTE FUNCTION fai_business_outbox_event_guard_v1();
CREATE TRIGGER "BusinessOutboxEvent_deny_truncate_v1"
BEFORE TRUNCATE ON "BusinessOutboxEvent"
FOR EACH STATEMENT EXECUTE FUNCTION fai_business_outbox_event_guard_v1();

CREATE TRIGGER "BusinessQueueAttempt_guard_v1"
BEFORE UPDATE OR DELETE ON "BusinessQueueAttempt"
FOR EACH ROW EXECUTE FUNCTION fai_business_queue_attempt_guard_v1();
CREATE TRIGGER "BusinessQueueAttempt_deny_truncate_v1"
BEFORE TRUNCATE ON "BusinessQueueAttempt"
FOR EACH STATEMENT EXECUTE FUNCTION fai_business_queue_attempt_guard_v1();

COMMIT;
