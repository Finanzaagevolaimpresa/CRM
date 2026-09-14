BEGIN;
CREATE TABLE "PracticeReadiness" (
  "id" UUID PRIMARY KEY, "controlledIntakeId" UUID NOT NULL UNIQUE REFERENCES "ControlledIntake"("id") ON DELETE RESTRICT,
  "commercialOfferId" TEXT NOT NULL REFERENCES "CommercialOffer"("id") ON DELETE RESTRICT,
  "offerSnapshotHash" CHAR(64) NOT NULL, "offerRevision" INTEGER NOT NULL CHECK ("offerRevision">0),
  "serviceRevisionId" UUID NOT NULL REFERENCES "ServiceCatalogRevision"("id") ON DELETE RESTRICT,
  "clientId" TEXT NOT NULL REFERENCES "Client"("id") ON DELETE RESTRICT, "projectId" TEXT REFERENCES "Project"("id") ON DELETE RESTRICT,
  "contractId" TEXT UNIQUE REFERENCES "Contract"("id") ON DELETE RESTRICT, "clientServiceId" TEXT UNIQUE REFERENCES "ClientService"("id") ON DELETE RESTRICT, "requiredInitialAmount" DECIMAL(18,2) NOT NULL CHECK ("requiredInitialAmount">=0),
  "currency" VARCHAR(3) NOT NULL DEFAULT 'EUR', "formalizedAt" TIMESTAMPTZ(3), "formalizedById" TEXT REFERENCES "User"("id") ON DELETE RESTRICT,
  "signedDocumentId" TEXT REFERENCES "Document"("id") ON DELETE RESTRICT, "materialsCompleteAt" TIMESTAMPTZ(3), "materialsCompleteById" TEXT REFERENCES "User"("id") ON DELETE RESTRICT,
  "startedAt" TIMESTAMPTZ(3), "startedById" TEXT REFERENCES "User"("id") ON DELETE RESTRICT, "startEvidence" JSONB, "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE "PracticeFundingEvidence" ("id" UUID PRIMARY KEY, "practiceId" UUID NOT NULL REFERENCES "PracticeReadiness"("id") ON DELETE RESTRICT, "reference" VARCHAR(120) NOT NULL, "amount" DECIMAL(18,2) NOT NULL CHECK("amount">0), "currency" VARCHAR(3) NOT NULL CHECK("currency"='EUR'), "status" VARCHAR(20) NOT NULL CHECK("status" IN ('DECLARED','CONFIRMED','REVERSED')), "sequence" INTEGER NOT NULL CHECK("sequence">0), "predecessorId" UUID UNIQUE REFERENCES "PracticeFundingEvidence"("id") ON DELETE RESTRICT, "payloadHash" CHAR(64) NOT NULL, "verifiedAt" TIMESTAMPTZ(3), "verifiedById" TEXT REFERENCES "User"("id") ON DELETE RESTRICT, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE("practiceId","reference","sequence"));
CREATE TABLE "PracticeMaterialEvidence" ("id" UUID PRIMARY KEY, "practiceId" UUID NOT NULL REFERENCES "PracticeReadiness"("id") ON DELETE RESTRICT, "checklistItemId" TEXT NOT NULL REFERENCES "DocumentChecklistItem"("id") ON DELETE RESTRICT, "documentId" TEXT REFERENCES "Document"("id") ON DELETE RESTRICT, "status" VARCHAR(20) NOT NULL CHECK("status" IN ('VALIDATED','NOT_NEEDED','INVALIDATED')), "reason" VARCHAR(500), "payloadHash" CHAR(64) NOT NULL, "decidedAt" TIMESTAMPTZ(3) NOT NULL, "decidedById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT, UNIQUE("practiceId","checklistItemId"));
CREATE INDEX "PracticeReadiness_context_idx" ON "PracticeReadiness"("clientId","projectId","createdAt");
CREATE INDEX "PracticeFundingEvidence_practice_idx" ON "PracticeFundingEvidence"("practiceId","status");
CREATE INDEX "PracticeMaterialEvidence_practice_idx" ON "PracticeMaterialEvidence"("practiceId","status");
COMMIT;
