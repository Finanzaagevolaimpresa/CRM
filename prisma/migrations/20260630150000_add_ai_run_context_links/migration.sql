ALTER TABLE "AiRun" ADD COLUMN IF NOT EXISTS "clientId" TEXT;
ALTER TABLE "AiRun" ADD COLUMN IF NOT EXISTS "clientServiceId" TEXT;
ALTER TABLE "AiRun" ADD COLUMN IF NOT EXISTS "projectId" TEXT;
ALTER TABLE "AiRun" ADD COLUMN IF NOT EXISTS "operationalInstructions" TEXT;

ALTER TABLE "AiOutput" ADD COLUMN IF NOT EXISTS "clientId" TEXT;
ALTER TABLE "AiOutput" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

CREATE INDEX IF NOT EXISTS "AiRun_clientId_idx" ON "AiRun"("clientId");
CREATE INDEX IF NOT EXISTS "AiRun_clientServiceId_idx" ON "AiRun"("clientServiceId");
CREATE INDEX IF NOT EXISTS "AiRun_projectId_idx" ON "AiRun"("projectId");
CREATE INDEX IF NOT EXISTS "AiOutput_clientId_idx" ON "AiOutput"("clientId");
CREATE INDEX IF NOT EXISTS "AiOutput_projectId_idx" ON "AiOutput"("projectId");
