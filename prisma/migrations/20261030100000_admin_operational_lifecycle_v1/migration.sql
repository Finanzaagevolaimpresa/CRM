BEGIN;

-- No historic source, signature, receipt, approval, payment or personal start is rewritten.
CREATE TABLE "AdminOperationalState" (
  "model" VARCHAR(64) NOT NULL,
  "recordId" VARCHAR(128) NOT NULL,
  "state" VARCHAR(12) NOT NULL,
  "version" INTEGER NOT NULL,
  "lastCommandId" UUID NOT NULL,
  "controlledIntakeId" UUID,
  "readinessId" UUID,
  "messageId" UUID,
  "replyId" UUID,
  "documentId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  CONSTRAINT "AdminOperationalState_pkey" PRIMARY KEY ("model","recordId"),
  CONSTRAINT "AdminOperationalState_state_check" CHECK ("state" IN ('ACTIVE','BLOCKED','ARCHIVED','TRASHED') AND "version">0),
  CONSTRAINT "AdminOperationalState_target_check" CHECK (
    num_nonnulls("controlledIntakeId","readinessId","messageId","replyId","documentId")=1 AND
    CASE "model"
      WHEN 'ControlledIntake' THEN "controlledIntakeId" IS NOT NULL AND "recordId"="controlledIntakeId"::text
      WHEN 'PracticeReadiness' THEN "readinessId" IS NOT NULL AND "recordId"="readinessId"::text
      WHEN 'ApprovedCommunication' THEN "messageId" IS NOT NULL AND "recordId"="messageId"::text
      WHEN 'CommunicationReply' THEN "replyId" IS NOT NULL AND "recordId"="replyId"::text
      WHEN 'Document' THEN "documentId" IS NOT NULL AND "recordId"="documentId"
      ELSE false END),
  CONSTRAINT "AdminOperationalState_controlledIntakeId_fkey" FOREIGN KEY ("controlledIntakeId") REFERENCES "ControlledIntake"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AdminOperationalState_readinessId_fkey" FOREIGN KEY ("readinessId") REFERENCES "PracticeReadiness"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AdminOperationalState_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ApprovedCommunication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AdminOperationalState_replyId_fkey" FOREIGN KEY ("replyId") REFERENCES "CommunicationReply"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AdminOperationalState_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AdminOperationalState_lastCommandId_fkey" FOREIGN KEY ("lastCommandId") REFERENCES "AdminRecordRevision"("commandId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX "AdminOperationalState_lastCommandId_key" ON "AdminOperationalState"("lastCommandId");
CREATE UNIQUE INDEX "AdminOperationalState_controlledIntakeId_key" ON "AdminOperationalState"("controlledIntakeId");
CREATE UNIQUE INDEX "AdminOperationalState_readinessId_key" ON "AdminOperationalState"("readinessId");
CREATE UNIQUE INDEX "AdminOperationalState_messageId_key" ON "AdminOperationalState"("messageId");
CREATE UNIQUE INDEX "AdminOperationalState_replyId_key" ON "AdminOperationalState"("replyId");
CREATE UNIQUE INDEX "AdminOperationalState_documentId_key" ON "AdminOperationalState"("documentId");
CREATE INDEX "AdminOperationalState_list_idx" ON "AdminOperationalState"("model","state","updatedAt","recordId");

CREATE FUNCTION fai_admin_operational_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'ADMIN_OPERATIONAL_STATE_RETAINED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('admin-operational-state:'||NEW."model"||':'||NEW."recordId",0));
 IF TG_OP='INSERT' THEN
  IF NEW."version"<>1 OR NEW."state"='ACTIVE' THEN RAISE EXCEPTION 'ADMIN_OPERATIONAL_STATE_INITIAL'; END IF;
  NEW."createdAt":=clock_timestamp();
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','version','lastCommandId','updatedAt','transactionId'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','lastCommandId','updatedAt','transactionId'])
     OR NEW."version"<>OLD."version"+1 OR NEW."state"=OLD."state"
     OR NEW."lastCommandId"=OLD."lastCommandId"
  THEN RAISE EXCEPTION 'ADMIN_OPERATIONAL_STATE_TRANSITION'; END IF;
 END IF;
 IF NEW."model"='Document' AND NOT EXISTS (SELECT 1 FROM "Document" WHERE id=NEW."documentId" AND "visibilityLevel"='technical_admin_private_v1')
 THEN RAISE EXCEPTION 'ADMIN_OPERATIONAL_PRIVATE_DOCUMENT_ONLY'; END IF;
 NEW."updatedAt":=clock_timestamp(); NEW."transactionId":=txid_current();
 RETURN NEW;
END $$;
CREATE TRIGGER admin_operational_state_guard BEFORE INSERT OR UPDATE OR DELETE ON "AdminOperationalState"
 FOR EACH ROW EXECUTE FUNCTION fai_admin_operational_state_guard();
CREATE TRIGGER admin_operational_state_no_truncate BEFORE TRUNCATE ON "AdminOperationalState"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_admin_operational_state_guard();

CREATE FUNCTION fai_admin_operational_state_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "AdminRecordRevision"%ROWTYPE; before_state text; before_version integer;
BEGIN
 SELECT * INTO r FROM "AdminRecordRevision" WHERE "commandId"=NEW."lastCommandId";
 before_state:=CASE WHEN TG_OP='INSERT' THEN 'ACTIVE' ELSE OLD."state" END;
 before_version:=CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD."version" END;
 IF r."commandId" IS NULL OR r."transactionId"<>txid_current() OR r."model"<>NEW."model"
  OR r."recordId"<>NEW."recordId" OR r."operation" NOT IN ('UPDATE','TRASH','RESTORE')
  OR r."before"->'operationalLifecycle'->>'state' IS DISTINCT FROM before_state
  OR r."before"->'operationalLifecycle'->>'version' IS DISTINCT FROM before_version::text
  OR r."after"->'operationalLifecycle'->>'state' IS DISTINCT FROM NEW."state"
  OR r."after"->'operationalLifecycle'->>'version' IS DISTINCT FROM NEW."version"::text
 THEN RAISE EXCEPTION 'ADMIN_OPERATIONAL_STATE_ATOMIC'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER admin_operational_state_atomic AFTER INSERT OR UPDATE ON "AdminOperationalState"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_admin_operational_state_atomic();

-- Native writers and administrative transitions use the same per-source lock.
-- A restored row keeps its epoch; previous decisions cannot regain validity.
CREATE FUNCTION fai_require_admin_operational_active(target_model text, target_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
 IF target_id IS NULL THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('admin-operational-state:'||target_model||':'||target_id,0));
 SELECT "state" INTO s FROM "AdminOperationalState" WHERE "model"=target_model AND "recordId"=target_id FOR SHARE;
 IF s IS NOT NULL AND s<>'ACTIVE' THEN RAISE EXCEPTION 'ADMIN_OPERATIONAL_INACTIVE'; END IF;
END $$;


CREATE FUNCTION fai_require_admin_readiness_active(practice_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE intake_id uuid;
BEGIN
 PERFORM fai_require_admin_operational_active('PracticeReadiness',practice_id);
 SELECT "controlledIntakeId" INTO intake_id FROM "PracticeReadiness" WHERE id=practice_id::uuid FOR SHARE;
 IF intake_id IS NULL THEN RAISE EXCEPTION 'ADMIN_OPERATIONAL_SOURCE_MISSING'; END IF;
 PERFORM fai_require_admin_operational_active('ControlledIntake',intake_id::text);
END $$;

CREATE FUNCTION fai_require_admin_message_active(message_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m "ApprovedCommunication"%ROWTYPE; intake_id uuid;
BEGIN
 PERFORM fai_require_admin_operational_active('ApprovedCommunication',message_id);
 SELECT * INTO m FROM "ApprovedCommunication" WHERE id=message_id::uuid FOR SHARE;
 IF m.id IS NULL THEN RAISE EXCEPTION 'ADMIN_OPERATIONAL_SOURCE_MISSING'; END IF;
 IF m."readinessId" IS NOT NULL THEN PERFORM fai_require_admin_readiness_active(m."readinessId"::text); END IF;
 IF m."leadId" IS NOT NULL THEN
  SELECT id INTO intake_id FROM "ControlledIntake" WHERE "leadId"=m."leadId";
  IF intake_id IS NOT NULL THEN PERFORM fai_require_admin_operational_active('ControlledIntake',intake_id::text); END IF;
 END IF;
END $$;

CREATE FUNCTION fai_admin_operational_native_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n jsonb:=to_jsonb(NEW); m text; p text; intake_id text; service_id text;
BEGIN
 IF TG_TABLE_NAME='ControlledIntake' THEN
  IF TG_OP='UPDATE' THEN PERFORM fai_require_admin_operational_active('ControlledIntake',NEW.id::text); END IF;
 ELSIF TG_TABLE_NAME='ControlledIntakeDuplicateDecision' THEN
  PERFORM fai_require_admin_operational_active('ControlledIntake',n->>'intakeId');
 ELSIF TG_TABLE_NAME='PracticeOfferRevision' THEN
  PERFORM fai_require_admin_operational_active('ControlledIntake',n->>'controlledIntakeId');
 ELSIF TG_TABLE_NAME='PracticeOfferAcceptance' THEN
  SELECT "controlledIntakeId"::text INTO intake_id FROM "PracticeOfferRevision" WHERE id=(n->>'offerRevisionId')::uuid;
  IF intake_id IS NULL THEN RAISE EXCEPTION 'ADMIN_OPERATIONAL_SOURCE_MISSING'; END IF;
  PERFORM fai_require_admin_operational_active('ControlledIntake',intake_id);
 ELSIF TG_TABLE_NAME='PracticeReadiness' THEN
  PERFORM fai_require_admin_operational_active('ControlledIntake',n->>'controlledIntakeId');
  IF TG_OP='UPDATE' THEN PERFORM fai_require_admin_operational_active('PracticeReadiness',n->>'id'); END IF;
 ELSIF TG_TABLE_NAME IN ('PracticeFundingEvidence','PracticeMaterialEvidence','PracticeMaterialAttestation','PracticeFormalization') THEN
  PERFORM fai_require_admin_readiness_active(n->>'practiceId');
 ELSIF TG_TABLE_NAME='ApprovedCommunication' THEN
  IF TG_OP='UPDATE' THEN PERFORM fai_require_admin_operational_active('ApprovedCommunication',n->>'id'); END IF;
  IF n->>'readinessId' IS NOT NULL THEN PERFORM fai_require_admin_readiness_active(n->>'readinessId'); END IF;
  IF n->>'leadId' IS NOT NULL THEN
   SELECT id::text INTO intake_id FROM "ControlledIntake" WHERE "leadId"=n->>'leadId';
   IF intake_id IS NOT NULL THEN PERFORM fai_require_admin_operational_active('ControlledIntake',intake_id); END IF;
  END IF;
 ELSIF TG_TABLE_NAME='CommunicationReply' THEN
  -- Receipt acquisition remains possible after a message is archived. Only a
  -- later explicit change to an already held reply is denied.
  IF TG_OP='UPDATE' THEN PERFORM fai_require_admin_operational_active('CommunicationReply',n->>'id'); END IF;
 ELSIF TG_TABLE_NAME IN ('CommunicationVersion','CommunicationAttempt','OrdinaryEmailDecision','OrdinaryEmailAttempt') THEN
  PERFORM fai_require_admin_message_active(n->>'messageId');
 ELSIF TG_TABLE_NAME='CommunicationApproval' THEN
  SELECT "messageId"::text INTO m FROM "CommunicationVersion" WHERE id=(n->>'versionId')::uuid;
  IF m IS NULL THEN RAISE EXCEPTION 'ADMIN_OPERATIONAL_SOURCE_MISSING'; END IF;
  PERFORM fai_require_admin_message_active(m);
 END IF;
 -- Work tied to a readiness practice cannot silently continue while it is held.
 IF TG_TABLE_NAME='ClientService' THEN service_id:=n->>'id';
 ELSIF TG_TABLE_NAME IN ('Task','DocumentChecklistItem','TechnicalPractice') THEN service_id:=n->>'clientServiceId';
 END IF;
 IF service_id IS NOT NULL THEN
  SELECT id::text INTO p FROM "PracticeReadiness" WHERE "clientServiceId"=service_id;
  IF p IS NOT NULL THEN PERFORM fai_require_admin_readiness_active(p); END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['ControlledIntake','ControlledIntakeDuplicateDecision','PracticeOfferRevision','PracticeOfferAcceptance',
   'PracticeReadiness','PracticeFundingEvidence','PracticeMaterialEvidence','PracticeMaterialAttestation','PracticeFormalization',
   'ApprovedCommunication','CommunicationReply','ClientService','Task','DocumentChecklistItem','TechnicalPractice'] LOOP
  EXECUTE format('CREATE TRIGGER admin_operational_native_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fai_admin_operational_native_guard()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['CommunicationVersion','CommunicationApproval','CommunicationAttempt','OrdinaryEmailDecision','OrdinaryEmailAttempt'] LOOP
  EXECUTE format('CREATE TRIGGER admin_operational_native_insert_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION fai_admin_operational_native_guard()',t);
 END LOOP;
END $$;

COMMIT;
