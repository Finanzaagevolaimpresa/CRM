CREATE TYPE "TechnicalPracticeStatus" AS ENUM ('da_progettare', 'in_progettazione', 'documenti_richiesti', 'documenti_completi', 'pronta_presentazione', 'presentata', 'integrazione_richiesta', 'in_istruttoria', 'approvata', 'respinta', 'archiviata');
CREATE TYPE "TechnicalPracticePriority" AS ENUM ('bassa', 'media', 'alta', 'urgente');

CREATE TABLE "TechnicalPractice" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "projectId" TEXT,
  "clientServiceId" TEXT,
  "commercialOwnerId" TEXT,
  "technicalOwnerId" TEXT,
  "title" TEXT NOT NULL,
  "practiceType" TEXT NOT NULL,
  "targetEntity" TEXT NOT NULL,
  "targetPortal" TEXT,
  "status" "TechnicalPracticeStatus" NOT NULL DEFAULT 'da_progettare',
  "priority" "TechnicalPracticePriority" NOT NULL DEFAULT 'media',
  "dueDate" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "protocolNumber" TEXT,
  "integrationRequestNote" TEXT,
  "internalNotes" TEXT,
  "clientVisibleStatus" TEXT,
  "nextClientUpdateAt" TIMESTAMP(3),
  "lastClientUpdateAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "TechnicalPractice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TechnicalPractice_clientId_idx" ON "TechnicalPractice"("clientId");
CREATE INDEX "TechnicalPractice_status_idx" ON "TechnicalPractice"("status");
CREATE INDEX "TechnicalPractice_dueDate_idx" ON "TechnicalPractice"("dueDate");
CREATE INDEX "TechnicalPractice_commercialOwnerId_idx" ON "TechnicalPractice"("commercialOwnerId");
CREATE INDEX "TechnicalPractice_technicalOwnerId_idx" ON "TechnicalPractice"("technicalOwnerId");
