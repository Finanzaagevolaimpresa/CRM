-- AI Control Plane v1: fail-closed global policy, immutable agent
-- configuration history and auditable external-provider execution metadata.

BEGIN;

ALTER TABLE "AiAgent"
  ADD COLUMN "configVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "AiAgent"
  ADD CONSTRAINT "AiAgent_configVersion_check"
  CHECK ("configVersion" >= 1);

-- Remove only the exact placeholder shipped by earlier CRM seeds. Preserve
-- every other manually configured value during the upgrade.
UPDATE "AiAgent"
SET "futureModel" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "futureModel" = 'openai-server-side';

CREATE TABLE "AiControlSetting" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "externalProvidersEnabled" BOOLEAN NOT NULL DEFAULT false,
  "maxExternalRunsPerUserPerHour" INTEGER NOT NULL DEFAULT 10,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiControlSetting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiControlSetting_singleton_check" CHECK ("id" = 'global'),
  CONSTRAINT "AiControlSetting_rate_limit_check"
    CHECK ("maxExternalRunsPerUserPerHour" BETWEEN 1 AND 1000)
);

-- The row exists after deployment but external execution remains disabled.
-- Application code must also observe AI_EXTERNAL_PROVIDERS_ENABLED=true.
INSERT INTO "AiControlSetting" (
  "id",
  "externalProvidersEnabled",
  "maxExternalRunsPerUserPerHour",
  "updatedAt"
) VALUES ('global', false, 10, CURRENT_TIMESTAMP);

CREATE TABLE "AiAgentConfigVersion" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "operationalScope" TEXT NOT NULL,
  "systemPrompt" TEXT NOT NULL,
  "requiredDataChecklist" JSONB NOT NULL,
  "expectedOutput" TEXT NOT NULL,
  "toneStyle" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT,
  "promptVersion" TEXT NOT NULL,
  "inputSchema" JSONB NOT NULL,
  "outputSchema" JSONB NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiAgentConfigVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiAgentConfigVersion_version_check" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "AiAgentConfigVersion_agentId_version_key"
  ON "AiAgentConfigVersion"("agentId", "version");
CREATE INDEX "AiAgentConfigVersion_agentId_createdAt_idx"
  ON "AiAgentConfigVersion"("agentId", "createdAt");

-- Capture the configuration that was active at migration time. The generated
-- identifier is deterministic so the backfill is repeatable during recovery.
INSERT INTO "AiAgentConfigVersion" (
  "id",
  "agentId",
  "version",
  "code",
  "name",
  "description",
  "operationalScope",
  "systemPrompt",
  "requiredDataChecklist",
  "expectedOutput",
  "toneStyle",
  "active",
  "provider",
  "model",
  "promptVersion",
  "inputSchema",
  "outputSchema",
  "createdAt"
)
SELECT
  'aicv_' || md5(agent."id" || ':1'),
  agent."id",
  1,
  agent."code",
  agent."name",
  agent."description",
  agent."operationalScope",
  agent."systemPrompt",
  agent."requiredDataChecklist",
  agent."expectedOutput",
  agent."toneStyle",
  agent."active",
  agent."provider",
  agent."futureModel",
  agent."promptVersion",
  agent."inputSchema",
  agent."outputSchema",
  CURRENT_TIMESTAMP
FROM "AiAgent" AS agent
ON CONFLICT ("agentId", "version") DO NOTHING;

ALTER TABLE "AiAgentConfigVersion"
  ADD CONSTRAINT "AiAgentConfigVersion_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Configuration versions are an append-only audit record. Corrections create
-- a new version; application roles cannot rewrite or remove existing history.
CREATE FUNCTION "reject_ai_agent_config_version_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AiAgentConfigVersion is immutable; create a new version instead';
END;
$$;

CREATE TRIGGER "AiAgentConfigVersion_immutable_update"
BEFORE UPDATE ON "AiAgentConfigVersion"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_agent_config_version_mutation"();

CREATE TRIGGER "AiAgentConfigVersion_immutable_delete"
BEFORE DELETE ON "AiAgentConfigVersion"
FOR EACH ROW EXECUTE FUNCTION "reject_ai_agent_config_version_mutation"();

ALTER TABLE "AiRun"
  ADD COLUMN "externalConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "externalDataCategories" JSONB,
  ADD COLUMN "inputTokens" INTEGER,
  ADD COLUMN "outputTokens" INTEGER,
  ADD COLUMN "totalTokens" INTEGER,
  ADD COLUMN "providerRequestId" TEXT;

ALTER TABLE "AiRun"
  ADD CONSTRAINT "AiRun_inputTokens_check"
    CHECK ("inputTokens" IS NULL OR "inputTokens" >= 0),
  ADD CONSTRAINT "AiRun_outputTokens_check"
    CHECK ("outputTokens" IS NULL OR "outputTokens" >= 0),
  ADD CONSTRAINT "AiRun_totalTokens_check"
    CHECK ("totalTokens" IS NULL OR "totalTokens" >= 0);

CREATE INDEX "AiRun_external_user_rate_idx"
  ON "AiRun"("createdById", "createdAt")
  WHERE "externalConfirmedAt" IS NOT NULL;

COMMIT;
