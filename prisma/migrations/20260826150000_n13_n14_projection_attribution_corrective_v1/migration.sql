-- N13/N14 projection attribution corrective v1.
-- Forward-only and business-empty: aligns the canonical N10/N11 schema version and widens
-- N14 provenance columns to the already-published N10 limits without changing existing rows.

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE ONLY "CommercialLeadInboxItem" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  source_contract JSONB;
  migration_42_rows INTEGER;
  contract_constraints INTEGER;
  guard_functions INTEGER;
  guard_triggers INTEGER;
BEGIN
  SELECT JSONB_OBJECT_AGG(
    attribute_row.attname,
    JSONB_BUILD_OBJECT(
      'type', FORMAT_TYPE(attribute_row.atttypid, attribute_row.atttypmod),
      'notNull', attribute_row.attnotnull
    )
  )
  INTO source_contract
  FROM pg_attribute attribute_row
  JOIN pg_class table_row ON table_row.oid = attribute_row.attrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = CURRENT_SCHEMA()
    AND table_row.relname = 'CommercialLeadInboxItem'
    AND attribute_row.attname IN ('sourceSystem', 'formCode', 'formVersion')
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped;

  IF source_contract IS DISTINCT FROM JSONB_BUILD_OBJECT(
    'sourceSystem', JSONB_BUILD_OBJECT('type', 'character varying(80)', 'notNull', TRUE),
    'formCode', JSONB_BUILD_OBJECT('type', 'character varying(80)', 'notNull', TRUE),
    'formVersion', JSONB_BUILD_OBJECT('type', 'character varying(40)', 'notNull', TRUE)
  ) THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_SOURCE_TYPE_DRIFT';
  END IF;

  SELECT COUNT(*) INTO migration_42_rows
  FROM "_prisma_migrations"
  WHERE migration_name = '20260823160000_commercial_lead_inbox_attribution_sla_v1'
    AND checksum = 'fc94e1bf2c659b68baf708d38cf7f3aa4c6b9e653a89330be5ca754bcfeab7aa'
    AND finished_at IS NOT NULL
    AND rolled_back_at IS NULL;

  IF migration_42_rows <> 1 THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_MIGRATION_42_DRIFT';
  END IF;

  SELECT COUNT(*) INTO contract_constraints
  FROM pg_constraint constraint_row
  JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = CURRENT_SCHEMA()
    AND table_row.relname = 'CommercialLeadInboxItem'
    AND constraint_row.conname = 'CommercialLeadInboxItem_contract_check'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  IF contract_constraints <> 1 OR EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = CURRENT_SCHEMA()
      AND table_row.relname = 'CommercialLeadInboxItem'
      AND constraint_row.conname IN (
        'CommercialLeadInboxItem_contract_v42_probe',
        'CommercialLeadInboxItem_contract_v43_probe'
      )
  ) THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_CONSTRAINT_DRIFT';
  END IF;

  SELECT COUNT(*) INTO guard_functions
  FROM pg_proc function_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
  JOIN pg_language language_row ON language_row.oid = function_row.prolang
  WHERE namespace_row.nspname = CURRENT_SCHEMA()
    AND function_row.proname = 'n14_guard_item'
    AND function_row.pronargs = 0
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::REGTYPE
    AND language_row.lanname = 'plpgsql'
    AND ENCODE(SHA256(CONVERT_TO(function_row.prosrc, 'UTF8')), 'hex')
      = 'ec8384f54c0deb94f08e8744b504738a9eb2a43f72577e2447874b98390e52a9';

  IF guard_functions <> 1 THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_GUARD_DRIFT';
  END IF;

  SELECT COUNT(*) INTO guard_triggers
  FROM pg_trigger trigger_row
  JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
  JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
  JOIN pg_namespace function_namespace_row ON function_namespace_row.oid = function_row.pronamespace
  WHERE namespace_row.nspname = CURRENT_SCHEMA()
    AND table_row.relname = 'CommercialLeadInboxItem'
    AND trigger_row.tgname = 'CommercialLeadInboxItem_guard_row'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgenabled = 'O'
    AND trigger_row.tgtype = 31
    AND trigger_row.tgnargs = 0
    AND trigger_row.tgattr = ''::INT2VECTOR
    AND OCTET_LENGTH(trigger_row.tgargs) = 0
    AND trigger_row.tgqual IS NULL
    AND trigger_row.tgconstraint = 0
    AND NOT trigger_row.tgdeferrable
    AND NOT trigger_row.tginitdeferred
    AND trigger_row.tgoldtable IS NULL
    AND trigger_row.tgnewtable IS NULL
    AND trigger_row.tgparentid = 0
    AND function_namespace_row.nspname = CURRENT_SCHEMA()
    AND function_row.proname = 'n14_guard_item'
    AND function_row.pronargs = 0;

  IF guard_triggers <> 1 THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_TRIGGER_DRIFT';
  END IF;
END $$;

-- Compare the parsed v42 CHECK tree rather than a formatting-sensitive deparse.
-- NOT VALID avoids a scan; the ACCESS EXCLUSIVE lock prevents a concurrent write.
ALTER TABLE "CommercialLeadInboxItem"
  ADD CONSTRAINT "CommercialLeadInboxItem_contract_v42_probe" CHECK (
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
  ) NOT VALID;

DO $$
DECLARE
  matching_constraints INTEGER;
BEGIN
  SELECT COUNT(*) INTO matching_constraints
  FROM pg_constraint contract_row
  JOIN pg_constraint probe_row
    ON probe_row.conrelid = contract_row.conrelid
   AND REGEXP_REPLACE(probe_row.conbin::TEXT, ':location -?[0-9]+', ':location', 'g')
     = REGEXP_REPLACE(contract_row.conbin::TEXT, ':location -?[0-9]+', ':location', 'g')
  WHERE contract_row.conrelid = '"CommercialLeadInboxItem"'::REGCLASS
    AND contract_row.conname = 'CommercialLeadInboxItem_contract_check'
    AND contract_row.contype = 'c'
    AND contract_row.convalidated
    AND probe_row.conname = 'CommercialLeadInboxItem_contract_v42_probe'
    AND probe_row.contype = 'c'
    AND NOT probe_row.convalidated;

  IF matching_constraints <> 1 THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_CONSTRAINT_DEFINITION_DRIFT';
  END IF;
END $$;

ALTER TABLE "CommercialLeadInboxItem"
  DROP CONSTRAINT "CommercialLeadInboxItem_contract_v42_probe";

ALTER TABLE "CommercialLeadInboxItem"
  DROP CONSTRAINT "CommercialLeadInboxItem_contract_check";

ALTER TABLE "CommercialLeadInboxItem"
  ALTER COLUMN "sourceSystem" TYPE VARCHAR(120),
  ALTER COLUMN "formCode" TYPE VARCHAR(120),
  ALTER COLUMN "formVersion" TYPE VARCHAR(80);

ALTER TABLE "CommercialLeadInboxItem"
  ADD CONSTRAINT "CommercialLeadInboxItem_contract_check" CHECK (
    "originKind" IN ('MANUAL_CRM', 'WEBSITE_LEGACY_N01', 'BUSINESS_PROJECTION_N13', 'LEGACY_UNVERIFIED')
    AND "attributionVersion" = 'n14-v1'
    AND length("sourceSystem") BETWEEN 1 AND 120
    AND length("formCode") BETWEEN 1 AND 120
    AND length("formVersion") BETWEEN 1 AND 80
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
  ) NOT VALID;

ALTER TABLE "CommercialLeadInboxItem"
  VALIDATE CONSTRAINT "CommercialLeadInboxItem_contract_check";

CREATE OR REPLACE FUNCTION "n14_guard_item"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
        AND inbox."schemaVersion" = 'fai.lead-event.v1'
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

-- Reparse the target CHECK once more so the postcondition verifies its exact tree.
ALTER TABLE "CommercialLeadInboxItem"
  ADD CONSTRAINT "CommercialLeadInboxItem_contract_v43_probe" CHECK (
    "originKind" IN ('MANUAL_CRM', 'WEBSITE_LEGACY_N01', 'BUSINESS_PROJECTION_N13', 'LEGACY_UNVERIFIED')
    AND "attributionVersion" = 'n14-v1'
    AND length("sourceSystem") BETWEEN 1 AND 120
    AND length("formCode") BETWEEN 1 AND 120
    AND length("formVersion") BETWEEN 1 AND 80
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
  ) NOT VALID;

DO $$
DECLARE
  source_contract JSONB;
  migration_42_rows INTEGER;
  matching_constraints INTEGER;
  guard_functions INTEGER;
  guard_triggers INTEGER;
BEGIN
  SELECT JSONB_OBJECT_AGG(
    attribute_row.attname,
    JSONB_BUILD_OBJECT(
      'type', FORMAT_TYPE(attribute_row.atttypid, attribute_row.atttypmod),
      'notNull', attribute_row.attnotnull
    )
  )
  INTO source_contract
  FROM pg_attribute attribute_row
  JOIN pg_class table_row ON table_row.oid = attribute_row.attrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = CURRENT_SCHEMA()
    AND table_row.relname = 'CommercialLeadInboxItem'
    AND attribute_row.attname IN ('sourceSystem', 'formCode', 'formVersion')
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped;

  IF source_contract IS DISTINCT FROM JSONB_BUILD_OBJECT(
    'sourceSystem', JSONB_BUILD_OBJECT('type', 'character varying(120)', 'notNull', TRUE),
    'formCode', JSONB_BUILD_OBJECT('type', 'character varying(120)', 'notNull', TRUE),
    'formVersion', JSONB_BUILD_OBJECT('type', 'character varying(80)', 'notNull', TRUE)
  ) THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_SOURCE_POSTCONDITION_FAILED';
  END IF;

  SELECT COUNT(*) INTO migration_42_rows
  FROM "_prisma_migrations"
  WHERE migration_name = '20260823160000_commercial_lead_inbox_attribution_sla_v1'
    AND checksum = 'fc94e1bf2c659b68baf708d38cf7f3aa4c6b9e653a89330be5ca754bcfeab7aa'
    AND finished_at IS NOT NULL
    AND rolled_back_at IS NULL;

  IF migration_42_rows <> 1 THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_MIGRATION_42_POSTCONDITION_FAILED';
  END IF;

  SELECT COUNT(*) INTO matching_constraints
  FROM pg_constraint contract_row
  JOIN pg_constraint probe_row
    ON probe_row.conrelid = contract_row.conrelid
   AND REGEXP_REPLACE(probe_row.conbin::TEXT, ':location -?[0-9]+', ':location', 'g')
     = REGEXP_REPLACE(contract_row.conbin::TEXT, ':location -?[0-9]+', ':location', 'g')
  WHERE contract_row.conrelid = '"CommercialLeadInboxItem"'::REGCLASS
    AND contract_row.conname = 'CommercialLeadInboxItem_contract_check'
    AND contract_row.contype = 'c'
    AND contract_row.convalidated
    AND probe_row.conname = 'CommercialLeadInboxItem_contract_v43_probe'
    AND probe_row.contype = 'c'
    AND NOT probe_row.convalidated;

  IF matching_constraints <> 1 THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_CONSTRAINT_POSTCONDITION_FAILED';
  END IF;

  SELECT COUNT(*) INTO guard_functions
  FROM pg_proc function_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
  JOIN pg_language language_row ON language_row.oid = function_row.prolang
  WHERE namespace_row.nspname = CURRENT_SCHEMA()
    AND function_row.proname = 'n14_guard_item'
    AND function_row.pronargs = 0
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::REGTYPE
    AND language_row.lanname = 'plpgsql'
    AND ENCODE(SHA256(CONVERT_TO(function_row.prosrc, 'UTF8')), 'hex')
      = 'a581369986e132bdc7de8698d6cd18047b6cb1e8867c12182ed8c46eeaefc743';

  IF guard_functions <> 1 THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_GUARD_POSTCONDITION_FAILED';
  END IF;

  SELECT COUNT(*) INTO guard_triggers
  FROM pg_trigger trigger_row
  JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
  JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
  JOIN pg_namespace function_namespace_row ON function_namespace_row.oid = function_row.pronamespace
  WHERE namespace_row.nspname = CURRENT_SCHEMA()
    AND table_row.relname = 'CommercialLeadInboxItem'
    AND trigger_row.tgname = 'CommercialLeadInboxItem_guard_row'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgenabled = 'O'
    AND trigger_row.tgtype = 31
    AND trigger_row.tgnargs = 0
    AND trigger_row.tgattr = ''::INT2VECTOR
    AND OCTET_LENGTH(trigger_row.tgargs) = 0
    AND trigger_row.tgqual IS NULL
    AND trigger_row.tgconstraint = 0
    AND NOT trigger_row.tgdeferrable
    AND NOT trigger_row.tginitdeferred
    AND trigger_row.tgoldtable IS NULL
    AND trigger_row.tgnewtable IS NULL
    AND trigger_row.tgparentid = 0
    AND function_namespace_row.nspname = CURRENT_SCHEMA()
    AND function_row.proname = 'n14_guard_item'
    AND function_row.pronargs = 0;

  IF guard_triggers <> 1 THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_TRIGGER_POSTCONDITION_FAILED';
  END IF;
END $$;

ALTER TABLE "CommercialLeadInboxItem"
  DROP CONSTRAINT "CommercialLeadInboxItem_contract_v43_probe";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = '"CommercialLeadInboxItem"'::REGCLASS
      AND constraint_row.conname IN (
        'CommercialLeadInboxItem_contract_v42_probe',
        'CommercialLeadInboxItem_contract_v43_probe'
      )
  ) THEN
    RAISE EXCEPTION 'N13_N14_ATTRIBUTION_PROBE_CLEANUP_FAILED';
  END IF;
END $$;

COMMIT;
