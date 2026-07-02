ALTER TABLE "CommercialOffer"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "services" TEXT,
  ADD COLUMN "includedActivities" TEXT,
  ADD COLUMN "validUntil" TIMESTAMP(3),
  ADD COLUMN "operationalConditions" TEXT,
  ADD COLUMN "commercialProposal" TEXT;
