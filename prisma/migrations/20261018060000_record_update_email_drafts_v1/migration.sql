-- Schema55: explicit email-draft mode, no sends, rules, recipients or grants seeded.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>54
  OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261018000000_private_video_library_v1'
   AND checksum='e61fd5ba2a6a9139a60155642fc4c473dd5e3523b24f2fccfff3879be7f9ebfc'
   AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
  RAISE EXCEPTION 'RECORD_UPDATE_EMAIL_SCHEMA54_REQUIRED';
 END IF;
END $$;
ALTER TABLE "RecordUpdateRule"
 ADD COLUMN "mode" VARCHAR(24) NOT NULL DEFAULT 'CRM',
 ADD COLUMN "emailAuthorityRevision" INTEGER,
 ADD CONSTRAINT "RecordUpdateRule_email_mode" CHECK (
  ("mode"='CRM' AND "emailAuthorityRevision" IS NULL) OR
  ("mode" IN ('EMAIL_DRAFT','CRM_AND_EMAIL_DRAFT') AND "kind"<>'PROJECT' AND "emailAuthorityRevision" IS NOT NULL AND "emailAuthorityRevision">0));
ALTER TABLE "RecordUpdateCommand"
 ADD COLUMN "mode" VARCHAR(24) NOT NULL DEFAULT 'CRM',
 ADD COLUMN "emailAuthorityRevision" INTEGER,
 ADD CONSTRAINT "RecordUpdateCommand_email_mode" CHECK (
  ("mode"='CRM' AND "emailAuthorityRevision" IS NULL) OR
  ("mode" IN ('EMAIL_DRAFT','CRM_AND_EMAIL_DRAFT') AND "kind"<>'PROJECT' AND "emailAuthorityRevision" IS NOT NULL AND "emailAuthorityRevision">0));
ALTER TABLE "RecordUpdateDelivery" ADD COLUMN "mode" VARCHAR(24) NOT NULL DEFAULT 'CRM'
 CHECK ("mode" IN ('CRM','EMAIL_DRAFT','CRM_AND_EMAIL_DRAFT'));
ALTER TABLE "ApprovedCommunication" ADD COLUMN "updateDeliveryId" UUID
 REFERENCES "RecordUpdateDelivery"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "ApprovedCommunication_updateDeliveryId_key" ON "ApprovedCommunication"("updateDeliveryId");
ALTER TABLE "CommunicationVersion" ADD COLUMN "updateSource" JSONB, ADD COLUMN "updateSourceHash" CHAR(64),
 ADD CONSTRAINT "CommunicationVersion_update_source_pair" CHECK (
  ("updateSource" IS NULL AND "updateSourceHash" IS NULL) OR
  ("updateSource" IS NOT NULL AND jsonb_typeof("updateSource")='object' AND "updateSourceHash" IS NOT NULL
   AND "updateSourceHash" ~ '^[a-f0-9]{64}$'));
CREATE FUNCTION fai_record_update_email_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delivery_id uuid;
BEGIN
 IF TG_TABLE_NAME='ApprovedCommunication' THEN
  IF TG_OP='UPDATE' AND NEW."updateDeliveryId" IS DISTINCT FROM OLD."updateDeliveryId" THEN
   RAISE EXCEPTION 'RECORD_UPDATE_EMAIL_ORIGIN_IMMUTABLE';
  END IF;
  IF NEW."updateDeliveryId" IS NOT NULL AND (NEW.id<>NEW."updateDeliveryId" OR NOT EXISTS(
   SELECT 1 FROM "RecordUpdateDelivery" d JOIN "RecordUpdateEvent" e ON e.id=d."eventId"
   WHERE d.id=NEW."updateDeliveryId" AND d.mode IN ('EMAIL_DRAFT','CRM_AND_EMAIL_DRAFT')
    AND ((e.kind='LEAD' AND NEW."contextKind"='LEAD' AND NEW."leadId"=e."recordId")
     OR (e.kind='CLIENT' AND NEW."contextKind"='CLIENT' AND NEW."clientId"=e."recordId")
     OR (e.kind='PRACTICE' AND NEW."contextKind"='LEGACY' AND NEW."technicalPracticeId"=e."recordId"))
  )) THEN RAISE EXCEPTION 'RECORD_UPDATE_EMAIL_ORIGIN_INVALID'; END IF;
 ELSE
  SELECT "updateDeliveryId" INTO delivery_id FROM "ApprovedCommunication" WHERE id=NEW."messageId";
  IF (delivery_id IS NULL) <> (NEW."updateSource" IS NULL)
   OR (delivery_id IS NOT NULL AND (NEW."updateSource"->>'deliveryId' IS DISTINCT FROM delivery_id::text
    OR NEW."updateSource"->>'protocol' IS DISTINCT FROM 'FAI_RECORD_UPDATE_EMAIL_PROPOSAL_V1')) THEN
   RAISE EXCEPTION 'RECORD_UPDATE_EMAIL_VERSION_ORIGIN_INVALID';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "record_update_email_message_origin" BEFORE INSERT OR UPDATE ON "ApprovedCommunication"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_email_source_guard();
CREATE TRIGGER "record_update_email_version_origin" BEFORE INSERT ON "CommunicationVersion"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_email_source_guard();

CREATE OR REPLACE FUNCTION fai_record_update_record(k text,rid text,ev text,fields jsonb,source_key text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE scope_now jsonb; rule_row "RecordUpdateRule"%ROWTYPE; cmd "RecordUpdateCommand"%ROWTYPE;
 event_id uuid; person jsonb; command_setting text; author_ok boolean; total integer := 0;
BEGIN
 scope_now := fai_record_update_scope(k,rid);
 IF scope_now IS NULL THEN RETURN; END IF;
 SELECT * INTO rule_row FROM "RecordUpdateRule" WHERE kind=k AND "recordId"=rid AND active
   AND ev=ANY(events) AND ( "expiresAt" IS NULL OR "expiresAt">clock_timestamp()) AND scope=scope_now;
 command_setting := nullif(current_setting('fai.record_update_command',true),'');
 IF command_setting IS NOT NULL THEN
  SELECT * INTO cmd FROM "RecordUpdateCommand" WHERE id=command_setting::uuid AND kind=k AND "recordId"=rid
   AND operation='UPDATE' AND "transactionId"=txid_current() AND scope=scope_now;
 END IF;
 IF rule_row.id IS NULL AND cmd.id IS NULL THEN RETURN; END IF;
 IF cmd.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "User" WHERE id=cmd."actorId" AND active AND "deletedAt" IS NULL
   AND role='admin' AND "recordUpdateEpoch"=cmd."actorEpoch") THEN cmd := NULL; END IF;
 IF rule_row.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "User" WHERE id=rule_row."authorId" AND active AND "deletedAt" IS NULL
   AND role='admin' AND "recordUpdateEpoch"=rule_row."authorEpoch") THEN rule_row := NULL; END IF;
 IF rule_row.id IS NULL AND cmd.id IS NULL THEN RETURN; END IF;
 event_id := gen_random_uuid();
 INSERT INTO "RecordUpdateEvent" ("id","kind","recordId","event","changed","scope","sourceKey")
  VALUES(event_id,k,rid,ev,fields,scope_now,source_key) ON CONFLICT ("sourceKey") DO NOTHING;
 IF NOT FOUND THEN RETURN; END IF;
 -- Explicit one-shot selection wins over a matching persistent subscription.
 IF cmd.id IS NOT NULL THEN
  FOR person IN SELECT value FROM jsonb_array_elements(cmd.recipients) LOOP
   INSERT INTO "RecordUpdateDelivery"("id","eventId","recipientId","recipientEpoch","commandId","mode")
    SELECT gen_random_uuid(),event_id,u.id,u."recordUpdateEpoch",cmd.id,cmd.mode FROM "User" u
    WHERE u.id=person->>'id' AND u.active AND u."deletedAt" IS NULL AND u."recordUpdateEpoch"=(person->>'epoch')::integer
     AND (ev<>'COMMUNICATION' OR (person->>'communication')::boolean)
    ON CONFLICT ("eventId","recipientId") DO NOTHING;
  END LOOP;
 END IF;
 IF rule_row.id IS NOT NULL THEN
  FOR person IN SELECT value FROM jsonb_array_elements(rule_row.recipients) LOOP
   INSERT INTO "RecordUpdateDelivery"("id","eventId","recipientId","recipientEpoch","ruleId","ruleVersion","mode")
    SELECT gen_random_uuid(),event_id,u.id,u."recordUpdateEpoch",rule_row.id,rule_row.version,rule_row.mode FROM "User" u
    WHERE u.id=person->>'id' AND u.active AND u."deletedAt" IS NULL AND u."recordUpdateEpoch"=(person->>'epoch')::integer
     AND (ev<>'COMMUNICATION' OR (person->>'communication')::boolean)
    ON CONFLICT ("eventId","recipientId") DO NOTHING;
  END LOOP;
 END IF;
 SELECT count(*) INTO total FROM "RecordUpdateDelivery" WHERE "eventId"=event_id;
 INSERT INTO "AuditLog"(id,"actorId",event,"entityType","entityId","before","after","createdAt")
  VALUES(gen_random_uuid()::text,cmd."actorId",'record_update_event_recorded','RecordUpdateEvent',event_id::text,
   '{}'::jsonb,jsonb_build_object('kind',k,'event',ev,'recipientCount',total),clock_timestamp());
END $$;

CREATE OR REPLACE FUNCTION fai_record_update_communication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m "ApprovedCommunication"%ROWTYPE; k text; rid text; sk text;
BEGIN
 IF TG_TABLE_NAME='ApprovedCommunication' THEN
  IF NEW.state<>'SENT' OR (TG_OP='UPDATE' AND OLD.state='SENT') THEN RETURN NEW; END IF;
  m := NEW; sk := 'message:' || NEW.id::text;
 ELSIF TG_TABLE_NAME='CommunicationReply' THEN
  IF NEW."messageId" IS NULL OR NEW."linkedById" IS NULL
    OR (TG_OP='UPDATE' AND OLD."messageId" IS NOT DISTINCT FROM NEW."messageId" AND OLD."linkedById" IS NOT DISTINCT FROM NEW."linkedById") THEN RETURN NEW; END IF;
  SELECT * INTO m FROM "ApprovedCommunication" WHERE id=NEW."messageId";
  sk := 'reply:' || NEW.id::text || ':' || NEW."messageId"::text;
 ELSE
  IF NEW.status<>'usata_inviata' OR NEW."deletedAt" IS NOT NULL OR NEW.channel<>'nota_interna'
    OR (TG_OP='UPDATE' AND OLD.status='usata_inviata') THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM "TechnicalPractice" p WHERE p.id=NEW."technicalPracticeId"
    AND p."clientId"=NEW."clientId" AND p."projectId" IS NOT DISTINCT FROM NEW."projectId"
    AND p."clientServiceId" IS NOT DISTINCT FROM NEW."clientServiceId") THEN RETURN NEW; END IF;
  PERFORM fai_record_update_record('PRACTICE',NEW."technicalPracticeId",'COMMUNICATION','["communication"]'::jsonb,'practice-communication:'||NEW.id);
  RETURN NEW;
 END IF;
 -- Derived update messages and their replies stay in the communication timeline.
 -- They cannot recursively produce another update-email proposal.
 IF m.id IS NULL OR m."updateDeliveryId" IS NOT NULL THEN RETURN NEW; END IF;
 CASE m."contextKind"
 WHEN 'LEAD' THEN k := 'LEAD'; rid := m."leadId";
 WHEN 'CLIENT' THEN k := 'CLIENT'; rid := m."clientId";
 WHEN 'LEGACY' THEN
  IF m."readinessId" IS NOT NULL OR m."technicalPracticeId" IS NULL THEN RETURN NEW; END IF;
  k := 'PRACTICE'; rid := m."technicalPracticeId";
 ELSE RETURN NEW;
 END CASE;
 IF rid IS NOT NULL THEN PERFORM fai_record_update_record(k,rid,'COMMUNICATION','["communication"]'::jsonb,sk); END IF;
 RETURN NEW;
END $$;

COMMIT;
