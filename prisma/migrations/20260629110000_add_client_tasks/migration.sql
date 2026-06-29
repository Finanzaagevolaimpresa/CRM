CREATE TYPE "TaskStatus" AS ENUM ('aperta', 'in_lavorazione', 'completata', 'annullata');
CREATE TYPE "TaskPriority" AS ENUM ('bassa', 'media', 'alta', 'urgente');

UPDATE "Task" SET "status" = 'aperta' WHERE "status" IN ('aperto', 'aperta');
UPDATE "Task" SET "status" = 'in_lavorazione' WHERE "status" IN ('in_lavorazione', 'in lavorazione');
UPDATE "Task" SET "status" = 'completata' WHERE "status" IN ('chiuso', 'chiusa', 'completato', 'completata');
UPDATE "Task" SET "status" = 'annullata' WHERE "status" IN ('annullato', 'annullata', 'archiviato', 'archiviata');
UPDATE "Task" SET "status" = 'aperta' WHERE "status" NOT IN ('aperta', 'in_lavorazione', 'completata', 'annullata');

UPDATE "Task" SET "priority" = 'bassa' WHERE "priority" IN ('basso', 'bassa');
UPDATE "Task" SET "priority" = 'media' WHERE "priority" IN ('medio', 'media');
UPDATE "Task" SET "priority" = 'alta' WHERE "priority" IN ('alto', 'alta');
UPDATE "Task" SET "priority" = 'urgente' WHERE "priority" IN ('urgent', 'urgente');
UPDATE "Task" SET "priority" = 'media' WHERE "priority" NOT IN ('bassa', 'media', 'alta', 'urgente');

ALTER TABLE "Task" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Task" ALTER COLUMN "status" TYPE "TaskStatus" USING "status"::"TaskStatus";
ALTER TABLE "Task" ALTER COLUMN "status" SET DEFAULT 'aperta';
ALTER TABLE "Task" ALTER COLUMN "priority" DROP DEFAULT;
ALTER TABLE "Task" ALTER COLUMN "priority" TYPE "TaskPriority" USING "priority"::"TaskPriority";
ALTER TABLE "Task" ALTER COLUMN "priority" SET DEFAULT 'media';
ALTER TABLE "Task" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Task_clientId_idx" ON "Task"("clientId");
CREATE INDEX "Task_clientServiceId_idx" ON "Task"("clientServiceId");
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
CREATE INDEX "Task_assignedToId_idx" ON "Task"("assignedToId");
CREATE INDEX "Task_dueAt_idx" ON "Task"("dueAt");
