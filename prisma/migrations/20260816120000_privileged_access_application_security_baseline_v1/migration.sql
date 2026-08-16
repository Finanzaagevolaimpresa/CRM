CREATE TABLE "ApplicationFeatureGate" (
  "code" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApplicationFeatureGate_pkey" PRIMARY KEY ("code"),
  CONSTRAINT "ApplicationFeatureGate_code_check" CHECK (
    "code" IN ('INTEGRATIONS', 'CUSTOMER_PORTAL', 'PAYMENTS', 'AI_WORKER', 'AI_DISPATCH', 'AI_EGRESS')
  ),
  CONSTRAINT "ApplicationFeatureGate_version_check" CHECK ("version" > 0)
);

CREATE INDEX "ApplicationFeatureGate_enabled_code_idx"
  ON "ApplicationFeatureGate"("enabled", "code");
CREATE INDEX "ApplicationFeatureGate_updatedById_idx"
  ON "ApplicationFeatureGate"("updatedById");

ALTER TABLE "ApplicationFeatureGate"
  ADD CONSTRAINT "ApplicationFeatureGate_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE RESTRICT;

INSERT INTO "ApplicationFeatureGate" ("code", "enabled", "version", "updatedAt") VALUES
  ('INTEGRATIONS', FALSE, 1, CURRENT_TIMESTAMP),
  ('CUSTOMER_PORTAL', FALSE, 1, CURRENT_TIMESTAMP),
  ('PAYMENTS', FALSE, 1, CURRENT_TIMESTAMP),
  ('AI_WORKER', FALSE, 1, CURRENT_TIMESTAMP),
  ('AI_DISPATCH', FALSE, 1, CURRENT_TIMESTAMP),
  ('AI_EGRESS', FALSE, 1, CURRENT_TIMESTAMP);

CREATE TABLE "ApplicationKeyVersion" (
  "id" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "keyDigest" BYTEA NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RETIRED',
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApplicationKeyVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ApplicationKeyVersion_purpose_check" CHECK (
    "purpose" IN ('PRIVILEGED_STEP_UP')
  ),
  CONSTRAINT "ApplicationKeyVersion_version_check" CHECK ("version" > 0),
  CONSTRAINT "ApplicationKeyVersion_digest_length_check" CHECK (octet_length("keyDigest") = 32),
  CONSTRAINT "ApplicationKeyVersion_status_check" CHECK (
    "status" IN ('ACTIVE', 'RETIRED', 'REVOKED')
  ),
  CONSTRAINT "ApplicationKeyVersion_lifecycle_check" CHECK (
    ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL)
    OR
    ("status" IN ('RETIRED', 'REVOKED') AND ("activatedAt" IS NULL OR "retiredAt" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "ApplicationKeyVersion_purpose_version_key"
  ON "ApplicationKeyVersion"("purpose", "version");
CREATE UNIQUE INDEX "ApplicationKeyVersion_one_active_per_purpose_idx"
  ON "ApplicationKeyVersion"("purpose") WHERE "status" = 'ACTIVE';
CREATE INDEX "ApplicationKeyVersion_purpose_status_idx"
  ON "ApplicationKeyVersion"("purpose", "status");
CREATE INDEX "ApplicationKeyVersion_createdById_idx"
  ON "ApplicationKeyVersion"("createdById");

ALTER TABLE "ApplicationKeyVersion"
  ADD CONSTRAINT "ApplicationKeyVersion_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE RESTRICT;

CREATE TABLE "LoginThrottleBucket" (
  "keyDigest" TEXT NOT NULL,
  "failedCount" INTEGER NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "blockedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoginThrottleBucket_pkey" PRIMARY KEY ("keyDigest"),
  CONSTRAINT "LoginThrottleBucket_key_digest_check" CHECK (
    "keyDigest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "LoginThrottleBucket_failed_count_check" CHECK (
    "failedCount" >= 0 AND "failedCount" <= 1000000
  ),
  CONSTRAINT "LoginThrottleBucket_blocked_until_check" CHECK (
    "blockedUntil" IS NULL OR "blockedUntil" >= "windowStartedAt"
  )
);

CREATE INDEX "LoginThrottleBucket_blockedUntil_idx"
  ON "LoginThrottleBucket"("blockedUntil");
