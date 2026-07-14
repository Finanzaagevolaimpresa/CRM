-- AI Runtime Reliability v1: durable idempotency, leased execution and an
-- immutable link from every new run to the exact agent configuration used.
-- reliabilityVersion is deliberately nullable and has no default: historical
-- rows remain updateable, while the v1 runtime opts into the strict contract.

BEGIN;

ALTER TABLE "AiRun"
  ADD COLUMN "reliabilityVersion" INTEGER,
  ADD COLUMN "agentConfigVersion" INTEGER,
  ADD COLUMN "requestKey" TEXT,
  ADD COLUMN "requestFingerprint" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "leaseTokenHash" TEXT,
  ADD COLUMN "egressPermitHash" TEXT,
  ADD COLUMN "egressStartedAt" TIMESTAMP(3),
  ADD COLUMN "externalPayloadHash" TEXT,
  ADD COLUMN "finishedAt" TIMESTAMP(3),
  ADD COLUMN "failureCode" TEXT;

-- Prefer the version recorded by the audit event emitted when the run was
-- reserved. Only an unambiguous, existing snapshot for the same agent is used.
WITH "auditCandidates" AS (
  SELECT
    run."id" AS "runId",
    run."agentId",
    run."promptVersion",
    CASE
      WHEN audit."after"->>'configVersion' ~ '^[1-9][0-9]{0,8}$'
        THEN (audit."after"->>'configVersion')::INTEGER
      ELSE NULL
    END AS "version"
  FROM "AiRun" AS run
  INNER JOIN "AuditLog" AS audit
    ON audit."entityType" = 'AiRun'
   AND audit."entityId" = run."id"
   AND audit."after"->>'agentId' = run."agentId"
  WHERE run."agentConfigVersion" IS NULL
),
"validAuditCandidates" AS (
  SELECT candidate."runId", candidate."version"
  FROM "auditCandidates" AS candidate
  INNER JOIN "AiAgentConfigVersion" AS config
    ON config."agentId" = candidate."agentId"
   AND config."version" = candidate."version"
   AND (
     candidate."promptVersion" IS NULL
     OR config."promptVersion" = candidate."promptVersion"
   )
  WHERE candidate."version" IS NOT NULL
),
"unambiguousAudits" AS (
  SELECT
    candidate."runId",
    MIN(candidate."version") AS "version"
  FROM "validAuditCandidates" AS candidate
  GROUP BY candidate."runId"
  HAVING COUNT(DISTINCT candidate."version") = 1
)
UPDATE "AiRun" AS run
SET "agentConfigVersion" = candidate."version"
FROM "unambiguousAudits" AS candidate
WHERE run."id" = candidate."runId"
  AND run."agentConfigVersion" IS NULL;

-- Older audit events did not carry configVersion. Recover those runs only when
-- promptVersion identifies exactly one snapshot for the same agent. Ambiguous
-- or unverifiable history intentionally remains NULL rather than being guessed.
WITH "promptCandidates" AS (
  SELECT
    run."id" AS "runId",
    MIN(config."version") AS "version"
  FROM "AiRun" AS run
  INNER JOIN "AiAgentConfigVersion" AS config
    ON config."agentId" = run."agentId"
   AND config."promptVersion" = run."promptVersion"
  WHERE run."agentConfigVersion" IS NULL
    AND run."promptVersion" IS NOT NULL
  GROUP BY run."id"
  HAVING COUNT(*) = 1
)
UPDATE "AiRun" AS run
SET "agentConfigVersion" = candidate."version"
FROM "promptCandidates" AS candidate
WHERE run."id" = candidate."runId"
  AND run."agentConfigVersion" IS NULL;

CREATE UNIQUE INDEX "AiRun_createdById_requestKey_key"
  ON "AiRun"("createdById", "requestKey");

CREATE INDEX "AiRun_agentId_agentConfigVersion_idx"
  ON "AiRun"("agentId", "agentConfigVersion");

CREATE INDEX "AiRun_status_leaseExpiresAt_idx"
  ON "AiRun"("status", "leaseExpiresAt");

-- Nullable for historical rows that cannot be attributed safely. Every
-- non-null value must identify a real, immutable snapshot of the same agent;
-- the reliability v1 checks below require that link for opted-in runs.
ALTER TABLE "AiRun"
  ADD CONSTRAINT "AiRun_agentId_agentConfigVersion_fkey"
  FOREIGN KEY ("agentId", "agentConfigVersion")
  REFERENCES "AiAgentConfigVersion"("agentId", "version")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiRun"
  ADD CONSTRAINT "AiRun_reliabilityVersion_check"
    CHECK ("reliabilityVersion" IS NULL OR "reliabilityVersion" = 1),
  ADD CONSTRAINT "AiRun_agentConfigVersion_check"
    CHECK ("agentConfigVersion" IS NULL OR "agentConfigVersion" >= 1),
  ADD CONSTRAINT "AiRun_idempotency_pair_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR (
        "requestKey" IS NOT NULL
        AND "requestFingerprint" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "AiRun_requestKey_format_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR (
        "requestKey" IS NOT NULL
        AND "createdById" IS NOT NULL
        AND "requestKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    ),
  ADD CONSTRAINT "AiRun_requestFingerprint_format_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR (
        "requestFingerprint" IS NOT NULL
        AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
      )
    ),
  ADD CONSTRAINT "AiRun_leaseTokenHash_format_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR "leaseTokenHash" IS NULL
      OR "leaseTokenHash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "AiRun_egressPermitHash_format_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR "egressPermitHash" IS NULL
      OR "egressPermitHash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "AiRun_externalPayloadHash_format_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR "externalPayloadHash" IS NULL
      OR "externalPayloadHash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "AiRun_failureCode_format_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR "failureCode" IS NULL
      OR "failureCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    );

-- The fencing token itself never reaches the database. Only its SHA-256 hash
-- is stored. It remains stable for the running attempt and is cleared only at
-- terminalization; no automatic lease takeover or provider re-run is implied.
ALTER TABLE "AiRun"
  ADD CONSTRAINT "AiRun_runtime_identity_required_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR "agentConfigVersion" IS NOT NULL
    ),
  ADD CONSTRAINT "AiRun_lease_state_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR (
        (
          "status" = 'running'
          AND "leaseExpiresAt" IS NOT NULL
          AND "leaseTokenHash" IS NOT NULL
          AND "leaseExpiresAt" > "createdAt"
        )
        OR (
          "status" <> 'running'
          AND "leaseExpiresAt" IS NULL
          AND "leaseTokenHash" IS NULL
        )
      )
    );

-- A reliable run has one of three lifecycle states. Terminal timestamps and
-- minimized failure codes make recovery observable without persisting provider
-- responses or exception messages.
ALTER TABLE "AiRun"
  ADD CONSTRAINT "AiRun_terminal_state_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR (
        "status" = 'running'
        AND "finishedAt" IS NULL
        AND "failureCode" IS NULL
      )
      OR (
        "status" = 'completed'
        AND "finishedAt" IS NOT NULL
        AND "finishedAt" >= "createdAt"
        AND "failureCode" IS NULL
      )
      OR (
        "status" = 'failed'
        AND "finishedAt" IS NOT NULL
        AND "finishedAt" >= "createdAt"
        AND "failureCode" IS NOT NULL
      )
    );

-- Egress authorization and worker ownership are independent capabilities.
-- Consuming the one-shot egress permit clears only egressPermitHash and records
-- egressStartedAt; leaseTokenHash remains stable until terminalization.
ALTER TABLE "AiRun"
  ADD CONSTRAINT "AiRun_egress_state_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR (
        LOWER(BTRIM("provider")) = 'openai'
        AND (
          (
            "status" = 'running'
            AND (
              (
                "egressPermitHash" IS NOT NULL
                AND "egressStartedAt" IS NULL
              )
              OR (
                "egressPermitHash" IS NULL
                AND "egressStartedAt" IS NOT NULL
                AND "egressStartedAt" >= "createdAt"
              )
            )
          )
          OR (
            "status" <> 'running'
            AND "egressPermitHash" IS NULL
            AND (
              "status" <> 'completed'
              OR "egressStartedAt" IS NOT NULL
            )
            AND (
              "egressStartedAt" IS NULL
              OR (
                "egressStartedAt" >= "createdAt"
                AND "finishedAt" >= "egressStartedAt"
              )
            )
          )
        )
      )
      OR (
        LOWER(BTRIM("provider")) <> 'openai'
        AND "egressPermitHash" IS NULL
        AND "egressStartedAt" IS NULL
      )
    );

-- OpenAI runs carry only minimized governance metadata. The payload itself and
-- free-form instructions remain out of AiRun; their canonical SHA-256 digest
-- binds the authorization permit to the exact egress payload.
ALTER TABLE "AiRun"
  ADD CONSTRAINT "AiRun_openai_governance_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR LOWER(BTRIM("provider")) <> 'openai'
      OR (
        "model" IS NOT NULL
        AND LENGTH(BTRIM("model")) BETWEEN 1 AND 200
        AND "externalConfirmedAt" IS NOT NULL
        AND CASE
          WHEN JSONB_TYPEOF("externalDataCategories") = 'array'
            THEN JSONB_ARRAY_LENGTH("externalDataCategories") > 0
          ELSE false
        END
        AND "externalPayloadHash" IS NOT NULL
        AND "input" IS NULL
        AND "operationalInstructions" IS NULL
      )
    ),
  ADD CONSTRAINT "AiRun_externalPayloadHash_provider_check"
    CHECK (
      "reliabilityVersion" IS NULL
      OR "externalPayloadHash" IS NULL
      OR LOWER(BTRIM("provider")) = 'openai'
    );

COMMIT;
