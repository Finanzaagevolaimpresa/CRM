-- N01: additive, dormant website-lead receipt and reusable rate-limit bucket.
CREATE TABLE "WebsiteLeadReceipt" (
  "id" UUID NOT NULL,
  "namespace" TEXT NOT NULL,
  "keyDigest" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "WebsiteLeadReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebsiteLeadReceipt_namespace_keyDigest_key" ON "WebsiteLeadReceipt"("namespace", "keyDigest");
CREATE INDEX "WebsiteLeadReceipt_createdAt_idx" ON "WebsiteLeadReceipt"("createdAt");

CREATE TABLE "WebsiteLeadRateLimitBucket" (
  "namespace" TEXT NOT NULL,
  "callerDigest" TEXT NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "requestCount" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebsiteLeadRateLimitBucket_pkey" PRIMARY KEY ("namespace")
);
