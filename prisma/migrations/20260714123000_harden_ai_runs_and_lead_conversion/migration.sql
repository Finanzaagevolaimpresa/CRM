DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Client"
    WHERE "leadId" IS NOT NULL
    GROUP BY "leadId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce Client.leadId uniqueness: duplicate lead conversions exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "Client_leadId_key"
ON "Client"("leadId");

ALTER TABLE "AiRun"
ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN "model" TEXT,
ADD COLUMN "promptVersion" TEXT;
