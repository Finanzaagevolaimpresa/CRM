-- Isolated persistence preparation only. Not a production migration and not in
-- the Prisma migration chain. No live SLA outcome or firstResponseAt is changed.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'fai_crm_test' OR NOT EXISTS (
    SELECT 1 FROM pg_database WHERE datname=current_database()
      AND shobj_description(oid,'pg_database')='FAI_CRM_EPHEMERAL_TEST_ONLY_V1'
  ) THEN RAISE EXCEPTION 'N14_HISTORICAL_SYNTHETIC_DATABASE_REQUIRED'; END IF;
END $$;

CREATE TABLE "CommercialLeadHistoricalContact" (
  id UUID PRIMARY KEY,
  input JSONB NOT NULL,
  "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sessionId" UUID NOT NULL REFERENCES "InternalSession"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "inboxItemId" UUID NOT NULL REFERENCES "CommercialLeadInboxItem"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "cycleId" UUID NOT NULL REFERENCES "CommercialLeadSlaCycle"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "assignmentId" TEXT NOT NULL REFERENCES "AuditLog"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL,
  "inboxVersionBefore" INTEGER NOT NULL CHECK ("inboxVersionBefore" > 0),
  "inboxVersionAfter" INTEGER NOT NULL CHECK ("inboxVersionAfter" = "inboxVersionBefore" + 1),
  "payloadHash" CHAR(64) NOT NULL CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  "auditId" TEXT NOT NULL UNIQUE REFERENCES "AuditLog"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  UNIQUE ("inboxItemId","assignmentId"),
  CHECK (jsonb_typeof(input)='object'
    AND input->>'protocol'='N14_HISTORICAL_CONTACT_V1'
    AND input->>'commandId'=id::text
    AND input->>'expectedAssignmentId'="assignmentId"
    AND (input->>'expectedInboxVersion')::integer="inboxVersionBefore"
    AND input->'attested'='true'::jsonb
    AND input->>'source' IN ('EMAIL','PHONE','MEETING','EXISTING_DOCUMENT')
    AND length(input->>'evidenceReference') BETWEEN 3 AND 500)
);
CREATE INDEX "CommercialLeadHistoricalContact_actor_idx" ON "CommercialLeadHistoricalContact"("actorId","recordedAt",id);

CREATE FUNCTION n14_historical_contact_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'N14_HISTORICAL_CONTACT_APPEND_ONLY'; END $$;
CREATE TRIGGER "CommercialLeadHistoricalContact_immutable" BEFORE UPDATE OR DELETE
  ON "CommercialLeadHistoricalContact" FOR EACH ROW EXECUTE FUNCTION n14_historical_contact_immutable();
CREATE TRIGGER "CommercialLeadHistoricalContact_no_truncate" BEFORE TRUNCATE
  ON "CommercialLeadHistoricalContact" FOR EACH STATEMENT EXECUTE FUNCTION n14_historical_contact_immutable();

-- Deferred linkage ensures the command, item version and minimized audit are
-- from this transaction. No repair, backfill, external call or cascading delete.
CREATE FUNCTION n14_historical_contact_journal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE expected_audit JSONB;
BEGIN
  IF NEW."transactionId" <> txid_current()
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.input)) <> 9
    OR NOT NEW.input ?& ARRAY['protocol','commandId','leadId','expectedInboxVersion','expectedAssignmentId','occurredAt','source','evidenceReference','attested']
  THEN RAISE EXCEPTION 'N14_HISTORICAL_CONTACT_CONTRACT_INVALID'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "CommercialLeadInboxItem" i
    JOIN "Lead" l ON l.id=i."leadId"
    JOIN "CommercialLeadSlaCycle" c ON c."inboxItemId"=i.id
    WHERE i.id=NEW."inboxItemId" AND l.id=NEW.input->>'leadId'
      AND i."originKind"='MANUAL_CRM' AND i.state='OPEN' AND i.version=NEW."inboxVersionAfter"
      AND l."deletedAt" IS NULL AND l."clientId" IS NULL AND l."assignedToId"=NEW."actorId"
      AND c.id=NEW."cycleId" AND c.sequence=1 AND c."closedAt" IS NULL AND c."firstResponseAt" IS NULL
      AND (NEW.input->>'occurredAt')::timestamptz < i."initializedAt"
      AND i."initializedAt" <= NEW."recordedAt" AND NEW."recordedAt" <= clock_timestamp()
  ) THEN RAISE EXCEPTION 'N14_HISTORICAL_CONTACT_SCOPE_INVALID'; END IF;
  expected_audit := jsonb_build_object('protocol','N14_HISTORICAL_CONTACT_V1','recordId',NEW.id::text,
    'inboxVersionBefore',NEW."inboxVersionBefore",'inboxVersionAfter',NEW."inboxVersionAfter",'slaEffect','NO_REWRITE');
  IF NOT EXISTS (
    SELECT 1 FROM "AuditLog" a WHERE a.id=NEW."auditId" AND a."actorId"=NEW."actorId"
      AND a."entityType"='CommercialLeadInboxItem' AND a."entityId"=NEW."inboxItemId"::text
      AND a.event='commercial_lead_historical_contact_recorded' AND a.after=expected_audit
      AND a.xmin::text::bigint = (txid_current() % 4294967296)
  ) THEN RAISE EXCEPTION 'N14_HISTORICAL_CONTACT_AUDIT_INVALID'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "CommercialLeadHistoricalContact_journal" AFTER INSERT
  ON "CommercialLeadHistoricalContact" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION n14_historical_contact_journal();
COMMIT;
