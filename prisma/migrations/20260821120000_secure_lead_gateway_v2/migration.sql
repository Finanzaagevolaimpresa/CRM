-- N12 Secure Lead Gateway v2 security state.
-- Additive and deliberately empty: no key, event, seed, backfill, gate change or activation.

BEGIN;

CREATE TABLE "SecureLeadGatewayKeyVersion" (
    "id" UUID NOT NULL,
    "producerCode" VARCHAR(80) NOT NULL,
    "keyId" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL,
    "secretDigest" CHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'STAGED',
    "acceptFrom" TIMESTAMPTZ(3) NOT NULL,
    "acceptUntil" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "retiredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecureLeadGatewayKeyVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SecureLeadGatewayKeyVersion_identity_check" CHECK (
      "id"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "producerCode" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,79}$'
      AND "keyId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$'
      AND "version" > 0
      AND "secretDigest" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "SecureLeadGatewayKeyVersion_time_check" CHECK (
      ("acceptUntil" IS NULL OR "acceptUntil" > "acceptFrom")
      AND "updatedAt" >= "createdAt"
      AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
      AND ("retiredAt" IS NULL OR "retiredAt" >= "createdAt")
      AND ("revokedAt" IS NULL OR "retiredAt" IS NULL OR "retiredAt" >= "revokedAt")
    ),
    CONSTRAINT "SecureLeadGatewayKeyVersion_lifecycle_check" CHECK (
      ("status" = 'STAGED' AND "acceptUntil" IS NULL AND "revokedAt" IS NULL AND "retiredAt" IS NULL)
      OR ("status" = 'ACTIVE' AND "acceptUntil" IS NULL AND "revokedAt" IS NULL AND "retiredAt" IS NULL)
      OR ("status" = 'RETIRING' AND "acceptUntil" IS NOT NULL AND "revokedAt" IS NULL AND "retiredAt" IS NULL)
      OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL AND "retiredAt" IS NULL)
      OR ("status" = 'RETIRED' AND "retiredAt" IS NOT NULL)
    )
);

CREATE TABLE "SecureLeadGatewayRateLimitBucket" (
    "producerCode" VARCHAR(80) NOT NULL,
    "theoreticalArrivalAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecureLeadGatewayRateLimitBucket_pkey" PRIMARY KEY ("producerCode"),
    CONSTRAINT "SecureLeadGatewayRateLimitBucket_contract_check" CHECK (
      "producerCode" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,79}$'
      AND "updatedAt" >= "createdAt"
    )
);

CREATE TABLE "SecureLeadGatewayReceipt" (
    "id" UUID NOT NULL,
    "inboxEventId" UUID NOT NULL,
    "receiptVersion" INTEGER NOT NULL DEFAULT 1,
    "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'SECURE_LEAD_GATEWAY_RECEIPT',
    "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
    "retentionEligibleAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecureLeadGatewayReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SecureLeadGatewayReceipt_contract_check" CHECK (
      "id"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "receiptVersion" = 1
      AND "retentionClass" = 'SECURE_LEAD_GATEWAY_RECEIPT'
      AND "retentionPolicyVersion" = 'N21_UNASSIGNED'
      AND "retentionEligibleAt" = "createdAt" + INTERVAL '24 hours'
    )
);

CREATE TABLE "SecureLeadGatewayRequest" (
    "id" UUID NOT NULL,
    "producerCode" VARCHAR(80) NOT NULL,
    "keyVersionId" UUID NOT NULL,
    "nonceDigest" CHAR(64) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "receiptId" UUID NOT NULL,
    "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'SECURE_LEAD_GATEWAY_REQUEST',
    "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
    "retentionEligibleAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecureLeadGatewayRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SecureLeadGatewayRequest_contract_check" CHECK (
      "id"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "producerCode" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,79}$'
      AND "nonceDigest" ~ '^[0-9a-f]{64}$'
      AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
      AND "retentionClass" = 'SECURE_LEAD_GATEWAY_REQUEST'
      AND "retentionPolicyVersion" = 'N21_UNASSIGNED'
      AND "retentionEligibleAt" = "createdAt" + INTERVAL '24 hours'
    )
);

CREATE UNIQUE INDEX "SecureLeadGatewayKeyVersion_keyId_key"
  ON "SecureLeadGatewayKeyVersion"("keyId");
CREATE UNIQUE INDEX "SecureLeadGatewayKeyVersion_producer_version_key"
  ON "SecureLeadGatewayKeyVersion"("producerCode", "version");
CREATE UNIQUE INDEX "SecureLeadGatewayKeyVersion_one_active_key"
  ON "SecureLeadGatewayKeyVersion"("producerCode") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "SecureLeadGatewayKeyVersion_one_retiring_key"
  ON "SecureLeadGatewayKeyVersion"("producerCode") WHERE "status" = 'RETIRING';
CREATE INDEX "SecureLeadGatewayKeyVersion_lookup_idx"
  ON "SecureLeadGatewayKeyVersion"("producerCode", "status", "acceptFrom");

CREATE UNIQUE INDEX "SecureLeadGatewayReceipt_inboxEventId_key"
  ON "SecureLeadGatewayReceipt"("inboxEventId");
CREATE INDEX "SecureLeadGatewayReceipt_retention_idx"
  ON "SecureLeadGatewayReceipt"("retentionPolicyVersion", "retentionEligibleAt", "id");

CREATE UNIQUE INDEX "SecureLeadGatewayRequest_producer_nonce_key"
  ON "SecureLeadGatewayRequest"("producerCode", "nonceDigest");
CREATE INDEX "SecureLeadGatewayRequest_keyVersion_idx"
  ON "SecureLeadGatewayRequest"("keyVersionId", "createdAt", "id");
CREATE INDEX "SecureLeadGatewayRequest_receipt_idx"
  ON "SecureLeadGatewayRequest"("receiptId", "createdAt", "id");
CREATE INDEX "SecureLeadGatewayRequest_retention_idx"
  ON "SecureLeadGatewayRequest"("retentionPolicyVersion", "retentionEligibleAt", "id");

ALTER TABLE "SecureLeadGatewayReceipt"
  ADD CONSTRAINT "SecureLeadGatewayReceipt_inboxEventId_fkey"
  FOREIGN KEY ("inboxEventId") REFERENCES "BusinessInboxEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SecureLeadGatewayRequest"
  ADD CONSTRAINT "SecureLeadGatewayRequest_keyVersionId_fkey"
  FOREIGN KEY ("keyVersionId") REFERENCES "SecureLeadGatewayKeyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SecureLeadGatewayRequest"
  ADD CONSTRAINT "SecureLeadGatewayRequest_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "SecureLeadGatewayReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION fai_secure_lead_gateway_key_guard_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  transition_now TIMESTAMPTZ(3);
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_KEY_NONDELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'STAGED' THEN
      RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_KEY_INITIAL_STATE_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."producerCode", NEW."keyId", NEW."version", NEW."secretDigest",
      NEW."acceptFrom", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."producerCode", OLD."keyId", OLD."version", OLD."secretDigest",
      OLD."acceptFrom", OLD."createdAt") THEN
    RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_KEY_IDENTITY_IMMUTABLE';
  END IF;
  transition_now := DATE_TRUNC('milliseconds', clock_timestamp());
  IF NEW."status" = OLD."status" THEN
    IF (NEW."acceptUntil", NEW."revokedAt", NEW."retiredAt") IS DISTINCT FROM
       (OLD."acceptUntil", OLD."revokedAt", OLD."retiredAt") THEN
      RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_KEY_TRANSITION_INVALID';
    END IF;
  ELSIF OLD."status" = 'STAGED' AND NEW."status" = 'ACTIVE' THEN
    IF (NEW."acceptUntil", NEW."revokedAt", NEW."retiredAt") IS DISTINCT FROM
       (OLD."acceptUntil", OLD."revokedAt", OLD."retiredAt") THEN
      RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_KEY_TRANSITION_INVALID';
    END IF;
  ELSIF OLD."status" IN ('STAGED', 'ACTIVE', 'RETIRING') AND NEW."status" = 'REVOKED' THEN
    IF NEW."revokedAt" IS NULL OR NEW."revokedAt" > transition_now
       OR NEW."acceptUntil" IS DISTINCT FROM OLD."acceptUntil"
       OR NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
      RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_KEY_TRANSITION_INVALID';
    END IF;
  ELSIF OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRING' THEN
    IF NEW."acceptUntil" IS NULL OR NEW."acceptUntil" <= transition_now
       OR NEW."acceptUntil" > transition_now + INTERVAL '900 seconds'
       OR NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
       OR NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
      RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_KEY_TRANSITION_INVALID';
    END IF;
  ELSIF OLD."status" IN ('RETIRING', 'REVOKED') AND NEW."status" = 'RETIRED' THEN
    IF NEW."retiredAt" IS NULL OR NEW."retiredAt" > transition_now
       OR NEW."acceptUntil" IS DISTINCT FROM OLD."acceptUntil"
       OR NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
      RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_KEY_TRANSITION_INVALID';
    END IF;
  ELSE
    RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_KEY_TRANSITION_INVALID';
  END IF;
  NEW."updatedAt" := transition_now;
  RETURN NEW;
END;
$$;

CREATE FUNCTION fai_secure_lead_gateway_rate_guard_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_RATE_NONDELETABLE';
  END IF;
  IF NEW."producerCode" IS DISTINCT FROM OLD."producerCode"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."theoreticalArrivalAt" < OLD."theoreticalArrivalAt" THEN
    RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_RATE_INVALID';
  END IF;
  NEW."updatedAt" := DATE_TRUNC('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

CREATE FUNCTION fai_secure_lead_gateway_receipt_guard_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_RECEIPT_IMMUTABLE';
END;
$$;

CREATE FUNCTION fai_secure_lead_gateway_request_guard_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SECURE_LEAD_GATEWAY_REQUEST_IMMUTABLE';
END;
$$;

CREATE TRIGGER "SecureLeadGatewayKeyVersion_guard_v1"
BEFORE INSERT OR UPDATE OR DELETE ON "SecureLeadGatewayKeyVersion"
FOR EACH ROW EXECUTE FUNCTION fai_secure_lead_gateway_key_guard_v1();
CREATE TRIGGER "SecureLeadGatewayKeyVersion_deny_truncate_v1"
BEFORE TRUNCATE ON "SecureLeadGatewayKeyVersion"
FOR EACH STATEMENT EXECUTE FUNCTION fai_secure_lead_gateway_key_guard_v1();

CREATE TRIGGER "SecureLeadGatewayRateLimitBucket_guard_v1"
BEFORE UPDATE OR DELETE ON "SecureLeadGatewayRateLimitBucket"
FOR EACH ROW EXECUTE FUNCTION fai_secure_lead_gateway_rate_guard_v1();
CREATE TRIGGER "SecureLeadGatewayRateLimitBucket_deny_truncate_v1"
BEFORE TRUNCATE ON "SecureLeadGatewayRateLimitBucket"
FOR EACH STATEMENT EXECUTE FUNCTION fai_secure_lead_gateway_rate_guard_v1();

CREATE TRIGGER "SecureLeadGatewayReceipt_guard_v1"
BEFORE UPDATE OR DELETE ON "SecureLeadGatewayReceipt"
FOR EACH ROW EXECUTE FUNCTION fai_secure_lead_gateway_receipt_guard_v1();
CREATE TRIGGER "SecureLeadGatewayReceipt_deny_truncate_v1"
BEFORE TRUNCATE ON "SecureLeadGatewayReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION fai_secure_lead_gateway_receipt_guard_v1();

CREATE TRIGGER "SecureLeadGatewayRequest_guard_v1"
BEFORE UPDATE OR DELETE ON "SecureLeadGatewayRequest"
FOR EACH ROW EXECUTE FUNCTION fai_secure_lead_gateway_request_guard_v1();
CREATE TRIGGER "SecureLeadGatewayRequest_deny_truncate_v1"
BEFORE TRUNCATE ON "SecureLeadGatewayRequest"
FOR EACH STATEMENT EXECUTE FUNCTION fai_secure_lead_gateway_request_guard_v1();

COMMIT;
