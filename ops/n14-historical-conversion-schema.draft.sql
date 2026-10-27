-- Isolated candidate only. Outside Prisma migrations; no production execution.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'fai_crm_test' OR NOT EXISTS (
    SELECT 1 FROM pg_database WHERE datname=current_database()
      AND shobj_description(oid,'pg_database')='FAI_CRM_EPHEMERAL_TEST_ONLY_V1'
  ) THEN RAISE EXCEPTION 'N14_HISTORICAL_SYNTHETIC_DATABASE_REQUIRED'; END IF;
END $$;

-- Retain every existing temporal and retention constraint. The additional
-- closed outcome is bound to an immutable conversion below; firstResponseAt
-- stays NULL rather than manufacturing a CRM response or a fulfilled SLA.
ALTER TABLE "CommercialLeadSlaCycle" DROP CONSTRAINT "CommercialLeadSlaCycle_contract_check";
ALTER TABLE "CommercialLeadSlaCycle" ADD CONSTRAINT "CommercialLeadSlaCycle_contract_check" CHECK (
  sequence > 0 AND version > 0 AND "dueAt" > "availableAt"
  AND ("firstResponseAt" IS NULL OR "firstResponseAt" >= "availableAt")
  AND ("closedAt" IS NULL OR "closedAt" >= "availableAt")
  AND (
    (outcome IS NULL AND "firstResponseAt" IS NULL AND "closedAt" IS NULL)
    OR (outcome IN ('MET','BREACHED') AND "firstResponseAt" IS NOT NULL)
    OR (outcome = 'CLOSED_WITHOUT_RESPONSE' AND "firstResponseAt" IS NULL AND "closedAt" IS NOT NULL)
    OR (outcome = 'HISTORICAL_CONTACT_BEFORE_CRM' AND "firstResponseAt" IS NULL AND "closedAt" IS NOT NULL AND sequence=1)
  )
  AND "retentionPolicyVersion"='N21_UNASSIGNED' AND "retentionEligibleAt" IS NULL
);

CREATE TABLE "CommercialLeadHistoricalConversion" (
  id UUID PRIMARY KEY,
  input JSONB NOT NULL,
  "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sessionId" UUID NOT NULL REFERENCES "InternalSession"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "inboxItemId" UUID NOT NULL UNIQUE REFERENCES "CommercialLeadInboxItem"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "cycleId" UUID NOT NULL UNIQUE REFERENCES "CommercialLeadSlaCycle"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "contactId" UUID NOT NULL UNIQUE REFERENCES "CommercialLeadHistoricalContact"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "clientId" TEXT NOT NULL UNIQUE REFERENCES "Client"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL,
  "inboxVersionBefore" INTEGER NOT NULL CHECK ("inboxVersionBefore">1),
  "inboxVersionAfter" INTEGER NOT NULL CHECK ("inboxVersionAfter"="inboxVersionBefore"+1),
  "payloadHash" CHAR(64) NOT NULL CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  "auditId" TEXT NOT NULL UNIQUE REFERENCES "AuditLog"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  CHECK (jsonb_typeof(input)='object' AND input->>'protocol'='N14_HISTORICAL_CONVERSION_V1'
    AND input->>'commandId'=id::text AND input->>'contactId'="contactId"::text
    AND (input->>'expectedInboxVersion')::integer="inboxVersionBefore")
);
CREATE TRIGGER "CommercialLeadHistoricalConversion_immutable" BEFORE UPDATE OR DELETE
  ON "CommercialLeadHistoricalConversion" FOR EACH ROW EXECUTE FUNCTION n14_historical_contact_immutable();
CREATE TRIGGER "CommercialLeadHistoricalConversion_no_truncate" BEFORE TRUNCATE
  ON "CommercialLeadHistoricalConversion" FOR EACH STATEMENT EXECUTE FUNCTION n14_historical_contact_immutable();

CREATE FUNCTION n14_historical_conversion_journal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE expected_audit JSONB;
BEGIN
  IF NEW."transactionId"<>txid_current()
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.input))<>7
    OR NOT NEW.input ?& ARRAY['protocol','commandId','leadId','expectedInboxVersion','expectedAssignmentId','contactId','clientType']
  THEN RAISE EXCEPTION 'N14_HISTORICAL_CONVERSION_CONTRACT_INVALID'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "CommercialLeadHistoricalContact" h
    JOIN "CommercialLeadInboxItem" i ON i.id=h."inboxItemId"
    JOIN "CommercialLeadSlaCycle" s ON s.id=h."cycleId"
    JOIN "Lead" l ON l.id=i."leadId"
    JOIN "Client" c ON c.id=l."clientId"
    WHERE h.id=NEW."contactId" AND h."actorId"=NEW."actorId"
      AND h."assignmentId"=NEW.input->>'expectedAssignmentId'
      AND h."recordedAt"<=NEW."recordedAt" AND h."inboxVersionAfter"<=NEW."inboxVersionBefore"
      AND i.id=NEW."inboxItemId" AND i."originKind"='MANUAL_CRM' AND i.state='CLOSED'
      AND i.version=NEW."inboxVersionAfter" AND i."closedAt"=NEW."recordedAt"
      AND s.id=NEW."cycleId" AND s.sequence=1 AND s."firstResponseAt" IS NULL
      AND s.outcome='HISTORICAL_CONTACT_BEFORE_CRM' AND s."closedAt"=NEW."recordedAt"
      AND l.id=NEW.input->>'leadId' AND l."deletedAt" IS NULL AND l.status='vinto' AND l."assignedToId"=NEW."actorId"
      AND c.id=NEW."clientId" AND c."leadId"=l.id AND c."salesOwnerId"=NEW."actorId"
      AND c.type::text=NEW.input->>'clientType' AND c."deletedAt" IS NULL
      AND c.xmin::text::bigint=(txid_current()%4294967296)
      AND l.xmin::text::bigint=(txid_current()%4294967296)
      AND s.xmin::text::bigint=(txid_current()%4294967296)
  ) THEN RAISE EXCEPTION 'N14_HISTORICAL_CONVERSION_SCOPE_INVALID'; END IF;
  expected_audit := jsonb_build_object('type','N14_HISTORICAL_CONVERSION_V1','recordId',NEW.id::text,
    'beforeVersion',NEW."inboxVersionBefore",'afterVersion',NEW."inboxVersionAfter",'outcome','HISTORICAL_CONTACT_BEFORE_CRM');
  IF NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a.id=NEW."auditId" AND a."actorId"=NEW."actorId"
    AND a."entityType"='CommercialLeadInboxItem' AND a."entityId"=NEW."inboxItemId"::text
    AND a.event='commercial_lead_historical_conversion_recorded' AND a.after=expected_audit
    AND a.xmin::text::bigint=(txid_current()%4294967296)
  ) THEN RAISE EXCEPTION 'N14_HISTORICAL_CONVERSION_AUDIT_INVALID'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "CommercialLeadHistoricalConversion_journal" AFTER INSERT
  ON "CommercialLeadHistoricalConversion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION n14_historical_conversion_journal();

CREATE FUNCTION n14_historical_cycle_basis() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "CommercialLeadHistoricalConversion" c
    WHERE c."cycleId"=NEW.id AND c."inboxItemId"=NEW."inboxItemId"
      AND c."recordedAt"=NEW."closedAt" AND c."transactionId"=txid_current())
  THEN RAISE EXCEPTION 'N14_HISTORICAL_CONVERSION_RECEIPT_REQUIRED'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "CommercialLeadSlaCycle_historical_basis" AFTER INSERT OR UPDATE
  ON "CommercialLeadSlaCycle" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.outcome='HISTORICAL_CONTACT_BEFORE_CRM') EXECUTE FUNCTION n14_historical_cycle_basis();
COMMIT;
