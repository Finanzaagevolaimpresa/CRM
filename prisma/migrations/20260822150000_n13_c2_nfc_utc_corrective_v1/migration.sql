-- N13-C2 NFC identity and UTC privacy-evidence corrective v1.
-- Additive and business-empty: preserves migration 40 and all existing indexes and triggers.

BEGIN;

CREATE INDEX "Lead_active_email_n13_nfc_idx"
  ON "Lead"(LOWER(NORMALIZE(BTRIM("email"), NFC)))
  WHERE "deletedAt" IS NULL AND "email" IS NOT NULL;

CREATE INDEX "Lead_active_person_name_n13_nfc_idx"
  ON "Lead"(
    LOWER(NORMALIZE(
      REGEXP_REPLACE(BTRIM("firstName"), '[[:space:]]+', ' ', 'g'), NFC
    )),
    LOWER(NORMALIZE(
      REGEXP_REPLACE(BTRIM("lastName"), '[[:space:]]+', ' ', 'g'), NFC
    ))
  ) WHERE "deletedAt" IS NULL;

CREATE INDEX "Lead_active_company_name_n13_nfc_idx"
  ON "Lead"(LOWER(NORMALIZE(
    REGEXP_REPLACE(BTRIM("companyName"), '[[:space:]]+', ' ', 'g'), NFC
  )))
  WHERE "deletedAt" IS NULL AND "companyName" IS NOT NULL;

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
      OR inbox_row."occurredAt" IS DISTINCT FROM TO_CHAR(
        NEW."sourceSubmittedAt" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) THEN
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
        'sourceSubmittedAt', TO_CHAR(
          NEW."sourceSubmittedAt" AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
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
        'sourceSubmittedAt', TO_CHAR(
          NEW."sourceSubmittedAt" AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
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
