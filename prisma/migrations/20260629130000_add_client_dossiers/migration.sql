CREATE TYPE "ClientDossierType" AS ENUM ('pre_analisi', 'dossier_cliente', 'nota_interna');
CREATE TYPE "ClientDossierStatus" AS ENUM ('bozza', 'revisionata', 'archiviata');

CREATE TABLE "ClientDossier" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientServiceId" TEXT,
  "projectId" TEXT,
  "title" TEXT NOT NULL,
  "type" "ClientDossierType" NOT NULL DEFAULT 'pre_analisi',
  "content" TEXT NOT NULL,
  "status" "ClientDossierStatus" NOT NULL DEFAULT 'bozza',
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT,
  "archivedById" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClientDossier_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientDossier_clientId_idx" ON "ClientDossier"("clientId");
CREATE INDEX "ClientDossier_clientServiceId_idx" ON "ClientDossier"("clientServiceId");
CREATE INDEX "ClientDossier_projectId_idx" ON "ClientDossier"("projectId");
CREATE INDEX "ClientDossier_status_idx" ON "ClientDossier"("status");
