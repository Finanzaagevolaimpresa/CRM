BEGIN;

CREATE TYPE "PrivacyNoticeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
CREATE TYPE "PrivacyEvidenceKind" AS ENUM ('NOTICE_ACKNOWLEDGEMENT', 'CONSENT');
CREATE TYPE "PrivacyEvidenceDecision" AS ENUM ('ACKNOWLEDGED', 'GRANTED', 'DENIED');

CREATE TABLE "PrivacyNoticeVersion" (
  "id" UUID NOT NULL,
  "noticeCode" TEXT NOT NULL,
  "noticeVersion" TEXT NOT NULL,
  "purposeCode" TEXT NOT NULL,
  "legalBasisCode" TEXT NOT NULL,
  "evidenceKind" "PrivacyEvidenceKind" NOT NULL,
  "contentHash" TEXT NOT NULL,
  "status" "PrivacyNoticeStatus" NOT NULL DEFAULT 'DRAFT',
  "effectiveFrom" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrivacyNoticeVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivacyNoticeVersion_noticeCode_check" CHECK ("noticeCode" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,119}$'),
  CONSTRAINT "PrivacyNoticeVersion_noticeVersion_check" CHECK ("noticeVersion" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$'),
  CONSTRAINT "PrivacyNoticeVersion_purposeCode_check" CHECK ("purposeCode" ~ '^[A-Z0-9][A-Z0-9_]{0,119}$'),
  CONSTRAINT "PrivacyNoticeVersion_legalBasisCode_check" CHECK ("legalBasisCode" ~ '^[A-Z0-9][A-Z0-9_]{0,119}$'),
  CONSTRAINT "PrivacyNoticeVersion_contentHash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PrivacyNoticeVersion_lifecycle_check" CHECK (
    ("status" = 'DRAFT' AND "effectiveFrom" IS NULL AND "retiredAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "effectiveFrom" IS NOT NULL AND "retiredAt" IS NULL)
    OR ("status" = 'RETIRED' AND "effectiveFrom" IS NOT NULL AND "retiredAt" IS NOT NULL AND "retiredAt" >= "effectiveFrom")
  )
);

CREATE TABLE "PrivacyEvidenceReceipt" (
  "id" UUID NOT NULL,
  "leadId" TEXT NOT NULL,
  "websiteLeadReceiptId" UUID NOT NULL,
  "noticeVersionId" UUID NOT NULL,
  "catalogVersion" TEXT NOT NULL,
  "purposeCode" TEXT NOT NULL,
  "legalBasisCode" TEXT NOT NULL,
  "evidenceKind" "PrivacyEvidenceKind" NOT NULL,
  "decision" "PrivacyEvidenceDecision" NOT NULL,
  "sourceSystem" TEXT NOT NULL,
  "formCode" TEXT NOT NULL,
  "formVersion" TEXT NOT NULL,
  "sourceSubmittedAt" TIMESTAMP(3) NOT NULL,
  "sourceEvidenceDigest" TEXT NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrivacyEvidenceReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivacyEvidenceReceipt_catalogVersion_check" CHECK ("catalogVersion" = 'n04-v1'),
  CONSTRAINT "PrivacyEvidenceReceipt_purposeCode_check" CHECK ("purposeCode" ~ '^[A-Z0-9][A-Z0-9_]{0,119}$'),
  CONSTRAINT "PrivacyEvidenceReceipt_legalBasisCode_check" CHECK ("legalBasisCode" ~ '^[A-Z0-9][A-Z0-9_]{0,119}$'),
  CONSTRAINT "PrivacyEvidenceReceipt_sourceSystem_check" CHECK ("sourceSystem" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,119}$'),
  CONSTRAINT "PrivacyEvidenceReceipt_formCode_check" CHECK ("formCode" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,119}$'),
  CONSTRAINT "PrivacyEvidenceReceipt_formVersion_check" CHECK ("formVersion" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$'),
  CONSTRAINT "PrivacyEvidenceReceipt_sourceEvidenceDigest_check" CHECK ("sourceEvidenceDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PrivacyEvidenceReceipt_evidenceHash_check" CHECK ("evidenceHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PrivacyEvidenceReceipt_decision_check" CHECK (
    ("evidenceKind" = 'NOTICE_ACKNOWLEDGEMENT' AND "decision" = 'ACKNOWLEDGED')
    OR ("evidenceKind" = 'CONSENT' AND "decision" IN ('GRANTED', 'DENIED'))
  ),
  CONSTRAINT "PrivacyEvidenceReceipt_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "PrivacyEvidenceReceipt_websiteLeadReceiptId_fkey" FOREIGN KEY ("websiteLeadReceiptId") REFERENCES "WebsiteLeadReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "PrivacyEvidenceReceipt_noticeVersionId_fkey" FOREIGN KEY ("noticeVersionId") REFERENCES "PrivacyNoticeVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "PrivacyNoticeVersion_identity_key" ON "PrivacyNoticeVersion"("noticeCode", "noticeVersion", "purposeCode");
CREATE INDEX "PrivacyNoticeVersion_active_lookup_idx" ON "PrivacyNoticeVersion"("status", "purposeCode", "effectiveFrom");
CREATE UNIQUE INDEX "PrivacyEvidenceReceipt_evidenceHash_key" ON "PrivacyEvidenceReceipt"("evidenceHash");
CREATE UNIQUE INDEX "PrivacyEvidenceReceipt_source_purpose_key" ON "PrivacyEvidenceReceipt"("websiteLeadReceiptId", "purposeCode");
CREATE INDEX "PrivacyEvidenceReceipt_lead_created_idx" ON "PrivacyEvidenceReceipt"("leadId", "createdAt");
CREATE INDEX "PrivacyEvidenceReceipt_purpose_decision_idx" ON "PrivacyEvidenceReceipt"("purposeCode", "decision", "createdAt");
CREATE INDEX "PrivacyEvidenceReceipt_notice_created_idx" ON "PrivacyEvidenceReceipt"("noticeVersionId", "createdAt");

CREATE FUNCTION "privacy_notice_version_lifecycle_v1"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."effectiveFrom" IS NOT NULL OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Privacy notice versions must start as DRAFT';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Privacy notice versions cannot be deleted';
  END IF;
  IF OLD."noticeCode" IS DISTINCT FROM NEW."noticeCode"
    OR OLD."noticeVersion" IS DISTINCT FROM NEW."noticeVersion"
    OR OLD."purposeCode" IS DISTINCT FROM NEW."purposeCode"
    OR OLD."legalBasisCode" IS DISTINCT FROM NEW."legalBasisCode"
    OR OLD."evidenceKind" IS DISTINCT FROM NEW."evidenceKind"
    OR OLD."contentHash" IS DISTINCT FROM NEW."contentHash"
    OR (OLD."effectiveFrom" IS NOT NULL AND OLD."effectiveFrom" IS DISTINCT FROM NEW."effectiveFrom")
    OR (OLD."retiredAt" IS NOT NULL AND OLD."retiredAt" IS DISTINCT FROM NEW."retiredAt")
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'Privacy notice identity and content are immutable';
  END IF;
  IF NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('DRAFT', 'ACTIVE'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('ACTIVE', 'RETIRED'))
    OR (OLD."status" = 'RETIRED' AND NEW."status" = 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'Privacy notice lifecycle is monotonic';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "PrivacyNoticeVersion_lifecycle_v1"
BEFORE INSERT OR UPDATE OR DELETE ON "PrivacyNoticeVersion"
FOR EACH ROW EXECUTE FUNCTION "privacy_notice_version_lifecycle_v1"();

CREATE FUNCTION "privacy_evidence_receipt_validate_v1"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  notice_row "PrivacyNoticeVersion"%ROWTYPE;
  receipt_payload_hash TEXT;
  expected_evidence_hash TEXT;
BEGIN
  SELECT "payloadHash" INTO receipt_payload_hash
  FROM "WebsiteLeadReceipt"
  WHERE "id" = NEW."websiteLeadReceiptId"
  FOR SHARE;
  IF NOT FOUND OR receipt_payload_hash IS DISTINCT FROM NEW."sourceEvidenceDigest" THEN
    RAISE EXCEPTION 'Privacy evidence source receipt binding denied';
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
  expected_evidence_hash := ENCODE(SHA256(CONVERT_TO("canonicalize_ai_execution_jsonb_v2"(
    JSONB_BUILD_OBJECT(
      'catalogVersion', NEW."catalogVersion",
      'decision', NEW."decision"::TEXT,
      'evidenceKind', NEW."evidenceKind"::TEXT,
      'formCode', NEW."formCode",
      'formVersion', NEW."formVersion",
      'leadId', NEW."leadId",
      'legalBasisCode', NEW."legalBasisCode",
      'noticeVersionId', NEW."noticeVersionId"::TEXT,
      'purposeCode', NEW."purposeCode",
      'sourceEvidenceDigest', NEW."sourceEvidenceDigest",
      'sourceSubmittedAt', TO_CHAR(NEW."sourceSubmittedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'sourceSystem', NEW."sourceSystem",
      'websiteLeadReceiptId', NEW."websiteLeadReceiptId"::TEXT
    )
  ), 'UTF8')), 'hex');
  IF NEW."evidenceHash" IS DISTINCT FROM expected_evidence_hash THEN
    RAISE EXCEPTION 'Privacy evidence hash mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "PrivacyEvidenceReceipt_validate_v1"
BEFORE INSERT ON "PrivacyEvidenceReceipt"
FOR EACH ROW EXECUTE FUNCTION "privacy_evidence_receipt_validate_v1"();

CREATE FUNCTION "privacy_evidence_receipt_append_only_v1"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Privacy evidence receipts are append-only';
END $$;

CREATE TRIGGER "PrivacyEvidenceReceipt_append_only_v1"
BEFORE UPDATE OR DELETE ON "PrivacyEvidenceReceipt"
FOR EACH ROW EXECUTE FUNCTION "privacy_evidence_receipt_append_only_v1"();

CREATE FUNCTION "privacy_registry_deny_truncate_v1"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Privacy notice and evidence registries cannot be truncated';
END $$;

CREATE TRIGGER "PrivacyNoticeVersion_deny_truncate_v1"
BEFORE TRUNCATE ON "PrivacyNoticeVersion"
FOR EACH STATEMENT EXECUTE FUNCTION "privacy_registry_deny_truncate_v1"();

CREATE TRIGGER "PrivacyEvidenceReceipt_deny_truncate_v1"
BEFORE TRUNCATE ON "PrivacyEvidenceReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION "privacy_registry_deny_truncate_v1"();

CREATE FUNCTION "audit_redact_text_n04_v1"(input_text TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT LEFT(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(input_text, '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', '[REDACTED:PERSONAL]', 'gi'),
                  '\m[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\M', '[REDACTED:PERSONAL]', 'gi'
                ),
                '\mIT[0-9]{2}[A-Z][0-9]{10}[0-9A-Z]{12}\M', '[REDACTED:FINANCIAL]', 'gi'
              ),
              '\+[0-9]([[:space:]().-]*[0-9]){7,14}', '[REDACTED:PERSONAL]', 'g'
            ),
            '\m3[0-9]{2}([[:space:]().-]*[0-9]){6,7}\M', '[REDACTED:PERSONAL]', 'g'
          ),
          '\m0[0-9]{1,4}([[:space:]().-]*[0-9]){5,8}\M', '[REDACTED:PERSONAL]', 'g'
        ),
        '\m(phone|telefono|cellulare|password|token|secret|authorization|prompt|instruction)[[:space:]]*[:=][[:space:]]*[^,;[:cntrl:]]+', '[REDACTED:SENSITIVE]', 'gi'
      ),
      '\mbearer[[:space:]]+[A-Za-z0-9._-]{16,}\M|\m[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\M', '[REDACTED:SECRET]', 'gi'
    ),
    4096
  )
$$;

CREATE FUNCTION "audit_sanitize_json_n04_v1"(input_json JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  result JSONB;
BEGIN
  IF input_json IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(input_json)
    WHEN 'object' THEN
      SELECT COALESCE(jsonb_object_agg(entry.key, "audit_sanitize_json_n04_v1"(entry.value)), '{}'::jsonb)
      INTO result
      FROM jsonb_each(input_json) AS entry
      WHERE entry.key !~* '(email|phone|telephone|first.?name|last.?name|display.?name|company.?name|contact.?person|tax.?code|vat.?number|address|city|province|region|description|message|content|prompt|instruction|secret|password|token|authorization|cookie|credential|api.?key|private.?key|storage.?path|file.?name|ip.?address)'
        AND entry.key !~* '(^pec$|pec.?address$|notes?$)'
        AND (
          entry.key ~* '^(before|after|id|receipt|mode|outcome|format|type|role|priority|provider|model|purpose|origin|source|sequence|replay|replayed|reason|action|permission|requiredPermissions|permissionDecisions|dataCategories|changedPaths|contentChanged|sizeBytes|enabled|allowed|confirmed|active|code|version|hash|fingerprint|count|status|state|kind|cycle|key|started|expired|bytes|paths|changed)$'
          OR entry.key ~ '(Id|Code|Version|Hash|Fingerprint|Count|Status|At|Type|Role|Priority|Provider|Model|Purpose|State|Mode|Kind|Sequence|Cycle|Key|Enabled|Allowed|Confirmed|Active|Started|Expired|Replayed|Bytes|Paths|Changed)$'
        );
      RETURN result;
    WHEN 'array' THEN
      SELECT COALESCE(jsonb_agg("audit_sanitize_json_n04_v1"(item.value) ORDER BY item.ordinal), '[]'::jsonb)
      INTO result FROM jsonb_array_elements(input_json) WITH ORDINALITY AS item(value, ordinal)
      WHERE item.ordinal <= 100;
      RETURN result;
    WHEN 'string' THEN
      RETURN to_jsonb("audit_redact_text_n04_v1"(input_json #>> '{}'));
    ELSE
      RETURN input_json;
  END CASE;
END $$;

CREATE FUNCTION "audit_log_redaction_n04_v1"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."before" := "audit_sanitize_json_n04_v1"(NEW."before");
  NEW."after" := "audit_sanitize_json_n04_v1"(NEW."after");
  NEW."ipAddress" := NULL;
  RETURN NEW;
END $$;

CREATE TRIGGER "AuditLog_redaction_n04_v1"
BEFORE INSERT OR UPDATE OF "before", "after", "ipAddress" ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION "audit_log_redaction_n04_v1"();

COMMIT;
