-- Synthetic proposal only. Not a Prisma migration and never applied to production.
-- The runner must first assert the ephemeral database identity and schema69.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'fai_crm_test' OR
   (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
    IS DISTINCT FROM 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1' THEN
  RAISE EXCEPTION 'REMINDER_EPHEMERAL_DATABASE_REQUIRED';
 END IF;
END $$;
ALTER TABLE "RecordUpdateCommand" DROP CONSTRAINT "RecordUpdateCommand_operation_check";
ALTER TABLE "RecordUpdateCommand" ADD CONSTRAINT "RecordUpdateCommand_operation_check"
 CHECK(operation IN ('UPDATE','RULE','REVOKE','REMINDER'));
CREATE TABLE "RecordUpdateReminder" (
 "commandId" UUID PRIMARY KEY REFERENCES "RecordUpdateCommand"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "eventId" UUID NOT NULL UNIQUE REFERENCES "RecordUpdateEvent"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "auditId" TEXT NOT NULL UNIQUE REFERENCES "AuditLog"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "taskId" TEXT NOT NULL REFERENCES "Task"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "availableAt" TIMESTAMPTZ(3) NOT NULL,
 "confirmedAt" TIMESTAMPTZ(3) NOT NULL,
 "keyVersion" INTEGER NOT NULL CHECK("keyVersion">0),
 journal JSONB NOT NULL CHECK(jsonb_typeof(journal)='object'),
 proof CHAR(64) NOT NULL CHECK(proof ~ '^[a-f0-9]{64}$'),
 CHECK("availableAt">"confirmedAt")
);
CREATE INDEX "RecordUpdateReminder_taskId_confirmedAt_idx" ON "RecordUpdateReminder"("taskId","confirmedAt");
CREATE TRIGGER record_reminder_immutable BEFORE UPDATE OR DELETE ON "RecordUpdateReminder"
 FOR EACH ROW EXECUTE FUNCTION fai_record_update_immutable();
CREATE TRIGGER record_reminder_no_truncate BEFORE TRUNCATE ON "RecordUpdateReminder"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_record_update_immutable();

CREATE FUNCTION fai_record_reminder_deferred_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command_id uuid; r "RecordUpdateReminder"%ROWTYPE; c "RecordUpdateCommand"%ROWTYPE;
 e "RecordUpdateEvent"%ROWTYPE; a "AuditLog"%ROWTYPE; p jsonb; wanted jsonb; delivered jsonb; expected_audit jsonb;
BEGIN
 IF TG_TABLE_NAME='RecordUpdateCommand' THEN
  IF NEW.operation<>'REMINDER' THEN RETURN NEW; END IF;
  command_id:=NEW.id;
 ELSIF TG_TABLE_NAME='RecordUpdateEvent' THEN
  IF NEW."sourceKey" IS NULL OR NEW."sourceKey" NOT LIKE 'record-reminder:%' THEN RETURN NEW; END IF;
  command_id:=substring(NEW."sourceKey" from 17)::uuid;
 ELSE command_id:=NEW."commandId"; END IF;
 SELECT * INTO c FROM "RecordUpdateCommand" WHERE id=command_id;
 IF c.operation IS DISTINCT FROM 'REMINDER' THEN
  IF TG_TABLE_NAME='RecordUpdateDelivery' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'RECORD_REMINDER_COMMAND_REQUIRED';
 END IF;
 SELECT * INTO r FROM "RecordUpdateReminder" WHERE "commandId"=command_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'RECORD_REMINDER_JOURNAL_REQUIRED'; END IF;
 SELECT * INTO e FROM "RecordUpdateEvent" WHERE id=r."eventId";
 SELECT * INTO a FROM "AuditLog" WHERE id=r."auditId";
 p:=r.journal->'prepared';
 IF r.journal->>'protocol' IS DISTINCT FROM 'FAI_RECORD_REMINDER_JOURNAL_V1'
  OR r.journal->>'commandId' IS DISTINCT FROM command_id::text
  OR r.journal->>'eventId' IS DISTINCT FROM r."eventId"::text
  OR r.journal->>'auditId' IS DISTINCT FROM r."auditId"
  OR (r.journal->>'keyVersion')::int IS DISTINCT FROM r."keyVersion"
  OR (r.journal->>'confirmedAt')::timestamptz IS DISTINCT FROM r."confirmedAt"
  OR (r.journal->>'transactionId')::bigint IS DISTINCT FROM txid_current()
  OR c."transactionId"<>txid_current() OR c."createdAt"<>r."confirmedAt"
  OR r.journal->>'commandDigest' IS DISTINCT FROM c.digest::text
  OR p->>'protocol' IS DISTINCT FROM 'FAI_RECORD_REMINDER_V1'
  OR p->'input'->>'commandId' IS DISTINCT FROM command_id::text
  OR p->'input'->>'kind' IS DISTINCT FROM c.kind
  OR p->'input'->>'recordId' IS DISTINCT FROM c."recordId"
  OR p->'input'->>'taskId' IS DISTINCT FROM r."taskId"
  OR (p->'input'->>'remindAt')::timestamptz IS DISTINCT FROM r."availableAt"
  OR p->'input'->>'mode' IS DISTINCT FROM 'CRM' OR c.mode<>'CRM' OR c."emailAuthorityRevision" IS NOT NULL
  OR p->>'authorId' IS DISTINCT FROM c."actorId" OR (p->>'authorEpoch')::int IS DISTINCT FROM c."actorEpoch"
  OR p->'source' IS DISTINCT FROM c.scope OR p->'input'->'selection' IS DISTINCT FROM c.selection
  OR p->>'directoryBinding' IS DISTINCT FROM c."directoryBinding"::text
  OR p->>'eventKey' IS DISTINCT FROM e."sourceKey"
  OR e."sourceKey" IS DISTINCT FROM 'record-reminder:'||command_id::text
  OR e.kind IS DISTINCT FROM c.kind OR e."recordId" IS DISTINCT FROM c."recordId"
  OR e.scope IS DISTINCT FROM c.scope OR e.event IS DISTINCT FROM 'DEADLINE'
  OR e.changed IS DISTINCT FROM '["dueDate"]'::jsonb OR e."occurredAt" IS DISTINCT FROM r."confirmedAt"
  OR p->'summary' IS DISTINCT FROM '{"event":"DEADLINE","changed":["dueDate"]}'::jsonb
  OR p->'policyExpiresAt' IS DISTINCT FROM 'null'::jsonb
 THEN RAISE EXCEPTION 'RECORD_REMINDER_JOURNAL_MISMATCH'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',x->>'id','epoch',(x->>'epoch')::int) ORDER BY x->>'id')
  INTO wanted FROM jsonb_array_elements(p->'recipients') x;
 SELECT jsonb_agg(jsonb_build_object('id',d."recipientId",'epoch',d."recipientEpoch") ORDER BY d."recipientId")
  INTO delivered FROM "RecordUpdateDelivery" d WHERE d."eventId"=e.id;
 IF wanted IS NULL OR jsonb_array_length(wanted) NOT BETWEEN 1 AND 20 OR wanted IS DISTINCT FROM c.recipients
  OR delivered IS DISTINCT FROM wanted
  OR EXISTS(SELECT 1 FROM "RecordUpdateDelivery" d WHERE (d."eventId"=e.id OR d."commandId"=command_id)
    AND (d."commandId" IS DISTINCT FROM command_id OR d."eventId"<>e.id OR d.mode<>'CRM'
      OR d."ruleId" IS NOT NULL OR d."ruleVersion" IS NOT NULL OR d."readAt" IS NOT NULL
      OR d.xmin::text::bigint<>(txid_current()%4294967296)))
 THEN RAISE EXCEPTION 'RECORD_REMINDER_DELIVERIES_MISMATCH'; END IF;
 expected_audit:="audit_sanitize_json_n04_v1"(jsonb_build_object('type','RECORD_REMINDER_V1',
   'recordId',command_id::text,'count',jsonb_array_length(wanted)));
 IF a."actorId" IS DISTINCT FROM c."actorId" OR a.event IS DISTINCT FROM 'record_reminder_scheduled'
  OR a."entityType" IS DISTINCT FROM 'RecordUpdateCommand' OR a."entityId" IS DISTINCT FROM command_id::text
  OR (a."createdAt" AT TIME ZONE 'UTC') IS DISTINCT FROM r."confirmedAt" OR a."before" IS NOT NULL
  OR a."after" IS DISTINCT FROM expected_audit
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=a.id AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR NOT EXISTS(SELECT 1 FROM "RecordUpdateCommand" x WHERE x.id=c.id AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR NOT EXISTS(SELECT 1 FROM "RecordUpdateEvent" x WHERE x.id=e.id AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR NOT EXISTS(SELECT 1 FROM "Task" t JOIN "TechnicalWorkItemGeneration" g ON g.kind='Task' AND g."itemId"=t.id
    WHERE t.id=r."taskId" AND t."deletedAt" IS NULL AND t.status IN ('aperta','in_lavorazione')
     AND t."dueAt"=(p->'source'->>'dueAt')::timestamptz
     AND g.generation=(p->'source'->>'generation')::int
     AND g."scopeGeneration"=(p->'source'->>'scopeGeneration')::int)
 THEN RAISE EXCEPTION 'RECORD_REMINDER_ATOMIC_EVIDENCE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER record_reminder_command_deferred AFTER INSERT ON "RecordUpdateCommand"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_record_reminder_deferred_guard();
CREATE CONSTRAINT TRIGGER record_reminder_event_deferred AFTER INSERT ON "RecordUpdateEvent"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_record_reminder_deferred_guard();
CREATE CONSTRAINT TRIGGER record_reminder_delivery_deferred AFTER INSERT ON "RecordUpdateDelivery"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_record_reminder_deferred_guard();
CREATE CONSTRAINT TRIGGER record_reminder_journal_deferred AFTER INSERT ON "RecordUpdateReminder"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_record_reminder_deferred_guard();
CREATE FUNCTION fai_record_reminder_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='AuditLog' THEN
  IF EXISTS(SELECT 1 FROM "RecordUpdateReminder" WHERE "auditId"=OLD.id) THEN
   RAISE EXCEPTION 'RECORD_REMINDER_AUDIT_IMMUTABLE';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND NEW."readAt" IS NOT NULL AND EXISTS(SELECT 1 FROM "RecordUpdateReminder" r
   WHERE r."commandId"=OLD."commandId" AND NEW."readAt"<r."availableAt") THEN
  RAISE EXCEPTION 'RECORD_REMINDER_NOT_AVAILABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_reminder_audit_retained BEFORE UPDATE OR DELETE ON "AuditLog"
 FOR EACH ROW EXECUTE FUNCTION fai_record_reminder_retention_guard();
CREATE TRIGGER record_reminder_read_time BEFORE UPDATE ON "RecordUpdateDelivery"
 FOR EACH ROW EXECUTE FUNCTION fai_record_reminder_retention_guard();
COMMIT;
