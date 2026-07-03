ALTER TABLE "CommercialOffer"
  ADD COLUMN "sentAt" TIMESTAMP(3),
  ADD COLUMN "followUpAt" TIMESTAMP(3),
  ADD COLUMN "followUpNote" TEXT,
  ADD COLUMN "outcomeNote" TEXT,
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionReason" TEXT;
