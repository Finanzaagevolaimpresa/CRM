-- N13 Lead Projection, Normalization & Manual Duplicate Resolution v1.
-- Additive and deliberately business-empty: no key version, event, Lead, seed, backfill, gate or activation.

BEGIN;

ALTER TABLE "PrivacyEvidenceReceipt"
  ALTER COLUMN "leadId" DROP NOT NULL,
  ALTER COLUMN "websiteLeadReceiptId" DROP NOT NULL,
  ADD COLUMN "businessInboxEventId" UUID;

ALTER TABLE "PrivacyEvidenceReceipt"
  ADD CONSTRAINT "PrivacyEvidenceReceipt_source_binding_check" CHECK (
    ("websiteLeadReceiptId" IS NOT NULL AND "businessInboxEventId" IS NULL AND "leadId" IS NOT NULL)
    OR ("websiteLeadReceiptId" IS NULL AND "businessInboxEventId" IS NOT NULL AND "leadId" IS NULL)
  ),
  ADD CONSTRAINT "PrivacyEvidenceReceipt_businessInboxEventId_fkey"
    FOREIGN KEY ("businessInboxEventId") REFERENCES "BusinessInboxEvent"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "PrivacyEvidenceReceipt_business_source_purpose_key"
  ON "PrivacyEvidenceReceipt"("businessInboxEventId", "purposeCode");
CREATE INDEX "PrivacyEvidenceReceipt_business_created_idx"
  ON "PrivacyEvidenceReceipt"("businessInboxEventId", "createdAt");

CREATE TABLE "LeadIdentityKeyVersion" (
  "id" UUID NOT NULL,
  "normalizationVersion" VARCHAR(32) NOT NULL,
  "version" INTEGER NOT NULL,
  "keyDigest" CHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'STAGED',
  "activatedAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "retiredAt" TIMESTAMPTZ(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadIdentityKeyVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeadIdentityKeyVersion_contract_check" CHECK (
    "id"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "normalizationVersion" = 'n13-v1'
    AND "version" > 0
    AND "keyDigest" ~ '^[0-9a-f]{64}$'
    AND "updatedAt" >= "createdAt"
  ),
  CONSTRAINT "LeadIdentityKeyVersion_lifecycle_check" CHECK (
    ("status" = 'STAGED' AND "activatedAt" IS NULL AND "revokedAt" IS NULL AND "retiredAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "revokedAt" IS NULL AND "retiredAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL AND "retiredAt" IS NULL)
    OR ("status" = 'RETIRED' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL)
  ),
  CONSTRAINT "LeadIdentityKeyVersion_createdById_fkey" FOREIGN KEY ("createdById")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "LeadIdentityKeyVersion_identity_key"
  ON "LeadIdentityKeyVersion"("normalizationVersion", "version");
CREATE UNIQUE INDEX "LeadIdentityKeyVersion_one_active_key"
  ON "LeadIdentityKeyVersion"("normalizationVersion") WHERE "status" = 'ACTIVE';
CREATE INDEX "LeadIdentityKeyVersion_lookup_idx"
  ON "LeadIdentityKeyVersion"("normalizationVersion", "status", "version");
CREATE INDEX "LeadIdentityKeyVersion_createdBy_idx"
  ON "LeadIdentityKeyVersion"("createdById");

CREATE TABLE "LeadProjectionLedger" (
  "id" UUID NOT NULL,
  "inboxEventId" UUID NOT NULL,
  "sourceRecordHash" CHAR(64) NOT NULL,
  "state" VARCHAR(32) NOT NULL,
  "leadId" TEXT,
  "candidateCount" INTEGER NOT NULL,
  "normalizationVersion" VARCHAR(32) NOT NULL,
  "identityKeyVersionId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "privacyEvidenceCount" INTEGER NOT NULL DEFAULT 2,
  "resultHash" CHAR(64) NOT NULL,
  "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'LEAD_PROJECTION',
  "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
  "retentionEligibleAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadProjectionLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeadProjectionLedger_contract_check" CHECK (
    "id"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "sourceRecordHash" ~ '^[0-9a-f]{64}$'
    AND "resultHash" ~ '^[0-9a-f]{64}$'
    AND "normalizationVersion" = 'n13-v1'
    AND "candidateCount" >= 0
    AND "version" > 0
    AND "privacyEvidenceCount" = 2
    AND "retentionClass" = 'LEAD_PROJECTION'
    AND "retentionPolicyVersion" = 'N21_UNASSIGNED'
    AND "retentionEligibleAt" IS NULL
    AND "completedAt" IS NOT NULL
    AND "updatedAt" >= "createdAt"
    AND (
      ("state" = 'PROJECTED_NEW' AND "leadId" IS NOT NULL AND "candidateCount" = 0)
      OR ("state" = 'REVIEW_REQUIRED' AND "leadId" IS NULL)
      OR ("state" = 'RESOLVED_EXISTING' AND "leadId" IS NOT NULL AND "candidateCount" >= 1)
      OR ("state" = 'RESOLVED_NEW' AND "leadId" IS NOT NULL AND "candidateCount" >= 0)
    )
  ),
  CONSTRAINT "LeadProjectionLedger_inboxEventId_fkey" FOREIGN KEY ("inboxEventId")
    REFERENCES "BusinessInboxEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LeadProjectionLedger_leadId_fkey" FOREIGN KEY ("leadId")
    REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LeadProjectionLedger_identityKeyVersionId_fkey" FOREIGN KEY ("identityKeyVersionId")
    REFERENCES "LeadIdentityKeyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "LeadProjectionLedger_inboxEventId_key"
  ON "LeadProjectionLedger"("inboxEventId");
CREATE INDEX "LeadProjectionLedger_state_idx"
  ON "LeadProjectionLedger"("state", "updatedAt", "id");
CREATE INDEX "LeadProjectionLedger_lead_idx"
  ON "LeadProjectionLedger"("leadId", "createdAt", "id");
CREATE INDEX "LeadProjectionLedger_retention_idx"
  ON "LeadProjectionLedger"("retentionPolicyVersion", "retentionEligibleAt", "id");

CREATE TABLE "LeadDuplicateCase" (
  "id" UUID NOT NULL,
  "projectionLedgerId" UUID NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  "discoveryRevision" INTEGER NOT NULL DEFAULT 1,
  "candidateCount" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "resolvedAt" TIMESTAMPTZ(3),
  "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'LEAD_DUPLICATE_CASE',
  "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
  "retentionEligibleAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadDuplicateCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeadDuplicateCase_contract_check" CHECK (
    "id"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "discoveryRevision" > 0
    AND "candidateCount" >= 0
    AND "version" > 0
    AND "retentionClass" = 'LEAD_DUPLICATE_CASE'
    AND "retentionPolicyVersion" = 'N21_UNASSIGNED'
    AND "retentionEligibleAt" IS NULL
    AND "updatedAt" >= "createdAt"
    AND (("state" = 'OPEN' AND "resolvedAt" IS NULL) OR ("state" = 'RESOLVED' AND "resolvedAt" IS NOT NULL))
  ),
  CONSTRAINT "LeadDuplicateCase_projectionLedgerId_fkey" FOREIGN KEY ("projectionLedgerId")
    REFERENCES "LeadProjectionLedger"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "LeadDuplicateCase_projectionLedgerId_key"
  ON "LeadDuplicateCase"("projectionLedgerId");
CREATE INDEX "LeadDuplicateCase_state_idx"
  ON "LeadDuplicateCase"("state", "updatedAt", "id");
CREATE INDEX "LeadDuplicateCase_retention_idx"
  ON "LeadDuplicateCase"("retentionPolicyVersion", "retentionEligibleAt", "id");

CREATE TABLE "LeadDuplicateCandidate" (
  "id" UUID NOT NULL,
  "duplicateCaseId" UUID NOT NULL,
  "discoveryRevision" INTEGER NOT NULL,
  "leadId" TEXT NOT NULL,
  "rank" INTEGER NOT NULL,
  "strongestSignal" VARCHAR(16) NOT NULL,
  "strongSignalCount" INTEGER NOT NULL,
  "weakSignalCount" INTEGER NOT NULL,
  "matchedSignalCodes" JSONB NOT NULL,
  "snapshotHash" CHAR(64) NOT NULL,
  "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'LEAD_DUPLICATE_CANDIDATE',
  "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
  "retentionEligibleAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadDuplicateCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeadDuplicateCandidate_contract_check" CHECK (
    "id"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "discoveryRevision" > 0
    AND "rank" > 0
    AND "strongestSignal" IN ('STRONG', 'WEAK')
    AND "strongSignalCount" >= 0
    AND "weakSignalCount" >= 0
    AND "strongSignalCount" + "weakSignalCount" > 0
    AND (("strongestSignal" = 'STRONG' AND "strongSignalCount" > 0) OR ("strongestSignal" = 'WEAK' AND "strongSignalCount" = 0 AND "weakSignalCount" > 0))
    AND JSONB_TYPEOF("matchedSignalCodes") = 'array'
    AND "snapshotHash" ~ '^[0-9a-f]{64}$'
    AND "retentionClass" = 'LEAD_DUPLICATE_CANDIDATE'
    AND "retentionPolicyVersion" = 'N21_UNASSIGNED'
    AND "retentionEligibleAt" IS NULL
  ),
  CONSTRAINT "LeadDuplicateCandidate_duplicateCaseId_fkey" FOREIGN KEY ("duplicateCaseId")
    REFERENCES "LeadDuplicateCase"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LeadDuplicateCandidate_leadId_fkey" FOREIGN KEY ("leadId")
    REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "LeadDuplicateCandidate_case_revision_lead_key"
  ON "LeadDuplicateCandidate"("duplicateCaseId", "discoveryRevision", "leadId");
CREATE UNIQUE INDEX "LeadDuplicateCandidate_case_revision_rank_key"
  ON "LeadDuplicateCandidate"("duplicateCaseId", "discoveryRevision", "rank");
CREATE INDEX "LeadDuplicateCandidate_lead_idx"
  ON "LeadDuplicateCandidate"("leadId", "createdAt", "id");
CREATE INDEX "LeadDuplicateCandidate_retention_idx"
  ON "LeadDuplicateCandidate"("retentionPolicyVersion", "retentionEligibleAt", "id");

CREATE TABLE "LeadDuplicateDecision" (
  "id" UUID NOT NULL,
  "duplicateCaseId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "caseVersionBefore" INTEGER NOT NULL,
  "outcome" VARCHAR(40) NOT NULL,
  "selectedLeadId" TEXT,
  "resultingLeadId" TEXT,
  "actorUserId" TEXT NOT NULL,
  "actorSessionId" UUID NOT NULL,
  "reasonCode" VARCHAR(64) NOT NULL,
  "reasonNote" VARCHAR(500),
  "decisionHash" CHAR(64) NOT NULL,
  "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'LEAD_DUPLICATE_DECISION',
  "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
  "retentionEligibleAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadDuplicateDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeadDuplicateDecision_contract_check" CHECK (
    "id"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "actorSessionId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "sequence" > 0
    AND "caseVersionBefore" > 0
    AND "reasonCode" ~ '^[A-Z0-9][A-Z0-9_]{0,63}$'
    AND "decisionHash" ~ '^[0-9a-f]{64}$'
    AND "retentionClass" = 'LEAD_DUPLICATE_DECISION'
    AND "retentionPolicyVersion" = 'N21_UNASSIGNED'
    AND "retentionEligibleAt" IS NULL
    AND (
      ("outcome" = 'LINK_EXISTING_NO_OVERWRITE' AND "selectedLeadId" IS NOT NULL AND "resultingLeadId" = "selectedLeadId")
      OR ("outcome" = 'CREATE_NEW' AND "selectedLeadId" IS NULL AND "resultingLeadId" IS NOT NULL)
      OR ("outcome" = 'REOPEN' AND "selectedLeadId" IS NULL AND "resultingLeadId" IS NULL)
    )
  ),
  CONSTRAINT "LeadDuplicateDecision_duplicateCaseId_fkey" FOREIGN KEY ("duplicateCaseId")
    REFERENCES "LeadDuplicateCase"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LeadDuplicateDecision_selectedLeadId_fkey" FOREIGN KEY ("selectedLeadId")
    REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LeadDuplicateDecision_resultingLeadId_fkey" FOREIGN KEY ("resultingLeadId")
    REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "LeadDuplicateDecision_case_sequence_key"
  ON "LeadDuplicateDecision"("duplicateCaseId", "sequence");
CREATE INDEX "LeadDuplicateDecision_actor_idx"
  ON "LeadDuplicateDecision"("actorUserId", "createdAt", "id");
CREATE INDEX "LeadDuplicateDecision_resultingLead_idx"
  ON "LeadDuplicateDecision"("resultingLeadId", "createdAt", "id");
CREATE INDEX "LeadDuplicateDecision_retention_idx"
  ON "LeadDuplicateDecision"("retentionPolicyVersion", "retentionEligibleAt", "id");

CREATE TABLE "LeadIdentityKey" (
  "id" UUID NOT NULL,
  "leadId" TEXT NOT NULL,
  "identityKeyVersionId" UUID NOT NULL,
  "normalizationVersion" VARCHAR(32) NOT NULL,
  "signalKind" VARCHAR(40) NOT NULL,
  "signalStrength" VARCHAR(16) NOT NULL,
  "identityDigest" CHAR(64) NOT NULL,
  "sourceProjectionId" UUID NOT NULL,
  "sourceDecisionId" UUID,
  "retiredAt" TIMESTAMPTZ(3),
  "retiredByDecisionId" UUID,
  "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'LEAD_IDENTITY_KEY',
  "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
  "retentionEligibleAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadIdentityKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeadIdentityKey_contract_check" CHECK (
    "id"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "normalizationVersion" = 'n13-v1'
    AND "signalKind" IN ('EMAIL_EXACT_V1', 'PHONE_E164_EXACT_V1', 'PHONE_NATIONAL_EXACT_V1', 'PERSON_NAME_EXACT_V1', 'COMPANY_NAME_EXACT_V1')
    AND "signalStrength" IN ('STRONG', 'WEAK')
    AND (("signalKind" IN ('EMAIL_EXACT_V1', 'PHONE_E164_EXACT_V1') AND "signalStrength" = 'STRONG')
      OR ("signalKind" IN ('PHONE_NATIONAL_EXACT_V1', 'PERSON_NAME_EXACT_V1', 'COMPANY_NAME_EXACT_V1') AND "signalStrength" = 'WEAK'))
    AND "identityDigest" ~ '^[0-9a-f]{64}$'
    AND (("retiredAt" IS NULL AND "retiredByDecisionId" IS NULL) OR ("retiredAt" IS NOT NULL AND "retiredByDecisionId" IS NOT NULL))
    AND "retentionClass" = 'LEAD_IDENTITY_KEY'
    AND "retentionPolicyVersion" = 'N21_UNASSIGNED'
    AND "retentionEligibleAt" IS NULL
  ),
  CONSTRAINT "LeadIdentityKey_leadId_fkey" FOREIGN KEY ("leadId")
    REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LeadIdentityKey_identityKeyVersionId_fkey" FOREIGN KEY ("identityKeyVersionId")
    REFERENCES "LeadIdentityKeyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LeadIdentityKey_sourceProjectionId_fkey" FOREIGN KEY ("sourceProjectionId")
    REFERENCES "LeadProjectionLedger"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LeadIdentityKey_sourceDecisionId_fkey" FOREIGN KEY ("sourceDecisionId")
    REFERENCES "LeadDuplicateDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LeadIdentityKey_retiredByDecisionId_fkey" FOREIGN KEY ("retiredByDecisionId")
    REFERENCES "LeadDuplicateDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "LeadIdentityKey_source_decision_lead_signal_key"
  ON "LeadIdentityKey"("sourceProjectionId", "sourceDecisionId", "leadId", "signalKind", "identityDigest")
  NULLS NOT DISTINCT;
CREATE INDEX "LeadIdentityKey_lookup_idx"
  ON "LeadIdentityKey"("normalizationVersion", "identityKeyVersionId", "signalKind", "identityDigest", "retiredAt");
CREATE INDEX "LeadIdentityKey_active_lookup_idx"
  ON "LeadIdentityKey"("normalizationVersion", "identityKeyVersionId", "signalKind", "identityDigest", "leadId")
  WHERE "retiredAt" IS NULL;
CREATE INDEX "LeadIdentityKey_lead_idx"
  ON "LeadIdentityKey"("leadId", "retiredAt", "createdAt", "id");
CREATE INDEX "LeadIdentityKey_sourceDecision_idx"
  ON "LeadIdentityKey"("sourceDecisionId", "createdAt", "id");
CREATE INDEX "LeadIdentityKey_retiredDecision_idx"
  ON "LeadIdentityKey"("retiredByDecisionId", "createdAt", "id");
CREATE INDEX "LeadIdentityKey_retention_idx"
  ON "LeadIdentityKey"("retentionPolicyVersion", "retentionEligibleAt", "id");

CREATE INDEX "Lead_active_email_normalized_idx"
  ON "Lead"(LOWER(BTRIM("email")))
  WHERE "deletedAt" IS NULL AND "email" IS NOT NULL;
CREATE INDEX "Lead_active_phone_e164_normalized_idx"
  ON "Lead"((REGEXP_REPLACE("phone", '[[:space:]().-]', '', 'g')))
  WHERE "deletedAt" IS NULL AND "phone" IS NOT NULL
    AND REGEXP_REPLACE("phone", '[[:space:]().-]', '', 'g') ~ '^\+[1-9][0-9]{6,14}$';
CREATE INDEX "Lead_active_person_name_normalized_idx"
  ON "Lead"(
    LOWER(REGEXP_REPLACE(BTRIM("firstName"), '[[:space:]]+', ' ', 'g')),
    LOWER(REGEXP_REPLACE(BTRIM("lastName"), '[[:space:]]+', ' ', 'g'))
  ) WHERE "deletedAt" IS NULL;
CREATE INDEX "Lead_active_company_name_normalized_idx"
  ON "Lead"(LOWER(REGEXP_REPLACE(BTRIM("companyName"), '[[:space:]]+', ' ', 'g')))
  WHERE "deletedAt" IS NULL AND "companyName" IS NOT NULL;

CREATE FUNCTION fai_lead_identity_key_version_guard_n13_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE transition_now TIMESTAMPTZ(3);
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'LEAD_IDENTITY_KEY_VERSION_NONDELETABLE'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'STAGED' THEN RAISE EXCEPTION 'LEAD_IDENTITY_KEY_VERSION_INITIAL_STATE_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."normalizationVersion", NEW."version", NEW."keyDigest", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."normalizationVersion", OLD."version", OLD."keyDigest", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'LEAD_IDENTITY_KEY_VERSION_IDENTITY_IMMUTABLE';
  END IF;
  transition_now := DATE_TRUNC('milliseconds', clock_timestamp());
  IF OLD."status" = 'STAGED' AND NEW."status" = 'ACTIVE' THEN
    IF NEW."activatedAt" IS NULL OR NEW."activatedAt" > transition_now
       OR NEW."revokedAt" IS NOT NULL OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'LEAD_IDENTITY_KEY_VERSION_TRANSITION_INVALID';
    END IF;
  ELSIF OLD."status" IN ('STAGED', 'ACTIVE') AND NEW."status" = 'REVOKED' THEN
    IF NEW."revokedAt" IS NULL OR NEW."revokedAt" > transition_now
       OR NEW."retiredAt" IS NOT NULL OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" THEN
      RAISE EXCEPTION 'LEAD_IDENTITY_KEY_VERSION_TRANSITION_INVALID';
    END IF;
  ELSIF OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED' THEN
    IF NEW."retiredAt" IS NULL OR NEW."retiredAt" > transition_now
       OR NEW."revokedAt" IS NOT NULL OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" THEN
      RAISE EXCEPTION 'LEAD_IDENTITY_KEY_VERSION_TRANSITION_INVALID';
    END IF;
  ELSIF NEW."status" = OLD."status" AND
        (NEW."activatedAt", NEW."revokedAt", NEW."retiredAt") IS NOT DISTINCT FROM
        (OLD."activatedAt", OLD."revokedAt", OLD."retiredAt") THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'LEAD_IDENTITY_KEY_VERSION_TRANSITION_INVALID';
  END IF;
  NEW."updatedAt" := transition_now;
  RETURN NEW;
END;
$$;

CREATE FUNCTION fai_lead_projection_ledger_guard_n13_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'LEAD_PROJECTION_LEDGER_NONDELETABLE'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 OR NEW."state" NOT IN ('PROJECTED_NEW', 'REVIEW_REQUIRED') THEN
      RAISE EXCEPTION 'LEAD_PROJECTION_LEDGER_INITIAL_STATE_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."inboxEventId", NEW."sourceRecordHash", NEW."normalizationVersion",
      NEW."identityKeyVersionId", NEW."privacyEvidenceCount", NEW."retentionClass",
      NEW."retentionPolicyVersion", NEW."retentionEligibleAt", NEW."completedAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."inboxEventId", OLD."sourceRecordHash", OLD."normalizationVersion",
      OLD."identityKeyVersionId", OLD."privacyEvidenceCount", OLD."retentionClass",
      OLD."retentionPolicyVersion", OLD."retentionEligibleAt", OLD."completedAt", OLD."createdAt")
     OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'LEAD_PROJECTION_LEDGER_IMMUTABLE_OR_VERSION_INVALID';
  END IF;
  IF NOT ((OLD."state" = 'REVIEW_REQUIRED' AND NEW."state" IN ('RESOLVED_EXISTING', 'RESOLVED_NEW'))
      OR (OLD."state" IN ('RESOLVED_EXISTING', 'RESOLVED_NEW') AND NEW."state" = 'REVIEW_REQUIRED')) THEN
    RAISE EXCEPTION 'LEAD_PROJECTION_LEDGER_TRANSITION_INVALID';
  END IF;
  NEW."updatedAt" := DATE_TRUNC('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

CREATE FUNCTION fai_lead_duplicate_case_guard_n13_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'LEAD_DUPLICATE_CASE_NONDELETABLE'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'OPEN' OR NEW."version" <> 1 OR NEW."discoveryRevision" <> 1 OR NEW."candidateCount" < 1 THEN
      RAISE EXCEPTION 'LEAD_DUPLICATE_CASE_INITIAL_STATE_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."projectionLedgerId", NEW."retentionClass", NEW."retentionPolicyVersion",
      NEW."retentionEligibleAt", NEW."createdAt") IS DISTINCT FROM
     (OLD."id", OLD."projectionLedgerId", OLD."retentionClass", OLD."retentionPolicyVersion",
      OLD."retentionEligibleAt", OLD."createdAt") OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'LEAD_DUPLICATE_CASE_IMMUTABLE_OR_VERSION_INVALID';
  END IF;
  IF OLD."state" = 'OPEN' AND NEW."state" = 'RESOLVED' THEN
    IF NEW."discoveryRevision" <> OLD."discoveryRevision" OR NEW."candidateCount" <> OLD."candidateCount" OR NEW."resolvedAt" IS NULL THEN
      RAISE EXCEPTION 'LEAD_DUPLICATE_CASE_TRANSITION_INVALID';
    END IF;
  ELSIF OLD."state" = 'RESOLVED' AND NEW."state" = 'OPEN' THEN
    IF NEW."discoveryRevision" <> OLD."discoveryRevision" + 1 OR NEW."resolvedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'LEAD_DUPLICATE_CASE_TRANSITION_INVALID';
    END IF;
  ELSE
    RAISE EXCEPTION 'LEAD_DUPLICATE_CASE_TRANSITION_INVALID';
  END IF;
  NEW."updatedAt" := DATE_TRUNC('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

CREATE FUNCTION fai_lead_identity_key_guard_n13_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'LEAD_IDENTITY_KEY_NONDELETABLE'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."retiredAt" IS NOT NULL OR NEW."retiredByDecisionId" IS NOT NULL THEN
      RAISE EXCEPTION 'LEAD_IDENTITY_KEY_INITIAL_STATE_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."leadId", NEW."identityKeyVersionId", NEW."normalizationVersion",
      NEW."signalKind", NEW."signalStrength", NEW."identityDigest", NEW."sourceProjectionId",
      NEW."sourceDecisionId", NEW."retentionClass", NEW."retentionPolicyVersion",
      NEW."retentionEligibleAt", NEW."createdAt") IS DISTINCT FROM
     (OLD."id", OLD."leadId", OLD."identityKeyVersionId", OLD."normalizationVersion",
      OLD."signalKind", OLD."signalStrength", OLD."identityDigest", OLD."sourceProjectionId",
      OLD."sourceDecisionId", OLD."retentionClass", OLD."retentionPolicyVersion",
      OLD."retentionEligibleAt", OLD."createdAt")
     OR OLD."retiredAt" IS NOT NULL OR OLD."retiredByDecisionId" IS NOT NULL
     OR NEW."retiredAt" IS NULL OR NEW."retiredByDecisionId" IS NULL THEN
    RAISE EXCEPTION 'LEAD_IDENTITY_KEY_RETIREMENT_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION fai_lead_append_only_guard_n13_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEAD_DUPLICATE_HISTORY_IMMUTABLE';
END;
$$;

CREATE TRIGGER "LeadIdentityKeyVersion_guard_n13_v1"
BEFORE INSERT OR UPDATE OR DELETE ON "LeadIdentityKeyVersion"
FOR EACH ROW EXECUTE FUNCTION fai_lead_identity_key_version_guard_n13_v1();
CREATE TRIGGER "LeadIdentityKeyVersion_deny_truncate_n13_v1"
BEFORE TRUNCATE ON "LeadIdentityKeyVersion"
FOR EACH STATEMENT EXECUTE FUNCTION fai_lead_identity_key_version_guard_n13_v1();

CREATE TRIGGER "LeadProjectionLedger_guard_n13_v1"
BEFORE INSERT OR UPDATE OR DELETE ON "LeadProjectionLedger"
FOR EACH ROW EXECUTE FUNCTION fai_lead_projection_ledger_guard_n13_v1();
CREATE TRIGGER "LeadProjectionLedger_deny_truncate_n13_v1"
BEFORE TRUNCATE ON "LeadProjectionLedger"
FOR EACH STATEMENT EXECUTE FUNCTION fai_lead_projection_ledger_guard_n13_v1();

CREATE TRIGGER "LeadDuplicateCase_guard_n13_v1"
BEFORE INSERT OR UPDATE OR DELETE ON "LeadDuplicateCase"
FOR EACH ROW EXECUTE FUNCTION fai_lead_duplicate_case_guard_n13_v1();
CREATE TRIGGER "LeadDuplicateCase_deny_truncate_n13_v1"
BEFORE TRUNCATE ON "LeadDuplicateCase"
FOR EACH STATEMENT EXECUTE FUNCTION fai_lead_duplicate_case_guard_n13_v1();

CREATE TRIGGER "LeadIdentityKey_guard_n13_v1"
BEFORE INSERT OR UPDATE OR DELETE ON "LeadIdentityKey"
FOR EACH ROW EXECUTE FUNCTION fai_lead_identity_key_guard_n13_v1();
CREATE TRIGGER "LeadIdentityKey_deny_truncate_n13_v1"
BEFORE TRUNCATE ON "LeadIdentityKey"
FOR EACH STATEMENT EXECUTE FUNCTION fai_lead_identity_key_guard_n13_v1();

CREATE TRIGGER "LeadDuplicateCandidate_guard_n13_v1"
BEFORE UPDATE OR DELETE ON "LeadDuplicateCandidate"
FOR EACH ROW EXECUTE FUNCTION fai_lead_append_only_guard_n13_v1();
CREATE TRIGGER "LeadDuplicateCandidate_deny_truncate_n13_v1"
BEFORE TRUNCATE ON "LeadDuplicateCandidate"
FOR EACH STATEMENT EXECUTE FUNCTION fai_lead_append_only_guard_n13_v1();
CREATE TRIGGER "LeadDuplicateDecision_guard_n13_v1"
BEFORE UPDATE OR DELETE ON "LeadDuplicateDecision"
FOR EACH ROW EXECUTE FUNCTION fai_lead_append_only_guard_n13_v1();
CREATE TRIGGER "LeadDuplicateDecision_deny_truncate_n13_v1"
BEFORE TRUNCATE ON "LeadDuplicateDecision"
FOR EACH STATEMENT EXECUTE FUNCTION fai_lead_append_only_guard_n13_v1();

CREATE OR REPLACE FUNCTION "privacy_evidence_receipt_validate_v1"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  notice_row "PrivacyNoticeVersion"%ROWTYPE;
  website_payload_hash TEXT;
  inbox_row "BusinessInboxEvent"%ROWTYPE;
  event_privacy_reference JSONB;
  expected_evidence_hash TEXT;
BEGIN
  IF NEW."websiteLeadReceiptId" IS NOT NULL THEN
    SELECT "payloadHash" INTO website_payload_hash
    FROM "WebsiteLeadReceipt" WHERE "id" = NEW."websiteLeadReceiptId" FOR SHARE;
    IF NOT FOUND OR website_payload_hash IS DISTINCT FROM NEW."sourceEvidenceDigest" THEN
      RAISE EXCEPTION 'Privacy evidence source receipt binding denied';
    END IF;
  ELSE
    SELECT * INTO inbox_row FROM "BusinessInboxEvent"
    WHERE "id" = NEW."businessInboxEventId" FOR SHARE;
    IF NOT FOUND
      OR inbox_row."schemaVersion" <> 'fai.lead-event.v1'
      OR inbox_row."eventType" <> 'LEAD_SUBMITTED'
      OR inbox_row."eventVersion" <> 1
      OR inbox_row."canonicalizationVersion" <> 1
      OR inbox_row."classificationCatalogVersion" <> 'n04-v1'
      OR inbox_row."classificationContractCode" <> 'lead_business_event_v1'
      OR NEW."catalogVersion" IS DISTINCT FROM inbox_row."classificationCatalogVersion"
      OR inbox_row."payloadHash" IS DISTINCT FROM NEW."sourceEvidenceDigest"
      OR inbox_row."envelopeJson"::JSONB #>> '{idempotency,payloadHash}' IS DISTINCT FROM NEW."sourceEvidenceDigest"
      OR inbox_row."envelopeJson"::JSONB #>> '{source,systemCode}' IS DISTINCT FROM NEW."sourceSystem"
      OR inbox_row."envelopeJson"::JSONB #>> '{source,formCode}' IS DISTINCT FROM NEW."formCode"
      OR inbox_row."envelopeJson"::JSONB #>> '{source,formVersion}' IS DISTINCT FROM NEW."formVersion"
      OR inbox_row."occurredAt" IS DISTINCT FROM TO_CHAR(NEW."sourceSubmittedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
      RAISE EXCEPTION 'Privacy evidence business inbox binding denied';
    END IF;
    IF inbox_row."envelopeJson"::JSONB #>> '{privacy,service,purposeCode}' = NEW."purposeCode" THEN
      event_privacy_reference := inbox_row."envelopeJson"::JSONB #> '{privacy,service}';
    ELSIF inbox_row."envelopeJson"::JSONB #>> '{privacy,marketing,purposeCode}' = NEW."purposeCode" THEN
      event_privacy_reference := inbox_row."envelopeJson"::JSONB #> '{privacy,marketing}';
    ELSE
      RAISE EXCEPTION 'Privacy evidence business purpose binding denied';
    END IF;
  END IF;

  SELECT * INTO notice_row FROM "PrivacyNoticeVersion" WHERE "id" = NEW."noticeVersionId" FOR SHARE;
  IF NOT FOUND
    OR notice_row."noticeCode" IS NULL
    OR notice_row."purposeCode" IS DISTINCT FROM NEW."purposeCode"
    OR notice_row."legalBasisCode" IS DISTINCT FROM NEW."legalBasisCode"
    OR notice_row."evidenceKind" IS DISTINCT FROM NEW."evidenceKind"
    OR notice_row."status" <> 'ACTIVE'
    OR notice_row."effectiveFrom" IS NULL
    OR notice_row."effectiveFrom" > NEW."sourceSubmittedAt"
    OR (notice_row."retiredAt" IS NOT NULL AND notice_row."retiredAt" <= NEW."sourceSubmittedAt") THEN
    RAISE EXCEPTION 'Privacy evidence notice binding denied';
  END IF;
  IF NEW."businessInboxEventId" IS NOT NULL AND (
    event_privacy_reference #>> '{noticeCode}' IS DISTINCT FROM notice_row."noticeCode"
    OR event_privacy_reference #>> '{noticeVersion}' IS DISTINCT FROM notice_row."noticeVersion"
    OR event_privacy_reference #>> '{purposeCode}' IS DISTINCT FROM NEW."purposeCode"
    OR event_privacy_reference #>> '{legalBasisCode}' IS DISTINCT FROM NEW."legalBasisCode"
    OR event_privacy_reference #>> '{evidenceKind}' IS DISTINCT FROM NEW."evidenceKind"::TEXT
    OR event_privacy_reference #>> '{decision}' IS DISTINCT FROM NEW."decision"::TEXT
  ) THEN
    RAISE EXCEPTION 'Privacy evidence business contract binding denied';
  END IF;

  IF NEW."websiteLeadReceiptId" IS NOT NULL THEN
    expected_evidence_hash := ENCODE(SHA256(CONVERT_TO("canonicalize_ai_execution_jsonb_v2"(
      JSONB_BUILD_OBJECT(
        'catalogVersion', NEW."catalogVersion", 'decision', NEW."decision"::TEXT,
        'evidenceKind', NEW."evidenceKind"::TEXT, 'formCode', NEW."formCode",
        'formVersion', NEW."formVersion", 'leadId', NEW."leadId",
        'legalBasisCode', NEW."legalBasisCode", 'noticeVersionId', NEW."noticeVersionId"::TEXT,
        'purposeCode', NEW."purposeCode", 'sourceEvidenceDigest', NEW."sourceEvidenceDigest",
        'sourceSubmittedAt', TO_CHAR(NEW."sourceSubmittedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'sourceSystem', NEW."sourceSystem", 'websiteLeadReceiptId', NEW."websiteLeadReceiptId"::TEXT
      )
    ), 'UTF8')), 'hex');
  ELSE
    expected_evidence_hash := ENCODE(SHA256(CONVERT_TO("canonicalize_ai_execution_jsonb_v2"(
      JSONB_BUILD_OBJECT(
        'businessInboxEventId', NEW."businessInboxEventId"::TEXT,
        'catalogVersion', NEW."catalogVersion", 'decision', NEW."decision"::TEXT,
        'domain', 'fai.privacy-evidence.business-inbox.v1',
        'evidenceKind', NEW."evidenceKind"::TEXT, 'formCode', NEW."formCode",
        'formVersion', NEW."formVersion", 'legalBasisCode', NEW."legalBasisCode",
        'noticeVersionId', NEW."noticeVersionId"::TEXT, 'purposeCode', NEW."purposeCode",
        'sourceEvidenceDigest', NEW."sourceEvidenceDigest",
        'sourceSubmittedAt', TO_CHAR(NEW."sourceSubmittedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'sourceSystem', NEW."sourceSystem"
      )
    ), 'UTF8')), 'hex');
  END IF;
  IF NEW."evidenceHash" IS DISTINCT FROM expected_evidence_hash THEN
    RAISE EXCEPTION 'Privacy evidence hash mismatch';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
