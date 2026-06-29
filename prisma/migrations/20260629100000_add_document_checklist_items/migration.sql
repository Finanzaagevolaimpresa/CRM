CREATE TYPE "ChecklistItemStatus" AS ENUM ('da_richiedere', 'richiesto', 'ricevuto', 'validato', 'non_necessario');

CREATE TABLE "DocumentChecklistItem" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientServiceId" TEXT,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" "ChecklistItemStatus" NOT NULL DEFAULT 'da_richiedere',
    "documentId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentChecklistItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DocumentChecklistItem_clientId_idx" ON "DocumentChecklistItem"("clientId");
CREATE INDEX "DocumentChecklistItem_clientServiceId_idx" ON "DocumentChecklistItem"("clientServiceId");
CREATE INDEX "DocumentChecklistItem_projectId_idx" ON "DocumentChecklistItem"("projectId");
CREATE INDEX "DocumentChecklistItem_documentId_idx" ON "DocumentChecklistItem"("documentId");
