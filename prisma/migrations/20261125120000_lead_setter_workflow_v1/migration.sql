BEGIN;

ALTER TABLE "Lead" ADD COLUMN "setterNextKind" VARCHAR(12)
  CHECK ("setterNextKind" IN ('CALLBACK','VIDEO'));
ALTER TABLE "InternalSession"
  ADD COLUMN "ordinaryConfirmedAt" TIMESTAMPTZ(3),
  ADD COLUMN "ordinaryLastActiveAt" TIMESTAMPTZ(3),
  ADD COLUMN "ordinaryKeyVersion" INTEGER,
  ADD COLUMN "ordinaryDigest" BYTEA,
  ADD CONSTRAINT "InternalSession_ordinary_window" CHECK (
    num_nonnulls("ordinaryConfirmedAt","ordinaryLastActiveAt","ordinaryKeyVersion","ordinaryDigest") = 0
    OR (num_nonnulls("ordinaryConfirmedAt","ordinaryLastActiveAt","ordinaryKeyVersion","ordinaryDigest") = 4 AND octet_length("ordinaryDigest")=32
      AND "ordinaryLastActiveAt" >= "ordinaryConfirmedAt" AND "ordinaryKeyVersion" > 0));

CREATE TABLE "LeadSetterCall" (
  "id" UUID PRIMARY KEY,
  "leadId" TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "outcome" VARCHAR(20) NOT NULL CHECK ("outcome" IN ('UNREACHABLE','CONTACT','VIDEO_BOOKED','VIDEO_HELD','VIDEO_DEFERRED','VIDEO_ABSENT')),
  "nextKind" VARCHAR(12) CHECK ("nextKind" IN ('CALLBACK','VIDEO')),
  "nextAt" TIMESTAMPTZ(3),
  "details" JSONB NOT NULL CHECK (jsonb_typeof("details")='object'),
  "requestHash" CHAR(64) NOT NULL CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  CHECK (("nextAt" IS NULL) = ("nextKind" IS NULL)),
  CHECK ("outcome" <> 'UNREACHABLE' OR "nextKind" IS NOT DISTINCT FROM 'CALLBACK'),
  CHECK ("outcome" NOT IN ('VIDEO_BOOKED','VIDEO_DEFERRED') OR "nextKind" IS NOT DISTINCT FROM 'VIDEO')
);
CREATE INDEX "LeadSetterCall_leadId_recordedAt_id_idx" ON "LeadSetterCall" ("leadId", "recordedAt" DESC, "id");
CREATE FUNCTION protect_lead_setter_call_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEAD_SETTER_CALL_IMMUTABLE';
END;
$$;
CREATE TRIGGER "LeadSetterCall_immutable" BEFORE UPDATE OR DELETE ON "LeadSetterCall"
  FOR EACH ROW EXECUTE FUNCTION protect_lead_setter_call_history();
COMMIT;
