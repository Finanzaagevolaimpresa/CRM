-- Schema76: typed operational history, canonical contact fields, CRM notices.
-- No grants, contacts, messages, providers or real operational data are seeded.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>75
  OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations"
   WHERE migration_name='20261101090000_ordinary_email_reconciliation_v1'
    AND checksum='a614f39613104610719cb92c8c67c3fc7604836d7f072bf461b55c1b14ec3e95'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
  RAISE EXCEPTION 'SHARED_OPERATIONAL_SCHEMA75_REQUIRED';
 END IF;
END $$;
ALTER TABLE "Company"
 ADD COLUMN "sdiCode" VARCHAR(7) CHECK ("sdiCode" IS NULL OR "sdiCode" ~ '^[A-Z0-9]{7}$'),
 ADD COLUMN "legalStreet" VARCHAR(200), ADD COLUMN "legalStreetNumber" VARCHAR(32),
 ADD COLUMN "legalPostalCode" VARCHAR(12), ADD COLUMN "legalCity" VARCHAR(100), ADD COLUMN "legalProvince" VARCHAR(100),
 ADD COLUMN "operatingStreet" VARCHAR(200), ADD COLUMN "operatingStreetNumber" VARCHAR(32),
 ADD COLUMN "operatingPostalCode" VARCHAR(12), ADD COLUMN "operatingCity" VARCHAR(100), ADD COLUMN "operatingProvince" VARCHAR(100);
ALTER TABLE "CompanyPerson" ADD COLUMN "isAdministrator" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "isOperationalContact" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Client" ADD COLUMN "operationalState" VARCHAR(24)
 CHECK ("operationalState" IS NULL OR "operationalState" IN
  ('da_avviare','in_corso','in_attesa_cliente','in_attesa_ente','sospeso_operativo','completato'));
-- A durable negative outcome uses the same unique command key as the write.
-- It closes an unobserved attempt and cannot grant, edit a record or send.
ALTER TABLE "RecordUpdateCommand" DROP CONSTRAINT "RecordUpdateCommand_operation_check",
 ADD CONSTRAINT "RecordUpdateCommand_operation_check" CHECK ("operation" IN ('UPDATE','RULE','REVOKE','CLOSE_ATTEMPT')),
 ADD CONSTRAINT "RecordUpdateCommand_closed_attempt" CHECK ("operation"<>'CLOSE_ATTEMPT'
  OR (mode='CRM' AND "emailAuthorityRevision" IS NULL AND recipients='[]'::jsonb
   AND scope='{"protocol":"FAI_SHARED_OPERATIONAL_CLOSED_V1"}'::jsonb));

-- Extend the signed selection ceiling for the seventh explicit action.
-- Existing grants and payloads remain byte-for-byte unchanged.
ALTER TABLE "TechnicalAssignment" DROP CONSTRAINT technical_assignment_payload_structure,
 ADD CONSTRAINT technical_assignment_payload_structure CHECK ((
  payload->>'protocol'='TECHNICAL_ASSIGNMENT_V1' AND payload->>'id'=id::text
  AND payload->>'revision'=revision::text AND payload->>'targetId'=COALESCE("projectId","practiceId")
  AND payload->'selection'->>'kind'=kind AND payload->'selection'->>'userId'="recipientId"
  AND jsonb_typeof(payload->'selection'->'actions')='array'
  AND jsonb_array_length(payload->'selection'->'actions') BETWEEN 1 AND 7
  AND jsonb_typeof(payload->'selection'->'readableFields')='array'
  AND jsonb_array_length(payload->'selection'->'readableFields') BETWEEN 1 AND 12
  AND jsonb_typeof(payload->'selection'->'editableFields')='array'
  AND jsonb_typeof(payload->'selection'->'documents')='array'
  AND jsonb_array_length(payload->'selection'->'documents') BETWEEN 0 AND 20
 ) IS TRUE);

CREATE TABLE "SharedOperationalUpdate" (
 id UUID PRIMARY KEY REFERENCES "RecordUpdateCommand"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "eventId" UUID NOT NULL UNIQUE REFERENCES "RecordUpdateEvent"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 kind VARCHAR(20) NOT NULL CHECK (kind IN ('CLIENT','PROJECT','PRACTICE')),
 "recordId" TEXT NOT NULL,
 "clientId" TEXT NOT NULL REFERENCES "Client"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "projectId" TEXT REFERENCES "Project"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "practiceId" TEXT REFERENCES "TechnicalPractice"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "authorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "authorName" VARCHAR(200) NOT NULL,
 "sessionId" UUID NOT NULL,
 "assignmentRevisionId" UUID REFERENCES "TechnicalAssignmentRevision"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 classification VARCHAR(24) NOT NULL DEFAULT 'SHARED_OPERATIONAL' CHECK (classification='SHARED_OPERATIONAL'),
 text VARCHAR(4000) NOT NULL CHECK (length(btrim(text))>0),
 "stateBefore" VARCHAR(24), "stateAfter" VARCHAR(24), "stateChanged" BOOLEAN NOT NULL DEFAULT false,
 "nextAction" VARCHAR(500), "nextActionDueOn" DATE,
 "correctionOfId" UUID UNIQUE REFERENCES "SharedOperationalUpdate"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "SharedOperationalUpdate_identity" CHECK (id="eventId" AND id IS DISTINCT FROM "correctionOfId"),
 CONSTRAINT "SharedOperationalUpdate_transition" CHECK ("stateChanged"=("stateBefore" IS DISTINCT FROM "stateAfter")
  AND ("correctionOfId" IS NULL OR NOT "stateChanged")),
 CONSTRAINT "SharedOperationalUpdate_target" CHECK (
  (kind='CLIENT' AND "recordId"="clientId" AND "projectId" IS NULL AND "practiceId" IS NULL) OR
  (kind='PROJECT' AND "recordId"="projectId" AND "practiceId" IS NULL) OR
  (kind='PRACTICE' AND "recordId"="practiceId"))
);
CREATE INDEX "SharedOperationalUpdate_clientId_createdAt_id_idx" ON "SharedOperationalUpdate"("clientId","createdAt",id);
CREATE INDEX "SharedOperationalUpdate_projectId_createdAt_id_idx" ON "SharedOperationalUpdate"("projectId","createdAt",id);
CREATE INDEX "SharedOperationalUpdate_practiceId_createdAt_id_idx" ON "SharedOperationalUpdate"("practiceId","createdAt",id);
CREATE TRIGGER shared_operational_immutable BEFORE UPDATE OR DELETE ON "SharedOperationalUpdate"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_immutable();
CREATE TRIGGER shared_operational_no_truncate BEFORE TRUNCATE ON "SharedOperationalUpdate"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_record_update_immutable();
CREATE FUNCTION fai_shared_operational_audit_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM "AuditLog" WHERE id LIKE 'shared-operational:%') THEN
   RAISE EXCEPTION 'SHARED_OPERATIONAL_AUDIT_RETAINED';
  END IF;
  RETURN NULL;
 END IF;
 IF OLD.id LIKE 'shared-operational:%' THEN RAISE EXCEPTION 'SHARED_OPERATIONAL_AUDIT_RETAINED'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shared_operational_audit_retained BEFORE UPDATE OR DELETE ON "AuditLog"
 FOR EACH ROW EXECUTE FUNCTION fai_shared_operational_audit_retained();
CREATE TRIGGER shared_operational_audit_no_truncate BEFORE TRUNCATE ON "AuditLog"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_shared_operational_audit_retained();

CREATE FUNCTION fai_shared_operational_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cmd "RecordUpdateCommand"%ROWTYPE; ev "RecordUpdateEvent"%ROWTYPE; u "User"%ROWTYPE;
 prior "SharedOperationalUpdate"%ROWTYPE; current_state text; c text; p text; revision_ok boolean;
BEGIN
 SELECT * INTO cmd FROM "RecordUpdateCommand" WHERE id=NEW.id;
 SELECT * INTO ev FROM "RecordUpdateEvent" WHERE id=NEW."eventId";
 SELECT * INTO u FROM "User" WHERE id=NEW."authorId";
 IF cmd.id IS NULL OR ev.id IS NULL OR cmd."transactionId"<>txid_current()
  OR cmd.mode<>'CRM' OR cmd.operation<>'UPDATE' OR cmd."actorId"<>NEW."authorId"
  OR cmd.kind<>NEW.kind OR cmd."recordId"<>NEW."recordId" OR cmd."actorEpoch"<>u."recordUpdateEpoch"
  OR u.id IS NULL OR NOT u.active OR u."deletedAt" IS NOT NULL OR NEW."authorName"<>u.name
  OR ev.kind<>NEW.kind OR ev."recordId"<>NEW."recordId" OR ev.event<>'RECORD_CHANGED'
  OR ev.changed<>'["profile"]'::jsonb OR ev."sourceKey" IS DISTINCT FROM 'shared-update:'||NEW.id::text
  OR ev.scope<>cmd.scope OR cmd.scope IS DISTINCT FROM fai_record_update_scope(NEW.kind,NEW."recordId")
  OR NEW."createdAt"<>cmd."createdAt" OR NEW."createdAt"<>ev."occurredAt"
  OR NOT EXISTS(SELECT 1 FROM "InternalSession" s WHERE s.id=NEW."sessionId" AND s."userId"=u.id
    AND s."revokedAt" IS NULL AND s."expiresAt">clock_timestamp()) THEN
  RAISE EXCEPTION 'SHARED_OPERATIONAL_ORIGIN_INVALID';
 END IF;
 IF NEW.kind='CLIENT' THEN
  SELECT id,"operationalState" INTO c,current_state FROM "Client" WHERE id=NEW."recordId";
 ELSIF NEW.kind='PROJECT' THEN
  SELECT "clientId",id,status INTO c,p,current_state FROM "Project" WHERE id=NEW."recordId";
 ELSE
  SELECT t."clientId",coalesce(t."projectId",s."projectId"),t.status INTO c,p,current_state
   FROM "TechnicalPractice" t LEFT JOIN "ClientService" s ON s.id=t."clientServiceId" WHERE t.id=NEW."recordId";
 END IF;
 IF c IS DISTINCT FROM NEW."clientId" OR p IS DISTINCT FROM NEW."projectId"
  OR current_state IS DISTINCT FROM NEW."stateBefore" THEN RAISE EXCEPTION 'SHARED_OPERATIONAL_CONTEXT_STALE'; END IF;
 IF NEW."stateAfter" IS NOT NULL AND NOT (CASE NEW.kind
  WHEN 'CLIENT' THEN NEW."stateAfter"=ANY(ARRAY['da_avviare','in_corso','in_attesa_cliente','in_attesa_ente','sospeso_operativo','completato'])
  WHEN 'PROJECT' THEN NEW."stateAfter"=ANY(ARRAY['idea','raccolta_dati','in_analisi','preanalisi_pronta','dossier_pronto','pratica_attiva','chiuso'])
  ELSE NEW."stateAfter"=ANY(ARRAY['da_progettare','in_progettazione','documenti_richiesti','documenti_completi','pronta_presentazione','presentata','integrazione_richiesta','in_istruttoria','approvata','respinta'])
 END) THEN RAISE EXCEPTION 'SHARED_OPERATIONAL_TRANSITION_INVALID'; END IF;
 IF u.role='admin' THEN
  IF NEW."assignmentRevisionId" IS NOT NULL THEN RAISE EXCEPTION 'SHARED_OPERATIONAL_AUTHOR_INVALID'; END IF;
 ELSE
  SELECT EXISTS(SELECT 1 FROM "TechnicalAssignmentRevision" r JOIN "TechnicalAssignment" a ON a.id=r."assignmentId"
   WHERE r.id=NEW."assignmentRevisionId" AND r.revision=a.revision AND a."recipientId"=u.id
    AND a."revokedAt" IS NULL AND r."revokedAt" IS NULL
    AND ((NEW.kind='PROJECT' AND a.kind='Project' AND a."projectId"=NEW."recordId")
     OR (NEW.kind='PRACTICE' AND a.kind='TechnicalPractice' AND a."practiceId"=NEW."recordId"))) INTO revision_ok;
  IF u.role NOT IN ('consulente','backoffice') OR NOT revision_ok THEN RAISE EXCEPTION 'SHARED_OPERATIONAL_ASSIGNMENT_REQUIRED'; END IF;
 END IF;
 IF NEW."correctionOfId" IS NOT NULL THEN
  SELECT * INTO prior FROM "SharedOperationalUpdate" WHERE id=NEW."correctionOfId";
  IF prior.id IS NULL OR prior.kind<>NEW.kind OR prior."recordId"<>NEW."recordId"
   OR prior."clientId"<>NEW."clientId" OR prior."projectId" IS DISTINCT FROM NEW."projectId"
   OR (u.role<>'admin' AND prior."authorId"<>u.id) THEN RAISE EXCEPTION 'SHARED_OPERATIONAL_CORRECTION_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shared_operational_insert BEFORE INSERT ON "SharedOperationalUpdate"
 FOR EACH ROW EXECUTE FUNCTION fai_shared_operational_insert();

-- Retain the exact historical implementation. Only the matching status capture
-- of this transaction's typed command is coalesced; no other event is suppressed.
ALTER FUNCTION fai_record_update_record(text,text,text,jsonb,text) RENAME TO fai_record_update_record_before_shared_v1;
CREATE FUNCTION fai_record_update_record(k text,rid text,ev text,fields jsonb,source_key text DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql AS $$
DECLARE setting text := nullif(current_setting('fai.shared_operational_command',true),'');
BEGIN
 IF setting IS NOT NULL AND ev='STATE_CHANGED' AND fields='["status"]'::jsonb AND source_key IS NULL
  AND EXISTS(SELECT 1 FROM "SharedOperationalUpdate" s JOIN "RecordUpdateCommand" c ON c.id=s.id
   WHERE s.id::text=setting AND s.kind=k AND s."recordId"=rid AND s."stateChanged"
    AND c."transactionId"=txid_current() AND c.mode='CRM' AND c.scope=fai_record_update_scope(k,rid)) THEN RETURN; END IF;
 PERFORM fai_record_update_record_before_shared_v1(k,rid,ev,fields,source_key);
END $$;

CREATE FUNCTION fai_shared_operational_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cmd "RecordUpdateCommand"%ROWTYPE; current_state text; expected_count integer;
BEGIN
 SELECT * INTO cmd FROM "RecordUpdateCommand" WHERE id=NEW.id;
 CASE NEW.kind
  WHEN 'CLIENT' THEN SELECT "operationalState" INTO current_state FROM "Client" WHERE id=NEW."recordId";
  WHEN 'PROJECT' THEN SELECT status INTO current_state FROM "Project" WHERE id=NEW."recordId";
  ELSE SELECT status INTO current_state FROM "TechnicalPractice" WHERE id=NEW."recordId";
 END CASE;
 expected_count := jsonb_array_length(cmd.recipients);
 IF current_state IS DISTINCT FROM NEW."stateAfter" OR expected_count<1
  OR expected_count<>(SELECT count(*) FROM "RecordUpdateDelivery" WHERE "eventId"=NEW."eventId")
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(cmd.recipients) r WHERE NOT EXISTS(
   SELECT 1 FROM "RecordUpdateDelivery" d WHERE d."eventId"=NEW."eventId" AND d."commandId"=NEW.id
    AND d."recipientId"=r->>'id' AND d."recipientEpoch"=(r->>'epoch')::integer AND d.mode='CRM' AND d."ruleId" IS NULL))
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" a WHERE a.id='shared-operational:'||NEW.id::text AND a."entityType"='SharedOperationalUpdate'
   AND a."entityId"=NEW.id::text AND a."actorId"=NEW."authorId"
   AND a.event IN ('shared_operational_update_recorded','shared_operational_update_corrected')
   AND a."after"->>'mode'='CRM_ONLY'
   AND a."after"->>'commandId'=audit_sanitize_json_n04_v1(jsonb_build_object('commandId',NEW.id::text))->>'commandId') THEN
  RAISE EXCEPTION 'SHARED_OPERATIONAL_ATOMIC_RESULT_REQUIRED';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER shared_operational_complete AFTER INSERT ON "SharedOperationalUpdate"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_shared_operational_complete();
COMMIT;
