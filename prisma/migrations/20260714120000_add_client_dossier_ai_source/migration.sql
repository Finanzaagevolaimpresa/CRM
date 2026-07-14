ALTER TABLE "ClientDossier"
ADD COLUMN "sourceAiOutputId" TEXT;

CREATE UNIQUE INDEX "ClientDossier_sourceAiOutputId_key"
ON "ClientDossier"("sourceAiOutputId");
