BEGIN;

CREATE TABLE "ControlledIntake" (
  "id" UUID PRIMARY KEY, "channel" VARCHAR(32) NOT NULL, "sourceId" VARCHAR(120) NOT NULL,
  "sourceOccurredAt" TIMESTAMPTZ(3) NOT NULL, "acquisitionMode" VARCHAR(32) NOT NULL,
  "mappingVersion" VARCHAR(64) NOT NULL, "payloadHash" CHAR(64) NOT NULL, "leadId" TEXT NOT NULL,
  "websiteLeadReceiptId" UUID, "sourceProjectionLedgerId" UUID, "subjectType" VARCHAR(40) NOT NULL,
  "subjectName" VARCHAR(200), "firstName" VARCHAR(100) NOT NULL, "lastName" VARCHAR(100) NOT NULL,
  "email" VARCHAR(320), "phone" VARCHAR(80), "classificationState" VARCHAR(24) NOT NULL,
  "effectiveCategory" VARCHAR(120) NOT NULL, "serviceCatalogId" TEXT, "serviceRevisionId" UUID,
  "digitalProjectType" VARCHAR(80), "need" VARCHAR(2000) NOT NULL, "objective" VARCHAR(2000),
  "functions" VARCHAR(2000), "indicativeBudget" DECIMAL(65,30), "timing" VARCHAR(2000),
  "declaredMaterials" VARCHAR(2000), "materialsVerifiedComplete" BOOLEAN NOT NULL DEFAULT false,
  "declaredEngagementReference" VARCHAR(2000), "commercialOfferId" TEXT, "contractId" TEXT,
  "administrativeState" VARCHAR(32) NOT NULL DEFAULT 'NOT_APPLICABLE', "administrativeRequest" VARCHAR(2000),
  "paymentRecorded" BOOLEAN NOT NULL DEFAULT false, "creditVerified" BOOLEAN NOT NULL DEFAULT false,
  "engagementFormalized" BOOLEAN NOT NULL DEFAULT false, "started" BOOLEAN NOT NULL DEFAULT false,
  "operatorId" TEXT NOT NULL, "status" VARCHAR(24) NOT NULL DEFAULT 'RECORDED', "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ControlledIntake_channel_check" CHECK ("channel" IN ('WPFORMS_1265','WPFORMS_1098','WPFORMS_1485','EMAIL')),
  CONSTRAINT "ControlledIntake_mode_check" CHECK ("acquisitionMode" IN ('MANUAL_CONTINUITY','MANUAL_CONTROLLED','AUTHENTICATED_AUTOMATIC')),
  CONSTRAINT "ControlledIntake_subject_check" CHECK ("subjectType" IN ('PERSONA','IMPRESA','PROFESSIONISTA','SOGGETTO_DA_COSTITUIRE','ASSOCIAZIONE','COOPERATIVA','ENTE')),
  CONSTRAINT "ControlledIntake_state_check" CHECK ("classificationState" IN ('VERIFIED','TO_CLASSIFY') AND "status" IN ('RECORDED','ENROLLED')),
  CONSTRAINT "ControlledIntake_dormant_check" CHECK ("materialsVerifiedComplete"=false AND "paymentRecorded"=false AND "creditVerified"=false AND "engagementFormalized"=false AND "started"=false),
  CONSTRAINT "ControlledIntake_payload_hash_check" CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ControlledIntake_manual_source_check" CHECK (("acquisitionMode"='AUTHENTICATED_AUTOMATIC') = ("sourceProjectionLedgerId" IS NOT NULL)),
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("websiteLeadReceiptId") REFERENCES "WebsiteLeadReceipt"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("sourceProjectionLedgerId") REFERENCES "LeadProjectionLedger"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("serviceCatalogId") REFERENCES "ServiceCatalog"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("serviceRevisionId") REFERENCES "ServiceCatalogRevision"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("commercialOfferId") REFERENCES "CommercialOffer"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "ControlledIntake_source_identity_key" ON "ControlledIntake"("channel","sourceId");
CREATE UNIQUE INDEX "ControlledIntake_leadId_key" ON "ControlledIntake"("leadId");
CREATE UNIQUE INDEX "ControlledIntake_websiteLeadReceiptId_key" ON "ControlledIntake"("websiteLeadReceiptId");
CREATE UNIQUE INDEX "ControlledIntake_sourceProjectionLedgerId_key" ON "ControlledIntake"("sourceProjectionLedgerId");
CREATE INDEX "ControlledIntake_operator_created_idx" ON "ControlledIntake"("operatorId","createdAt","id");

CREATE TABLE "ControlledIntakeDuplicateCandidate" ("id" UUID PRIMARY KEY, "intakeId" UUID NOT NULL REFERENCES "ControlledIntake"("id") ON DELETE RESTRICT, "leadId" TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE RESTRICT, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "ControlledIntakeDuplicateCandidate_identity_key" ON "ControlledIntakeDuplicateCandidate"("intakeId","leadId");
CREATE INDEX "ControlledIntakeDuplicateCandidate_lead_idx" ON "ControlledIntakeDuplicateCandidate"("leadId","createdAt","id");

CREATE TABLE "ControlledIntakeDuplicateDecision" ("id" UUID PRIMARY KEY, "intakeId" UUID NOT NULL UNIQUE REFERENCES "ControlledIntake"("id") ON DELETE RESTRICT, "candidateLeadId" TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE RESTRICT, "outcome" VARCHAR(32) NOT NULL CHECK ("outcome" IN ('KEEP_DISTINCT','LINK_RELATED')), "actorUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT, "actorSessionId" UUID NOT NULL REFERENCES "InternalSession"("id") ON DELETE RESTRICT, "expectedVersion" INTEGER NOT NULL CHECK ("expectedVersion">0), "decisionHash" CHAR(64) NOT NULL CHECK ("decisionHash" ~ '^[0-9a-f]{64}$'), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);

COMMIT;
