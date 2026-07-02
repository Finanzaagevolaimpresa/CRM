ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'proposta_da_preparare';
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'proposta_inviata';
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'in_trattativa';
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'vinto';

CREATE TYPE "LeadSource" AS ENUM ('sito', 'whatsapp', 'referral', 'campagna', 'consulente', 'manuale', 'altro');
CREATE TYPE "LeadPriority" AS ENUM ('bassa', 'media', 'alta', 'urgente');
CREATE TYPE "CommercialOfferStatus" AS ENUM ('bozza', 'inviata', 'accettata', 'rifiutata', 'scaduta');

ALTER TABLE "Lead"
  ADD COLUMN "companyName" TEXT,
  ADD COLUMN "contactPerson" TEXT,
  ADD COLUMN "leadSource" "LeadSource" NOT NULL DEFAULT 'manuale',
  ADD COLUMN "city" TEXT,
  ADD COLUMN "requestedAmount" DECIMAL(65,30),
  ADD COLUMN "availableBudget" DECIMAL(65,30),
  ADD COLUMN "priority" "LeadPriority" NOT NULL DEFAULT 'media',
  ADD COLUMN "nextActionNote" TEXT,
  ADD COLUMN "nextActionDate" TIMESTAMP(3),
  ADD COLUMN "commercialProposal" TEXT,
  ADD COLUMN "clientId" TEXT;

UPDATE "Lead" SET "nextActionDate" = "nextAction" WHERE "nextAction" IS NOT NULL;

CREATE TABLE "CommercialOffer" (
  "id" TEXT NOT NULL,
  "leadId" TEXT,
  "clientId" TEXT,
  "title" TEXT NOT NULL,
  "taxableAmount" DECIMAL(65,30) NOT NULL,
  "vatAmount" DECIMAL(65,30) NOT NULL,
  "totalAmount" DECIMAL(65,30) NOT NULL,
  "status" "CommercialOfferStatus" NOT NULL DEFAULT 'bozza',
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "CommercialOffer_pkey" PRIMARY KEY ("id")
);
