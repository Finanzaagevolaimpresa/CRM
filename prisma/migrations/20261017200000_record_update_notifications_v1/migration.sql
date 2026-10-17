-- Record update notifications, schema53. No rules, grants or work are seeded.
-- No provider, worker, cron, email send or deletion is introduced.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>52
  OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261017160000_admin_email_contexts_v1'
    AND checksum='614f3a2c329892f2732c9e788c1f120662f30ea9c01edea9ff0192a087d9f026'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'RecordUpdate%') THEN
  RAISE EXCEPTION 'RECORD_UPDATE_MIGRATION53_BASE_REQUIRED';
 END IF;
END $$;
ALTER TABLE "User" ADD COLUMN "recordUpdateEpoch" INTEGER NOT NULL DEFAULT 1 CHECK ("recordUpdateEpoch">0);
ALTER TABLE "Lead" ADD COLUMN "recordUpdateEpoch" INTEGER NOT NULL DEFAULT 1 CHECK ("recordUpdateEpoch">0);
ALTER TABLE "Client" ADD COLUMN "recordUpdateEpoch" INTEGER NOT NULL DEFAULT 1 CHECK ("recordUpdateEpoch">0);
ALTER TABLE "Project" ADD COLUMN "recordUpdateEpoch" INTEGER NOT NULL DEFAULT 1 CHECK ("recordUpdateEpoch">0);
ALTER TABLE "ClientService" ADD COLUMN "recordUpdateEpoch" INTEGER NOT NULL DEFAULT 1 CHECK ("recordUpdateEpoch">0);
ALTER TABLE "TechnicalPractice" ADD COLUMN "recordUpdateEpoch" INTEGER NOT NULL DEFAULT 1 CHECK ("recordUpdateEpoch">0);

CREATE TABLE "RecordUpdateRule" (
 "id" UUID PRIMARY KEY, "kind" VARCHAR(20) NOT NULL CHECK ("kind" IN ('LEAD','CLIENT','PRACTICE','PROJECT')),
 "recordId" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version">0), "active" BOOLEAN NOT NULL DEFAULT true,
 "authorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, "authorEpoch" INTEGER NOT NULL CHECK ("authorEpoch">0),
 "scope" JSONB NOT NULL, "selection" JSONB NOT NULL, "directoryBinding" CHAR(64) NOT NULL CHECK ("directoryBinding" ~ '^[a-f0-9]{64}$'),
 "recipients" JSONB NOT NULL CHECK (jsonb_typeof("recipients")='array' AND jsonb_array_length("recipients") BETWEEN 1 AND 20),
 "events" TEXT[] NOT NULL CHECK (cardinality("events") BETWEEN 1 AND 5 AND "events" <@ ARRAY['STATE_CHANGED','RECORD_CHANGED','COMMUNICATION','NEXT_ACTION','DEADLINE']::text[]),
 "expiresAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "RecordUpdateRule_kind_recordId_key" UNIQUE ("kind","recordId")
);
CREATE TABLE "RecordUpdateCommand" (
 "id" UUID PRIMARY KEY, "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "actorEpoch" INTEGER NOT NULL CHECK ("actorEpoch">0), "kind" VARCHAR(20) NOT NULL CHECK ("kind" IN ('LEAD','CLIENT','PRACTICE','PROJECT')),
 "recordId" TEXT NOT NULL, "digest" CHAR(64) NOT NULL CHECK ("digest" ~ '^[a-f0-9]{64}$'),
 "operation" VARCHAR(20) NOT NULL CHECK ("operation" IN ('UPDATE','RULE','REVOKE')),
 "scope" JSONB NOT NULL, "selection" JSONB NOT NULL, "directoryBinding" CHAR(64) NOT NULL,
 "recipients" JSONB NOT NULL, "transactionId" BIGINT NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE TABLE "RecordUpdateEvent" (
 "id" UUID PRIMARY KEY, "kind" VARCHAR(20) NOT NULL CHECK ("kind" IN ('LEAD','CLIENT','PRACTICE','PROJECT')),
 "recordId" TEXT NOT NULL, "event" VARCHAR(30) NOT NULL CHECK ("event" IN ('STATE_CHANGED','RECORD_CHANGED','COMMUNICATION','NEXT_ACTION','DEADLINE')),
 "changed" JSONB NOT NULL CHECK (jsonb_typeof("changed")='array' AND jsonb_array_length("changed") BETWEEN 1 AND 3
   AND CASE "event" WHEN 'STATE_CHANGED' THEN "changed" <@ '["status","progress"]'::jsonb
    WHEN 'RECORD_CHANGED' THEN "changed" <@ '["displayName","type","profile"]'::jsonb
    WHEN 'COMMUNICATION' THEN "changed" = '["communication"]'::jsonb
    WHEN 'NEXT_ACTION' THEN "changed" <@ '["nextAction","nextActionDate"]'::jsonb
    WHEN 'DEADLINE' THEN "changed" = '["dueDate"]'::jsonb ELSE false END),
 "scope" JSONB NOT NULL, "sourceKey" TEXT UNIQUE, "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "RecordUpdateEvent_kind_recordId_occurredAt_idx" ON "RecordUpdateEvent"("kind","recordId","occurredAt");
CREATE TABLE "RecordUpdateDelivery" (
 "id" UUID PRIMARY KEY, "eventId" UUID NOT NULL REFERENCES "RecordUpdateEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "recipientId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "recipientEpoch" INTEGER NOT NULL CHECK ("recipientEpoch">0),
 "ruleId" UUID REFERENCES "RecordUpdateRule"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, "ruleVersion" INTEGER,
 "commandId" UUID REFERENCES "RecordUpdateCommand"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, "readAt" TIMESTAMPTZ(3),
 CHECK (("ruleId" IS NOT NULL AND "ruleVersion">0 AND "commandId" IS NULL)
     OR ("ruleId" IS NULL AND "ruleVersion" IS NULL AND "commandId" IS NOT NULL)),
 CONSTRAINT "RecordUpdateDelivery_eventId_recipientId_key" UNIQUE ("eventId","recipientId")
);
CREATE INDEX "RecordUpdateDelivery_recipientId_readAt_eventId_idx" ON "RecordUpdateDelivery"("recipientId","readAt","eventId");

-- A re-grant never resurrects an earlier recipient snapshot. Login/lastLoginAt
-- and password throttle updates alone do not change the recipient generation.
CREATE FUNCTION fai_record_update_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean := false; field_name text; before_json jsonb := to_jsonb(OLD); after_json jsonb := to_jsonb(NEW);
BEGIN
 FOREACH field_name IN ARRAY TG_ARGV LOOP
  changed := changed OR before_json->field_name IS DISTINCT FROM after_json->field_name;
 END LOOP;
 IF TG_TABLE_NAME IN ('Lead','Client','Project','TechnicalPractice','ClientService') THEN
  changed := changed OR (before_json->'status' IS DISTINCT FROM after_json->'status'
   AND (before_json->>'status' IN ('archiviato','archiviata','sospeso') OR after_json->>'status' IN ('archiviato','archiviata','sospeso')));
 END IF;
 -- Permission/grant triggers use the only explicit increment, never a reset.
 IF changed OR (TG_TABLE_NAME='User' AND NEW."recordUpdateEpoch" IS DISTINCT FROM OLD."recordUpdateEpoch") THEN
  NEW."recordUpdateEpoch" := OLD."recordUpdateEpoch"+1;
 ELSE NEW."recordUpdateEpoch" := OLD."recordUpdateEpoch"; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "record_update_epoch_User" BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION fai_record_update_epoch('role','active','deletedAt','name','email');
CREATE TRIGGER "record_update_epoch_Lead" BEFORE UPDATE ON "Lead" FOR EACH ROW EXECUTE FUNCTION fai_record_update_epoch('assignedToId','clientId','deletedAt');
CREATE TRIGGER "record_update_epoch_Client" BEFORE UPDATE ON "Client" FOR EACH ROW EXECUTE FUNCTION fai_record_update_epoch('salesOwnerId','consultantId','leadId','deletedAt');
CREATE TRIGGER "record_update_epoch_Project" BEFORE UPDATE ON "Project" FOR EACH ROW EXECUTE FUNCTION fai_record_update_epoch('clientId','companyId','consultantId','deletedAt');
CREATE TRIGGER "record_update_epoch_ClientService" BEFORE UPDATE ON "ClientService" FOR EACH ROW EXECUTE FUNCTION fai_record_update_epoch('clientId','projectId','assignedToId','deletedAt');
CREATE TRIGGER "record_update_epoch_TechnicalPractice" BEFORE UPDATE ON "TechnicalPractice" FOR EACH ROW EXECUTE FUNCTION fai_record_update_epoch('clientId','projectId','clientServiceId','commercialOwnerId','technicalOwnerId','deletedAt');

CREATE FUNCTION fai_record_update_grant_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_id text; after_id text; target text;
BEGIN
 IF TG_OP<>'INSERT' THEN before_id := to_jsonb(OLD)->>TG_ARGV[0]; END IF;
 IF TG_OP<>'DELETE' THEN after_id := to_jsonb(NEW)->>TG_ARGV[0]; END IF;
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
 FOR target IN SELECT DISTINCT x FROM unnest(ARRAY[before_id,after_id]) x WHERE x IS NOT NULL ORDER BY x LOOP
  UPDATE "User" SET "recordUpdateEpoch"="recordUpdateEpoch"+1 WHERE id=target;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER record_update_permission_epoch AFTER INSERT OR UPDATE OR DELETE ON "UserPermissionOverride"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_grant_epoch('userId');
CREATE TRIGGER record_update_client_grant_epoch AFTER INSERT OR UPDATE OR DELETE ON "ClientReadGrant"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_grant_epoch('userId');
CREATE TRIGGER record_update_project_grant_epoch AFTER INSERT OR UPDATE OR DELETE ON "SelectiveProjectGrant"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_grant_epoch('recipientId');

-- This is a context/lifecycle fingerprint, never an access grant.
CREATE FUNCTION fai_record_update_scope(k text,rid text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE r jsonb; c jsonb; p jsonb; s jsonb; sp jsonb; result jsonb;
BEGIN
 CASE k
 WHEN 'LEAD' THEN SELECT to_jsonb(t) INTO r FROM "Lead" t WHERE id=rid;
 WHEN 'CLIENT' THEN SELECT to_jsonb(t) INTO r FROM "Client" t WHERE id=rid;
 WHEN 'PROJECT' THEN SELECT to_jsonb(t) INTO r FROM "Project" t WHERE id=rid;
 WHEN 'PRACTICE' THEN SELECT to_jsonb(t) INTO r FROM "TechnicalPractice" t WHERE id=rid;
 ELSE RETURN NULL; END CASE;
 IF r IS NULL OR r->>'deletedAt' IS NOT NULL OR r->>'status' IN ('archiviato','archiviata','sospeso') THEN RETURN NULL; END IF;
 result := jsonb_build_object('root',jsonb_build_array(k,rid,r->'recordUpdateEpoch'));
 IF k IN ('PROJECT','PRACTICE') THEN
  SELECT to_jsonb(t) INTO c FROM "Client" t WHERE id=r->>'clientId';
  IF c IS NULL OR c->>'deletedAt' IS NOT NULL OR c->>'status' IN ('archiviato','sospeso') THEN RETURN NULL; END IF;
  result := result || jsonb_build_object('client',jsonb_build_array(c->>'id',c->'recordUpdateEpoch'));
 END IF;
 IF k='PRACTICE' THEN
  IF r->>'projectId' IS NOT NULL THEN
   SELECT to_jsonb(t) INTO p FROM "Project" t WHERE id=r->>'projectId';
   IF p IS NULL OR p->>'deletedAt' IS NOT NULL OR p->>'status'='archiviato' OR p->>'clientId'<>c->>'id' THEN RETURN NULL; END IF;
   result := result || jsonb_build_object('project',jsonb_build_array(p->>'id',p->'recordUpdateEpoch'));
  END IF;
  IF r->>'clientServiceId' IS NOT NULL THEN
   SELECT to_jsonb(t) INTO s FROM "ClientService" t WHERE id=r->>'clientServiceId';
   IF s IS NULL OR s->>'deletedAt' IS NOT NULL OR s->>'status' IN ('archiviato','archiviata') OR s->>'clientId'<>c->>'id' THEN RETURN NULL; END IF;
   result := result || jsonb_build_object('service',jsonb_build_array(s->>'id',s->'recordUpdateEpoch'));
   IF s->>'projectId' IS NOT NULL THEN
    SELECT to_jsonb(t) INTO sp FROM "Project" t WHERE id=s->>'projectId';
    IF sp IS NULL OR sp->>'deletedAt' IS NOT NULL OR sp->>'status'='archiviato' OR sp->>'clientId'<>c->>'id'
      OR (p IS NOT NULL AND p->>'id'<>sp->>'id') THEN RETURN NULL; END IF;
    result := result || jsonb_build_object('serviceProject',jsonb_build_array(sp->>'id',sp->'recordUpdateEpoch'));
   END IF;
  END IF;
 END IF;
 RETURN result;
END $$;

-- Called by native record writers inside their existing transaction. This only
-- records work. Delivery admission and metadata reads recheck current ACL.
CREATE FUNCTION fai_record_update_record(k text,rid text,ev text,fields jsonb,source_key text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
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
   INSERT INTO "RecordUpdateDelivery"("id","eventId","recipientId","recipientEpoch","commandId")
    SELECT gen_random_uuid(),event_id,u.id,u."recordUpdateEpoch",cmd.id FROM "User" u
    WHERE u.id=person->>'id' AND u.active AND u."deletedAt" IS NULL AND u."recordUpdateEpoch"=(person->>'epoch')::integer
     AND (ev<>'COMMUNICATION' OR (person->>'communication')::boolean)
    ON CONFLICT ("eventId","recipientId") DO NOTHING;
  END LOOP;
 END IF;
 IF rule_row.id IS NOT NULL THEN
  FOR person IN SELECT value FROM jsonb_array_elements(rule_row.recipients) LOOP
   INSERT INTO "RecordUpdateDelivery"("id","eventId","recipientId","recipientEpoch","ruleId","ruleVersion")
    SELECT gen_random_uuid(),event_id,u.id,u."recordUpdateEpoch",rule_row.id,rule_row.version FROM "User" u
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
CREATE FUNCTION fai_record_update_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed jsonb;
BEGIN
 IF NEW."recordUpdateEpoch"<>OLD."recordUpdateEpoch" THEN RETURN NEW; END IF;
 CASE TG_TABLE_NAME
 WHEN 'Lead' THEN
  SELECT coalesce(jsonb_agg(DISTINCT label),'[]'::jsonb) INTO changed FROM (VALUES
   ('status',to_jsonb(OLD)->'status' IS DISTINCT FROM to_jsonb(NEW)->'status')
  ) changes(label,different) WHERE different;
  IF jsonb_array_length(changed)>0 THEN PERFORM fai_record_update_record('LEAD',NEW.id,'STATE_CHANGED',changed); END IF;
  SELECT coalesce(jsonb_agg(DISTINCT label),'[]'::jsonb) INTO changed FROM (VALUES
   ('displayName',to_jsonb(OLD)->'firstName' IS DISTINCT FROM to_jsonb(NEW)->'firstName'),
   ('displayName',to_jsonb(OLD)->'lastName' IS DISTINCT FROM to_jsonb(NEW)->'lastName'),
   ('displayName',to_jsonb(OLD)->'companyName' IS DISTINCT FROM to_jsonb(NEW)->'companyName')
  ) changes(label,different) WHERE different;
  IF jsonb_array_length(changed)>0 THEN PERFORM fai_record_update_record('LEAD',NEW.id,'RECORD_CHANGED',changed); END IF;
  SELECT coalesce(jsonb_agg(DISTINCT label),'[]'::jsonb) INTO changed FROM (VALUES
   ('nextActionDate',to_jsonb(OLD)->'nextActionDate' IS DISTINCT FROM to_jsonb(NEW)->'nextActionDate'),
   ('nextAction',to_jsonb(OLD)->'nextActionNote' IS DISTINCT FROM to_jsonb(NEW)->'nextActionNote')
  ) changes(label,different) WHERE different;
  IF jsonb_array_length(changed)>0 THEN PERFORM fai_record_update_record('LEAD',NEW.id,'NEXT_ACTION',changed); END IF;
 WHEN 'Client' THEN
  SELECT coalesce(jsonb_agg(DISTINCT label),'[]'::jsonb) INTO changed FROM (VALUES
   ('status',to_jsonb(OLD)->'status' IS DISTINCT FROM to_jsonb(NEW)->'status')
  ) changes(label,different) WHERE different;
  IF jsonb_array_length(changed)>0 THEN PERFORM fai_record_update_record('CLIENT',NEW.id,'STATE_CHANGED',changed); END IF;
  SELECT coalesce(jsonb_agg(DISTINCT label),'[]'::jsonb) INTO changed FROM (VALUES
   ('displayName',to_jsonb(OLD)->'displayName' IS DISTINCT FROM to_jsonb(NEW)->'displayName'),
   ('type',to_jsonb(OLD)->'type' IS DISTINCT FROM to_jsonb(NEW)->'type')
  ) changes(label,different) WHERE different;
  IF jsonb_array_length(changed)>0 THEN PERFORM fai_record_update_record('CLIENT',NEW.id,'RECORD_CHANGED',changed); END IF;
 WHEN 'Project' THEN
  SELECT coalesce(jsonb_agg(DISTINCT label),'[]'::jsonb) INTO changed FROM (VALUES
   ('status',to_jsonb(OLD)->'status' IS DISTINCT FROM to_jsonb(NEW)->'status')
  ) changes(label,different) WHERE different;
  IF jsonb_array_length(changed)>0 THEN PERFORM fai_record_update_record('PROJECT',NEW.id,'STATE_CHANGED',changed); END IF;
  SELECT coalesce(jsonb_agg(DISTINCT label),'[]'::jsonb) INTO changed FROM (VALUES
   ('displayName',to_jsonb(OLD)->'title' IS DISTINCT FROM to_jsonb(NEW)->'title')
  ) changes(label,different) WHERE different;
  IF jsonb_array_length(changed)>0 THEN PERFORM fai_record_update_record('PROJECT',NEW.id,'RECORD_CHANGED',changed); END IF;
 WHEN 'TechnicalPractice' THEN
  SELECT coalesce(jsonb_agg(DISTINCT label),'[]'::jsonb) INTO changed FROM (VALUES
   ('status',to_jsonb(OLD)->'status' IS DISTINCT FROM to_jsonb(NEW)->'status'),
   ('progress',to_jsonb(OLD)->'clientVisibleStatus' IS DISTINCT FROM to_jsonb(NEW)->'clientVisibleStatus')
  ) changes(label,different) WHERE different;
  IF jsonb_array_length(changed)>0 THEN PERFORM fai_record_update_record('PRACTICE',NEW.id,'STATE_CHANGED',changed); END IF;
  SELECT coalesce(jsonb_agg(DISTINCT label),'[]'::jsonb) INTO changed FROM (VALUES
   ('nextActionDate',to_jsonb(OLD)->'nextClientUpdateAt' IS DISTINCT FROM to_jsonb(NEW)->'nextClientUpdateAt')
  ) changes(label,different) WHERE different;
  IF jsonb_array_length(changed)>0 THEN PERFORM fai_record_update_record('PRACTICE',NEW.id,'NEXT_ACTION',changed); END IF;
  SELECT coalesce(jsonb_agg(DISTINCT label),'[]'::jsonb) INTO changed FROM (VALUES
   ('dueDate',to_jsonb(OLD)->'dueDate' IS DISTINCT FROM to_jsonb(NEW)->'dueDate')
  ) changes(label,different) WHERE different;
  IF jsonb_array_length(changed)>0 THEN PERFORM fai_record_update_record('PRACTICE',NEW.id,'DEADLINE',changed); END IF;
 ELSE NULL; END CASE;
 RETURN NEW;
END $$;
CREATE TRIGGER "record_update_capture_Lead" AFTER UPDATE ON "Lead" FOR EACH ROW EXECUTE FUNCTION fai_record_update_capture();
CREATE TRIGGER "record_update_capture_Client" AFTER UPDATE ON "Client" FOR EACH ROW EXECUTE FUNCTION fai_record_update_capture();
CREATE TRIGGER "record_update_capture_Project" AFTER UPDATE ON "Project" FOR EACH ROW EXECUTE FUNCTION fai_record_update_capture();
CREATE TRIGGER "record_update_capture_TechnicalPractice" AFTER UPDATE ON "TechnicalPractice" FOR EACH ROW EXECUTE FUNCTION fai_record_update_capture();

-- Retention and read-state semantics are enforced independently of the UI.
CREATE FUNCTION fai_record_update_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'RECORD_UPDATE_IMMUTABLE'; END $$;
CREATE TRIGGER record_update_event_immutable BEFORE UPDATE OR DELETE ON "RecordUpdateEvent"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_immutable();
CREATE TRIGGER record_update_command_immutable BEFORE UPDATE OR DELETE ON "RecordUpdateCommand"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_immutable();
CREATE TRIGGER record_update_rule_retention BEFORE DELETE ON "RecordUpdateRule"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_immutable();
CREATE FUNCTION fai_record_update_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'readAt') IS DISTINCT FROM (to_jsonb(OLD)-'readAt')
  OR (OLD."readAt" IS NOT NULL AND NEW."readAt" IS DISTINCT FROM OLD."readAt")
  OR NEW."readAt" IS NULL OR NEW."readAt">clock_timestamp() THEN
  RAISE EXCEPTION 'RECORD_UPDATE_DELIVERY_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_update_delivery_guard BEFORE UPDATE OR DELETE ON "RecordUpdateDelivery"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_delivery_guard();

-- Only completed communications produce a minimal event. Drafts, refusals,
-- uncertain sends and unassociated incoming messages do not notify anyone.
CREATE FUNCTION fai_record_update_communication() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF m.id IS NULL THEN RETURN NEW; END IF;
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
CREATE TRIGGER record_update_sent_communication AFTER INSERT OR UPDATE ON "ApprovedCommunication"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_communication();
CREATE TRIGGER record_update_linked_reply AFTER INSERT OR UPDATE ON "CommunicationReply"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_communication();
CREATE TRIGGER record_update_used_internal_note AFTER INSERT OR UPDATE ON "PracticeCommunication"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_communication();
COMMIT;
