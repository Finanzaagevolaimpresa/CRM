-- N15 dedicated dormant persistence. Additive, transactional and business-data empty.
BEGIN;

CREATE TABLE "CommunicationIntentRecord" (
  "id" UUID NOT NULL,
  "intentId" UUID NOT NULL,
  "producerCode" VARCHAR(120) NOT NULL,
  "keyDigest" CHAR(64) NOT NULL,
  "semanticHash" CHAR(64) NOT NULL,
  "envelopeHash" CHAR(64) NOT NULL,
  "canonicalEnvelope" TEXT NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'RECORDED',
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommunicationIntentRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommunicationIntentRecord_state_check" CHECK ("state" = 'RECORDED'),
  CONSTRAINT "CommunicationIntentRecord_hashes_check" CHECK ("keyDigest" ~ '^[0-9a-f]{64}$' AND "semanticHash" ~ '^[0-9a-f]{64}$' AND "envelopeHash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "CommunicationIntentRecord_intentId_key" ON "CommunicationIntentRecord"("intentId");
CREATE UNIQUE INDEX "CommunicationIntentRecord_keyDigest_key" ON "CommunicationIntentRecord"("keyDigest");
CREATE INDEX "CommunicationIntentRecord_producer_idx" ON "CommunicationIntentRecord"("producerCode", "createdAt", "id");

CREATE TABLE "CommunicationHeldDecision" (
  "id" UUID NOT NULL,
  "intentRecordId" UUID NOT NULL,
  "decisionHash" CHAR(64) NOT NULL,
  "canonicalDecision" TEXT NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'HELD',
  "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommunicationHeldDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommunicationHeldDecision_state_check" CHECK ("state" = 'HELD'),
  CONSTRAINT "CommunicationHeldDecision_hash_check" CHECK ("decisionHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CommunicationHeldDecision_intentRecordId_fkey" FOREIGN KEY ("intentRecordId") REFERENCES "CommunicationIntentRecord"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "CommunicationHeldDecision_intentRecordId_key" ON "CommunicationHeldDecision"("intentRecordId");

CREATE TABLE "CommunicationIntentAudit" (
  "id" UUID NOT NULL,
  "intentRecordId" UUID NOT NULL,
  "recordHash" CHAR(64) NOT NULL,
  "canonicalAudit" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommunicationIntentAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommunicationIntentAudit_hash_check" CHECK ("recordHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CommunicationIntentAudit_intentRecordId_fkey" FOREIGN KEY ("intentRecordId") REFERENCES "CommunicationIntentRecord"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "CommunicationIntentAudit_intentRecordId_key" ON "CommunicationIntentAudit"("intentRecordId");

CREATE FUNCTION "N15_communication_aggregate_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'N15_COMMUNICATION_AGGREGATE_APPEND_ONLY' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CommunicationIntentRecord_append_only"
BEFORE UPDATE OR DELETE ON "CommunicationIntentRecord"
FOR EACH ROW EXECUTE FUNCTION "N15_communication_aggregate_append_only"();
CREATE TRIGGER "CommunicationHeldDecision_append_only"
BEFORE UPDATE OR DELETE ON "CommunicationHeldDecision"
FOR EACH ROW EXECUTE FUNCTION "N15_communication_aggregate_append_only"();
CREATE TRIGGER "CommunicationIntentAudit_append_only"
BEFORE UPDATE OR DELETE ON "CommunicationIntentAudit"
FOR EACH ROW EXECUTE FUNCTION "N15_communication_aggregate_append_only"();

COMMIT;
