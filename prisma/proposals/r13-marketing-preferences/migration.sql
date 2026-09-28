-- PROPOSAL ONLY. Outside prisma/migrations deliberately: do not deploy automatically.
-- Requires schema49 / immutable N04 receipts. Empty tables; no policy, key or epoch is provisioned.
BEGIN;

CREATE TABLE "MarketingPreferenceEpoch" (
  "singleton" BOOLEAN PRIMARY KEY DEFAULT true CHECK ("singleton" = true),
  "epoch" UUID NOT NULL,
  "reconciled" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE "MarketingPreferenceSubject" (
  "contactKey" TEXT PRIMARY KEY CHECK ("contactKey" ~ '^r13-email-v1:[0-9a-f]{64}$'),
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "quarantined" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE "MarketingPreferenceEvent" (
  "contactKey" TEXT NOT NULL REFERENCES "MarketingPreferenceSubject"("contactKey") ON UPDATE RESTRICT ON DELETE RESTRICT,
  "eventId" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "eventHash" TEXT NOT NULL CHECK ("eventHash" ~ '^[0-9a-f]{64}$'),
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "receiptId" UUID GENERATED ALWAYS AS (("payload"->>'receiptId')::UUID) STORED UNIQUE
    REFERENCES "PrivacyEvidenceReceipt"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  "noticeVersionId" UUID GENERATED ALWAYS AS (("payload"->>'noticeVersionId')::UUID) STORED
    REFERENCES "PrivacyNoticeVersion"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  PRIMARY KEY ("contactKey", "eventId"),
  CHECK (jsonb_typeof("payload") = 'object'),
  CHECK ("payload" ?& ARRAY['eventId','contactKey','kind','occurredAt','source','operatorRef','outcome',
    'receiptId','noticeVersionId','noticeHash','canonicalNoticeText']),
  CHECK ("payload" - ARRAY['eventId','contactKey','kind','occurredAt','source','operatorRef','outcome',
    'receiptId','noticeVersionId','noticeHash','canonicalNoticeText'] = '{}'::JSONB)
);

CREATE FUNCTION "marketing_preference_event_validate_r13"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  data JSONB := NEW."payload";
  kind TEXT := data->>'kind';
  receipt "PrivacyEvidenceReceipt"%ROWTYPE;
  notice "PrivacyNoticeVersion"%ROWTYPE;
  occurred TIMESTAMPTZ;
BEGIN
  NEW."recordedAt" := date_trunc('milliseconds', clock_timestamp());
  IF data->>'contactKey' IS DISTINCT FROM NEW."contactKey"
    OR data->>'eventId' IS DISTINCT FROM NEW."eventId"::TEXT
    OR data->>'outcome' IS DISTINCT FROM CASE WHEN kind = 'GRANTED' THEN 'CONSENT_RECORDED' ELSE 'PROMOTIONAL_BLOCKED' END
    OR kind IS NULL OR kind NOT IN ('GRANTED','DENIED','WITHDRAWN','SUPPRESSED','PURPOSE_CLOSED') THEN
    RAISE EXCEPTION 'MARKETING_EVENT_INVALID';
  END IF;
  occurred := (data->>'occurredAt')::TIMESTAMPTZ;
  IF occurred IS NULL OR occurred > clock_timestamp()
    OR to_char(occurred AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM data->>'occurredAt' THEN
    RAISE EXCEPTION 'MARKETING_EVENT_TIME_INVALID';
  END IF;
  IF NEW."eventHash" IS DISTINCT FROM encode(sha256(convert_to("canonicalize_ai_execution_jsonb_v2"(
      jsonb_build_object('domain', 'fai.marketing-preference.r13.v1') || data), 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'MARKETING_EVENT_HASH_INVALID';
  END IF;
  IF kind IN ('GRANTED','DENIED') THEN
    SELECT * INTO receipt FROM "PrivacyEvidenceReceipt" WHERE "id" = (data->>'receiptId')::UUID FOR SHARE;
    IF NOT FOUND OR receipt."businessInboxEventId" IS NULL OR receipt."decision"::TEXT IS DISTINCT FROM kind
      OR receipt."purposeCode" <> 'DIRECT_MARKETING' OR receipt."legalBasisCode" <> 'CONSENT'
      OR receipt."evidenceKind"::TEXT <> 'CONSENT' OR receipt."sourceSubmittedAt" IS DISTINCT FROM occurred
      OR receipt."noticeVersionId"::TEXT IS DISTINCT FROM data->>'noticeVersionId' THEN
      RAISE EXCEPTION 'MARKETING_RECEIPT_BINDING_INVALID';
    END IF;
    SELECT * INTO notice FROM "PrivacyNoticeVersion" WHERE "id" = receipt."noticeVersionId" FOR SHARE;
    IF NOT FOUND OR data->>'source' IS DISTINCT FROM 'Q05_RECEIPT' OR data->'operatorRef' <> 'null'::JSONB
      OR jsonb_typeof(data->'canonicalNoticeText') IS DISTINCT FROM 'string'
      OR length(data->>'canonicalNoticeText') NOT BETWEEN 1 AND 200000
      OR notice."contentHash" IS DISTINCT FROM data->>'noticeHash'
      OR notice."contentHash" IS DISTINCT FROM encode(sha256(convert_to(data->>'canonicalNoticeText', 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'MARKETING_NOTICE_BINDING_INVALID';
    END IF;
  ELSE
    IF data->'receiptId' <> 'null'::JSONB OR data->'noticeVersionId' <> 'null'::JSONB
      OR data->'canonicalNoticeText' <> 'null'::JSONB OR data->'noticeHash' <> 'null'::JSONB
      OR ((
        (kind = 'SUPPRESSED' AND data->>'source' = 'PUBLIC_REQUEST' AND data->'operatorRef' = 'null'::JSONB)
        OR (kind = 'WITHDRAWN' AND data->>'source' = 'AUTHORIZED_OPERATOR'
          AND coalesce(data->>'operatorRef','') ~ '^[a-zA-Z0-9_-]{1,120}$')
        OR (kind = 'PURPOSE_CLOSED' AND data->>'source' = 'PURPOSE_POLICY'
          AND coalesce(data->>'operatorRef','') ~ '^[a-zA-Z0-9_-]{1,120}$')
      ) IS NOT TRUE) THEN
      RAISE EXCEPTION 'MARKETING_BLOCK_INVALID';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "marketing_preference_event_advance_r13"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "MarketingPreferenceSubject" SET "revision" = "revision" + 1 WHERE "contactKey" = NEW."contactKey";
  RETURN NEW;
END $$;

CREATE FUNCTION "marketing_preference_subject_guard_r13"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 0 OR NEW."quarantined" THEN RAISE EXCEPTION 'MARKETING_INITIAL_STATE_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'MARKETING_SUBJECT_REMOVAL_DENIED'; END IF;
  IF OLD."contactKey" IS DISTINCT FROM NEW."contactKey" OR (OLD."quarantined" AND NOT NEW."quarantined")
    OR (OLD."revision" IS DISTINCT FROM NEW."revision" AND (pg_trigger_depth() < 2 OR NEW."revision" <> OLD."revision" + 1)) THEN
    RAISE EXCEPTION 'MARKETING_SUBJECT_MUTATION_DENIED';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "MarketingPreferenceSubject_guard_r13" BEFORE INSERT OR UPDATE OR DELETE ON "MarketingPreferenceSubject"
  FOR EACH ROW EXECUTE FUNCTION "marketing_preference_subject_guard_r13"();
CREATE TRIGGER "MarketingPreferenceEvent_validate_r13" BEFORE INSERT ON "MarketingPreferenceEvent"
  FOR EACH ROW EXECUTE FUNCTION "marketing_preference_event_validate_r13"();
CREATE TRIGGER "MarketingPreferenceEvent_advance_r13" AFTER INSERT ON "MarketingPreferenceEvent"
  FOR EACH ROW EXECUTE FUNCTION "marketing_preference_event_advance_r13"();
CREATE TRIGGER "MarketingPreferenceEvent_append_only_r13" BEFORE UPDATE OR DELETE ON "MarketingPreferenceEvent"
  FOR EACH ROW EXECUTE FUNCTION "privacy_evidence_receipt_append_only_v1"();
CREATE TRIGGER "MarketingPreferenceEvent_no_truncate_r13" BEFORE TRUNCATE ON "MarketingPreferenceEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "privacy_registry_deny_truncate_v1"();
CREATE TRIGGER "MarketingPreferenceSubject_no_truncate_r13" BEFORE TRUNCATE ON "MarketingPreferenceSubject"
  FOR EACH STATEMENT EXECUTE FUNCTION "privacy_registry_deny_truncate_v1"();

COMMIT;
