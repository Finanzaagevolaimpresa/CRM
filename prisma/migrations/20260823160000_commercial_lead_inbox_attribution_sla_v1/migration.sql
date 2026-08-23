BEGIN;

CREATE TABLE "CommercialLeadSlaPolicyVersion" (
  "id" UUID NOT NULL,
  "policyCode" VARCHAR(64) NOT NULL DEFAULT 'COMMERCIAL_FIRST_RESPONSE',
  "version" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'STAGED',
  "calendarCode" VARCHAR(32) NOT NULL DEFAULT 'CONTINUOUS_24X7',
  "timezoneCode" VARCHAR(32) NOT NULL DEFAULT 'UTC',
  "responseTargetSeconds" INTEGER NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialLeadSlaPolicyVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialLeadSlaPolicyVersion_contract_check" CHECK (
    "policyCode" = 'COMMERCIAL_FIRST_RESPONSE'
    AND "version" > 0
    AND "status" IN ('STAGED', 'ACTIVE', 'RETIRED')
    AND "calendarCode" = 'CONTINUOUS_24X7'
    AND "timezoneCode" = 'UTC'
    AND "responseTargetSeconds" BETWEEN 1 AND 31536000
  ),
  CONSTRAINT "CommercialLeadSlaPolicyVersion_createdById_fkey" FOREIGN KEY ("createdById")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CommercialLeadSlaPolicyVersion_identity_key"
  ON "CommercialLeadSlaPolicyVersion"("policyCode", "version");
CREATE UNIQUE INDEX "CommercialLeadSlaPolicyVersion_one_active_key"
  ON "CommercialLeadSlaPolicyVersion"("policyCode") WHERE "status" = 'ACTIVE';
CREATE INDEX "CommercialLeadSlaPolicyVersion_lookup_idx"
  ON "CommercialLeadSlaPolicyVersion"("policyCode", "status", "version");
CREATE INDEX "CommercialLeadSlaPolicyVersion_actor_idx"
  ON "CommercialLeadSlaPolicyVersion"("createdById", "createdAt", "id");

CREATE TABLE "CommercialLeadInboxItem" (
  "id" UUID NOT NULL,
  "leadId" TEXT NOT NULL,
  "originKind" VARCHAR(32) NOT NULL,
  "attributionVersion" VARCHAR(16) NOT NULL DEFAULT 'n14-v1',
  "sourceSystem" VARCHAR(80) NOT NULL,
  "formCode" VARCHAR(80) NOT NULL,
  "formVersion" VARCHAR(40) NOT NULL,
  "sourceOccurredAt" TIMESTAMPTZ(3) NOT NULL,
  "projectionLedgerId" UUID,
  "privacyEvidenceReceiptId" UUID,
  "state" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "initializedAt" TIMESTAMPTZ(3) NOT NULL,
  "closedAt" TIMESTAMPTZ(3),
  "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'COMMERCIAL_LEAD_INBOX',
  "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
  "retentionEligibleAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialLeadInboxItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialLeadInboxItem_contract_check" CHECK (
    "originKind" IN ('MANUAL_CRM', 'WEBSITE_LEGACY_N01', 'BUSINESS_PROJECTION_N13', 'LEGACY_UNVERIFIED')
    AND "attributionVersion" = 'n14-v1'
    AND length("sourceSystem") BETWEEN 1 AND 80
    AND length("formCode") BETWEEN 1 AND 80
    AND length("formVersion") BETWEEN 1 AND 40
    AND "state" IN ('OPEN', 'CLOSED')
    AND "version" > 0
    AND (("state" = 'OPEN' AND "closedAt" IS NULL) OR ("state" = 'CLOSED' AND "closedAt" IS NOT NULL))
    AND "retentionPolicyVersion" = 'N21_UNASSIGNED'
    AND "retentionEligibleAt" IS NULL
    AND (
      ("originKind" IN ('MANUAL_CRM', 'LEGACY_UNVERIFIED') AND "projectionLedgerId" IS NULL AND "privacyEvidenceReceiptId" IS NULL)
      OR ("originKind" = 'BUSINESS_PROJECTION_N13' AND "projectionLedgerId" IS NOT NULL AND "privacyEvidenceReceiptId" IS NULL)
      OR ("originKind" = 'WEBSITE_LEGACY_N01' AND "projectionLedgerId" IS NULL AND "privacyEvidenceReceiptId" IS NOT NULL)
    )
  ),
  CONSTRAINT "CommercialLeadInboxItem_leadId_fkey" FOREIGN KEY ("leadId")
    REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CommercialLeadInboxItem_leadId_key" ON "CommercialLeadInboxItem"("leadId");
CREATE UNIQUE INDEX "CommercialLeadInboxItem_projectionLedgerId_key" ON "CommercialLeadInboxItem"("projectionLedgerId");
CREATE UNIQUE INDEX "CommercialLeadInboxItem_privacyEvidenceReceiptId_key" ON "CommercialLeadInboxItem"("privacyEvidenceReceiptId");
CREATE INDEX "CommercialLeadInboxItem_state_cursor_idx" ON "CommercialLeadInboxItem"("state", "initializedAt", "id");
CREATE INDEX "CommercialLeadInboxItem_state_lead_idx" ON "CommercialLeadInboxItem"("state", "leadId");
CREATE INDEX "CommercialLeadInboxItem_origin_idx" ON "CommercialLeadInboxItem"("originKind", "sourceOccurredAt", "id");
CREATE INDEX "CommercialLeadInboxItem_retention_idx" ON "CommercialLeadInboxItem"("retentionPolicyVersion", "retentionEligibleAt", "id");

CREATE TABLE "CommercialLeadSlaCycle" (
  "id" UUID NOT NULL,
  "inboxItemId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "policyVersionId" UUID NOT NULL,
  "availableAt" TIMESTAMPTZ(3) NOT NULL,
  "dueAt" TIMESTAMPTZ(3) NOT NULL,
  "firstResponseAt" TIMESTAMPTZ(3),
  "closedAt" TIMESTAMPTZ(3),
  "outcome" VARCHAR(32),
  "version" INTEGER NOT NULL DEFAULT 1,
  "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'COMMERCIAL_LEAD_SLA',
  "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
  "retentionEligibleAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialLeadSlaCycle_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialLeadSlaCycle_contract_check" CHECK (
    "sequence" > 0 AND "version" > 0 AND "dueAt" > "availableAt"
    AND ("firstResponseAt" IS NULL OR "firstResponseAt" >= "availableAt")
    AND ("closedAt" IS NULL OR "closedAt" >= "availableAt")
    AND (
      ("outcome" IS NULL AND "firstResponseAt" IS NULL AND "closedAt" IS NULL)
      OR ("outcome" IN ('MET', 'BREACHED') AND "firstResponseAt" IS NOT NULL)
      OR ("outcome" = 'CLOSED_WITHOUT_RESPONSE' AND "firstResponseAt" IS NULL AND "closedAt" IS NOT NULL)
    )
    AND "retentionPolicyVersion" = 'N21_UNASSIGNED'
    AND "retentionEligibleAt" IS NULL
  ),
  CONSTRAINT "CommercialLeadSlaCycle_inboxItemId_fkey" FOREIGN KEY ("inboxItemId")
    REFERENCES "CommercialLeadInboxItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CommercialLeadSlaCycle_policyVersionId_fkey" FOREIGN KEY ("policyVersionId")
    REFERENCES "CommercialLeadSlaPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CommercialLeadSlaCycle_item_sequence_key" ON "CommercialLeadSlaCycle"("inboxItemId", "sequence");
CREATE UNIQUE INDEX "CommercialLeadSlaCycle_one_open_key" ON "CommercialLeadSlaCycle"("inboxItemId") WHERE "closedAt" IS NULL;
CREATE INDEX "CommercialLeadSlaCycle_due_cursor_idx" ON "CommercialLeadSlaCycle"("dueAt", "inboxItemId", "id");
CREATE INDEX "CommercialLeadSlaCycle_outcome_due_idx" ON "CommercialLeadSlaCycle"("outcome", "dueAt", "id");
CREATE INDEX "CommercialLeadSlaCycle_policy_idx" ON "CommercialLeadSlaCycle"("policyVersionId", "createdAt", "id");
CREATE INDEX "CommercialLeadSlaCycle_retention_idx" ON "CommercialLeadSlaCycle"("retentionPolicyVersion", "retentionEligibleAt", "id");

CREATE TABLE "CommercialLeadActivity" (
  "id" UUID NOT NULL,
  "inboxItemId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "activityType" VARCHAR(40) NOT NULL,
  "actorKind" VARCHAR(16) NOT NULL,
  "actorUserId" TEXT,
  "actorSessionId" UUID,
  "assigneeBeforeId" TEXT,
  "assigneeAfterId" TEXT,
  "reasonCode" VARCHAR(64) NOT NULL,
  "inboxVersionBefore" INTEGER NOT NULL,
  "inboxVersionAfter" INTEGER NOT NULL,
  "retentionClass" VARCHAR(64) NOT NULL DEFAULT 'COMMERCIAL_LEAD_ACTIVITY',
  "retentionPolicyVersion" VARCHAR(64) NOT NULL DEFAULT 'N21_UNASSIGNED',
  "retentionEligibleAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialLeadActivity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialLeadActivity_contract_check" CHECK (
    "sequence" > 0
    AND "activityType" IN ('INITIALIZED', 'CLAIMED', 'ASSIGNED', 'UNASSIGNED', 'FIRST_RESPONSE_RECORDED', 'CLOSED', 'REOPENED')
    AND "actorKind" IN ('USER', 'SYSTEM')
    AND (("actorKind" = 'USER' AND "actorUserId" IS NOT NULL AND "actorSessionId" IS NOT NULL)
      OR ("actorKind" = 'SYSTEM' AND "actorUserId" IS NULL AND "actorSessionId" IS NULL))
    AND "reasonCode" IN ('MANUAL_INTAKE', 'PROJECTED_NEW', 'LEGACY_ENROLLMENT', 'SELF_CLAIM', 'MANAGER_ASSIGNMENT', 'MANAGER_UNASSIGNMENT', 'CUSTOMER_CONTACTED', 'QUALIFIED_OUT', 'CONVERTED', 'LOST', 'ARCHIVED', 'REOPENED_FOR_REWORK')
    AND "inboxVersionBefore" >= 0 AND "inboxVersionAfter" > 0
    AND "inboxVersionAfter" - "inboxVersionBefore" BETWEEN 0 AND 1
    AND "retentionPolicyVersion" = 'N21_UNASSIGNED'
    AND "retentionEligibleAt" IS NULL
  ),
  CONSTRAINT "CommercialLeadActivity_inboxItemId_fkey" FOREIGN KEY ("inboxItemId")
    REFERENCES "CommercialLeadInboxItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CommercialLeadActivity_actorUserId_fkey" FOREIGN KEY ("actorUserId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CommercialLeadActivity_actorSessionId_fkey" FOREIGN KEY ("actorSessionId")
    REFERENCES "InternalSession"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CommercialLeadActivity_assigneeBeforeId_fkey" FOREIGN KEY ("assigneeBeforeId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CommercialLeadActivity_assigneeAfterId_fkey" FOREIGN KEY ("assigneeAfterId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CommercialLeadActivity_item_sequence_key" ON "CommercialLeadActivity"("inboxItemId", "sequence");
CREATE INDEX "CommercialLeadActivity_type_idx" ON "CommercialLeadActivity"("activityType", "createdAt", "id");
CREATE INDEX "CommercialLeadActivity_actor_idx" ON "CommercialLeadActivity"("actorUserId", "createdAt", "id");
CREATE INDEX "CommercialLeadActivity_retention_idx" ON "CommercialLeadActivity"("retentionPolicyVersion", "retentionEligibleAt", "id");

CREATE FUNCTION "n14_guard_policy"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'N14_POLICY_DELETE_DENIED'; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."policyCode" IS DISTINCT FROM OLD."policyCode"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."calendarCode" IS DISTINCT FROM OLD."calendarCode"
    OR NEW."timezoneCode" IS DISTINCT FROM OLD."timezoneCode"
    OR NEW."responseTargetSeconds" IS DISTINCT FROM OLD."responseTargetSeconds"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN RAISE EXCEPTION 'N14_POLICY_IMMUTABLE'; END IF;
  IF NOT ((OLD."status" = NEW."status")
    OR (OLD."status" = 'STAGED' AND NEW."status" IN ('ACTIVE', 'RETIRED'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED'))
  THEN RAISE EXCEPTION 'N14_POLICY_TRANSITION_INVALID'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "n14_guard_item"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."originKind" = 'WEBSITE_LEGACY_N01' AND NOT EXISTS (
      SELECT 1 FROM "PrivacyEvidenceReceipt" receipt
      WHERE receipt."id" = NEW."privacyEvidenceReceiptId"
        AND receipt."leadId" = NEW."leadId"
        AND receipt."websiteLeadReceiptId" IS NOT NULL
        AND receipt."purposeCode" = 'SERVICE_REQUEST_FOLLOW_UP'
    ) THEN RAISE EXCEPTION 'N14_WEBSITE_ATTRIBUTION_INVALID'; END IF;
    IF NEW."originKind" = 'BUSINESS_PROJECTION_N13' AND NOT EXISTS (
      SELECT 1 FROM "LeadProjectionLedger" ledger
      JOIN "BusinessInboxEvent" inbox ON inbox."id" = ledger."inboxEventId"
      WHERE ledger."id" = NEW."projectionLedgerId"
        AND ledger."leadId" = NEW."leadId"
        AND ledger."state" IN ('PROJECTED_NEW', 'RESOLVED_NEW')
        AND inbox."schemaVersion" = 'fai.lead-submitted.v1'
    ) THEN RAISE EXCEPTION 'N14_PROJECTION_ATTRIBUTION_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'N14_ITEM_DELETE_DENIED'; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."leadId" IS DISTINCT FROM OLD."leadId"
    OR NEW."originKind" IS DISTINCT FROM OLD."originKind"
    OR NEW."attributionVersion" IS DISTINCT FROM OLD."attributionVersion"
    OR NEW."sourceSystem" IS DISTINCT FROM OLD."sourceSystem"
    OR NEW."formCode" IS DISTINCT FROM OLD."formCode"
    OR NEW."formVersion" IS DISTINCT FROM OLD."formVersion"
    OR NEW."sourceOccurredAt" IS DISTINCT FROM OLD."sourceOccurredAt"
    OR NEW."projectionLedgerId" IS DISTINCT FROM OLD."projectionLedgerId"
    OR NEW."privacyEvidenceReceiptId" IS DISTINCT FROM OLD."privacyEvidenceReceiptId"
    OR NEW."initializedAt" IS DISTINCT FROM OLD."initializedAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN RAISE EXCEPTION 'N14_ATTRIBUTION_IMMUTABLE'; END IF;
  IF NEW."version" <> OLD."version" + 1 THEN RAISE EXCEPTION 'N14_ITEM_VERSION_INVALID'; END IF;
  IF NOT ((OLD."state" = NEW."state")
    OR (OLD."state" = 'OPEN' AND NEW."state" = 'CLOSED')
    OR (OLD."state" = 'CLOSED' AND NEW."state" = 'OPEN'))
  THEN RAISE EXCEPTION 'N14_ITEM_TRANSITION_INVALID'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "n14_guard_cycle"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'N14_CYCLE_DELETE_DENIED'; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."inboxItemId" IS DISTINCT FROM OLD."inboxItemId"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
    OR NEW."policyVersionId" IS DISTINCT FROM OLD."policyVersionId"
    OR NEW."availableAt" IS DISTINCT FROM OLD."availableAt"
    OR NEW."dueAt" IS DISTINCT FROM OLD."dueAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN RAISE EXCEPTION 'N14_CYCLE_IMMUTABLE'; END IF;
  IF NEW."version" <> OLD."version" + 1 THEN RAISE EXCEPTION 'N14_CYCLE_VERSION_INVALID'; END IF;
  IF OLD."firstResponseAt" IS NOT NULL AND NEW."firstResponseAt" IS DISTINCT FROM OLD."firstResponseAt"
    THEN RAISE EXCEPTION 'N14_FIRST_RESPONSE_IMMUTABLE'; END IF;
  IF OLD."closedAt" IS NOT NULL THEN RAISE EXCEPTION 'N14_CYCLE_CLOSED'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "n14_guard_activity_and_truncate"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'N14_TRUNCATE_DENIED'; END IF;
  RAISE EXCEPTION 'N14_ACTIVITY_APPEND_ONLY';
END $$;

CREATE FUNCTION "n14_guard_lead"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE n14_context TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "CommercialLeadInboxItem" WHERE "leadId" = OLD."id") THEN RETURN NEW; END IF;
  IF NEW."source" IS DISTINCT FROM OLD."source" OR NEW."leadSource" IS DISTINCT FROM OLD."leadSource"
    THEN RAISE EXCEPTION 'N14_LEAD_SOURCE_IMMUTABLE'; END IF;
  IF NEW."assignedToId" IS DISTINCT FROM OLD."assignedToId"
    OR (NEW."status" IS DISTINCT FROM OLD."status" AND (NEW."status"::text IN ('cliente_acquisito','vinto','perso','archiviato') OR OLD."status"::text IN ('cliente_acquisito','vinto','perso','archiviato')))
  THEN
    n14_context := current_setting('fai.n14_write_context', true);
    IF n14_context IS DISTINCT FROM 'authorized' THEN RAISE EXCEPTION 'N14_LEAD_WRITER_BYPASS'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CommercialLeadSlaPolicyVersion_guard_row" BEFORE UPDATE OR DELETE ON "CommercialLeadSlaPolicyVersion" FOR EACH ROW EXECUTE FUNCTION "n14_guard_policy"();
CREATE TRIGGER "CommercialLeadSlaPolicyVersion_deny_truncate" BEFORE TRUNCATE ON "CommercialLeadSlaPolicyVersion" FOR EACH STATEMENT EXECUTE FUNCTION "n14_guard_activity_and_truncate"();
CREATE TRIGGER "CommercialLeadInboxItem_guard_row" BEFORE INSERT OR UPDATE OR DELETE ON "CommercialLeadInboxItem" FOR EACH ROW EXECUTE FUNCTION "n14_guard_item"();
CREATE TRIGGER "CommercialLeadInboxItem_deny_truncate" BEFORE TRUNCATE ON "CommercialLeadInboxItem" FOR EACH STATEMENT EXECUTE FUNCTION "n14_guard_activity_and_truncate"();
CREATE TRIGGER "CommercialLeadSlaCycle_guard_row" BEFORE UPDATE OR DELETE ON "CommercialLeadSlaCycle" FOR EACH ROW EXECUTE FUNCTION "n14_guard_cycle"();
CREATE TRIGGER "CommercialLeadSlaCycle_deny_truncate" BEFORE TRUNCATE ON "CommercialLeadSlaCycle" FOR EACH STATEMENT EXECUTE FUNCTION "n14_guard_activity_and_truncate"();
CREATE TRIGGER "CommercialLeadActivity_append_only" BEFORE UPDATE OR DELETE ON "CommercialLeadActivity" FOR EACH ROW EXECUTE FUNCTION "n14_guard_activity_and_truncate"();
CREATE TRIGGER "CommercialLeadActivity_deny_truncate" BEFORE TRUNCATE ON "CommercialLeadActivity" FOR EACH STATEMENT EXECUTE FUNCTION "n14_guard_activity_and_truncate"();
CREATE TRIGGER "Lead_n14_guard_row" BEFORE UPDATE ON "Lead" FOR EACH ROW EXECUTE FUNCTION "n14_guard_lead"();

COMMIT;
