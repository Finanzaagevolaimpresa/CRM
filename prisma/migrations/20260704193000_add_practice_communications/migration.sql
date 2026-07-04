-- Step 19B: controlled practice communications, drafts, review and manual usage tracking.
CREATE TYPE "PracticeCommunicationType" AS ENUM ('cliente', 'commerciale', 'interna');
CREATE TYPE "PracticeCommunicationChannel" AS ENUM ('whatsapp', 'email', 'telefono', 'pec', 'nota_interna');
CREATE TYPE "PracticeCommunicationStatus" AS ENUM ('bozza', 'da_revisionare', 'approvata', 'usata_inviata', 'archiviata');

CREATE TABLE "PracticeCommunication" (
    "id" TEXT NOT NULL,
    "technicalPracticeId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "projectId" TEXT,
    "clientServiceId" TEXT,
    "commercialOwnerId" TEXT,
    "technicalOwnerId" TEXT,
    "type" "PracticeCommunicationType" NOT NULL,
    "channel" "PracticeCommunicationChannel" NOT NULL,
    "status" "PracticeCommunicationStatus" NOT NULL DEFAULT 'bozza',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "internalNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "PracticeCommunication_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PracticeCommunication_technicalPracticeId_idx" ON "PracticeCommunication"("technicalPracticeId");
CREATE INDEX "PracticeCommunication_clientId_idx" ON "PracticeCommunication"("clientId");
CREATE INDEX "PracticeCommunication_commercialOwnerId_idx" ON "PracticeCommunication"("commercialOwnerId");
CREATE INDEX "PracticeCommunication_status_idx" ON "PracticeCommunication"("status");
CREATE INDEX "PracticeCommunication_type_idx" ON "PracticeCommunication"("type");
