BEGIN;

ALTER TABLE "ClientDossier"
  ADD COLUMN "practiceReadinessId" UUID,
  ADD COLUMN "preAnalysisId" TEXT,
  ADD COLUMN "serviceRevisionId" UUID,
  ADD COLUMN "currentVersionId" UUID,
  ADD COLUMN "approvedVersionId" UUID;

CREATE UNIQUE INDEX "ClientDossier_practiceReadinessId_key" ON "ClientDossier"("practiceReadinessId");
CREATE UNIQUE INDEX "ClientDossier_currentVersionId_key" ON "ClientDossier"("currentVersionId");

CREATE TABLE "EngagementDossierVersion" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "dossierId" TEXT NOT NULL,
  "version" INTEGER NOT NULL, "title" TEXT NOT NULL, "content" TEXT NOT NULL,
  "contentHash" CHAR(64) NOT NULL, "practiceReadinessId" UUID NOT NULL,
  "acceptedOfferRevisionId" UUID NOT NULL, "serviceRevisionId" UUID NOT NULL,
  "preAnalysisId" TEXT NOT NULL, "materialSnapshot" JSONB NOT NULL,
  "createdById" TEXT NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EngagementDossierVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EngagementDossierVersion_dossierId_version_key" ON "EngagementDossierVersion"("dossierId", "version");
CREATE INDEX "EngagementDossierVersion_practiceReadinessId_createdAt_idx" ON "EngagementDossierVersion"("practiceReadinessId", "createdAt");
CREATE INDEX "EngagementDossierVersion_contentHash_idx" ON "EngagementDossierVersion"("contentHash");

CREATE TABLE "EngagementDossierReview" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "dossierId" TEXT NOT NULL,
  "versionId" UUID NOT NULL, "versionHash" CHAR(64) NOT NULL,
  "decision" VARCHAR(32) NOT NULL, "note" VARCHAR(2000) NOT NULL,
  "decidedById" TEXT NOT NULL, "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EngagementDossierReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EngagementDossierReview_decision_check" CHECK ("decision" IN ('REQUEST_CHANGES','APPROVED'))
);
CREATE UNIQUE INDEX "EngagementDossierReview_versionId_decision_key" ON "EngagementDossierReview"("versionId", "decision");
CREATE INDEX "EngagementDossierReview_dossierId_decidedAt_idx" ON "EngagementDossierReview"("dossierId", "decidedAt");

CREATE TABLE "EngagementDossierExport" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "dossierId" TEXT NOT NULL,
  "versionId" UUID NOT NULL, "versionHash" CHAR(64) NOT NULL,
  "format" VARCHAR(16) NOT NULL, "artifactHash" CHAR(64) NOT NULL,
  "exportedById" TEXT NOT NULL, "exportedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EngagementDossierExport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EngagementDossierExport_format_check" CHECK ("format" IN ('markdown','docx'))
);
CREATE INDEX "EngagementDossierExport_dossierId_exportedAt_idx" ON "EngagementDossierExport"("dossierId", "exportedAt");
CREATE INDEX "EngagementDossierExport_versionId_format_idx" ON "EngagementDossierExport"("versionId", "format");

CREATE TABLE "EngagementDossierDeliveryAuthorization" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "dossierId" TEXT NOT NULL,
  "versionId" UUID NOT NULL, "versionHash" CHAR(64) NOT NULL,
  "recipients" JSONB NOT NULL, "recipientsHash" CHAR(64) NOT NULL,
  "idempotencyHash" CHAR(64) NOT NULL, "authorizedById" TEXT NOT NULL,
  "authorizedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revokedAt" TIMESTAMPTZ(3),
  CONSTRAINT "EngagementDossierDeliveryAuthorization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EngagementDossierDeliveryAuthorization_idempotencyHash_key" ON "EngagementDossierDeliveryAuthorization"("idempotencyHash");
CREATE INDEX "EngagementDossierDeliveryAuthorization_dossierId_authorizedAt_idx" ON "EngagementDossierDeliveryAuthorization"("dossierId", "authorizedAt");

CREATE TABLE "EngagementDossierDeliveryReceipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "authorizationId" UUID NOT NULL,
  "outcome" VARCHAR(24) NOT NULL, "evidence" JSONB NOT NULL,
  "evidenceHash" CHAR(64) NOT NULL, "idempotencyHash" CHAR(64) NOT NULL,
  "recordedById" TEXT NOT NULL, "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EngagementDossierDeliveryReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EngagementDossierDeliveryReceipt_outcome_check" CHECK ("outcome" IN ('DELIVERED','FAILED'))
);
CREATE UNIQUE INDEX "EngagementDossierDeliveryReceipt_authorizationId_key" ON "EngagementDossierDeliveryReceipt"("authorizationId");
CREATE UNIQUE INDEX "EngagementDossierDeliveryReceipt_idempotencyHash_key" ON "EngagementDossierDeliveryReceipt"("idempotencyHash");

ALTER TABLE "ClientDossier" ADD CONSTRAINT "ClientDossier_practiceReadinessId_fkey" FOREIGN KEY ("practiceReadinessId") REFERENCES "PracticeReadiness"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ClientDossier" ADD CONSTRAINT "ClientDossier_preAnalysisId_fkey" FOREIGN KEY ("preAnalysisId") REFERENCES "PreAnalysis"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ClientDossier" ADD CONSTRAINT "ClientDossier_serviceRevisionId_fkey" FOREIGN KEY ("serviceRevisionId") REFERENCES "ServiceCatalogRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierVersion" ADD CONSTRAINT "EngagementDossierVersion_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "ClientDossier"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierVersion" ADD CONSTRAINT "EngagementDossierVersion_practiceReadinessId_fkey" FOREIGN KEY ("practiceReadinessId") REFERENCES "PracticeReadiness"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierVersion" ADD CONSTRAINT "EngagementDossierVersion_acceptedOfferRevisionId_fkey" FOREIGN KEY ("acceptedOfferRevisionId") REFERENCES "PracticeOfferRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierVersion" ADD CONSTRAINT "EngagementDossierVersion_serviceRevisionId_fkey" FOREIGN KEY ("serviceRevisionId") REFERENCES "ServiceCatalogRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierVersion" ADD CONSTRAINT "EngagementDossierVersion_preAnalysisId_fkey" FOREIGN KEY ("preAnalysisId") REFERENCES "PreAnalysis"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierReview" ADD CONSTRAINT "EngagementDossierReview_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "ClientDossier"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierReview" ADD CONSTRAINT "EngagementDossierReview_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EngagementDossierVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierExport" ADD CONSTRAINT "EngagementDossierExport_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "ClientDossier"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierExport" ADD CONSTRAINT "EngagementDossierExport_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EngagementDossierVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierDeliveryAuthorization" ADD CONSTRAINT "EngagementDossierDeliveryAuthorization_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "ClientDossier"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierDeliveryAuthorization" ADD CONSTRAINT "EngagementDossierDeliveryAuthorization_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EngagementDossierVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EngagementDossierDeliveryReceipt" ADD CONSTRAINT "EngagementDossierDeliveryReceipt_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "EngagementDossierDeliveryAuthorization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ClientDossier" ADD CONSTRAINT "ClientDossier_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "EngagementDossierVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ClientDossier" ADD CONSTRAINT "ClientDossier_approvedVersionId_fkey" FOREIGN KEY ("approvedVersionId") REFERENCES "EngagementDossierVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
