CREATE TABLE "TechnicalWorkItemCommand" (
 id UUID PRIMARY KEY,
 "assignmentId" UUID NOT NULL, "assignmentRevision" INTEGER NOT NULL CHECK("assignmentRevision">0),
 "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sessionId" UUID NOT NULL, "targetKind" TEXT NOT NULL CHECK("targetKind" IN ('Project','TechnicalPractice')),
 "targetId" TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('Task','ChecklistItem')), "itemId" TEXT NOT NULL,
 "requestDigest" TEXT NOT NULL CHECK("requestDigest" ~ '^[a-f0-9]{64}$'),
 receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'), proof TEXT NOT NULL CHECK(proof ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
 FOREIGN KEY("assignmentId","assignmentRevision") REFERENCES "TechnicalAssignmentRevision"("assignmentId",revision)
 ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "TechnicalWorkItemCommand_actorId_createdAt_idx" ON "TechnicalWorkItemCommand"("actorId","createdAt");
CREATE TRIGGER technical_work_item_command_immutable BEFORE UPDATE OR DELETE ON "TechnicalWorkItemCommand"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_work_item_command_no_truncate BEFORE TRUNCATE ON "TechnicalWorkItemCommand"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_technical_assignment_retained();

CREATE FUNCTION fai_technical_work_item_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g "TechnicalAssignment"%ROWTYPE; a "AuditLog"%ROWTYPE; e "TechnicalWorkItemGeneration"%ROWTYPE;
 item_tx bigint; field_count integer; selected jsonb; selected_count integer; required_action text;
BEGIN
 SELECT * INTO g FROM "TechnicalAssignment" WHERE id=NEW."assignmentId";
 SELECT * INTO a FROM "AuditLog" WHERE id=NEW.id::text;
 SELECT * INTO e FROM "TechnicalWorkItemGeneration" WHERE kind=NEW.kind AND "itemId"=NEW."itemId";
 IF NEW.kind='Task' THEN
  SELECT xmin::text::bigint INTO item_tx FROM "Task" WHERE id=NEW."itemId";
  required_action:='manage_deadlines';
 ELSE
  SELECT xmin::text::bigint INTO item_tx FROM "DocumentChecklistItem" WHERE id=NEW."itemId";
  required_action:='manage_checklist';
 END IF;
 SELECT count(*) INTO selected_count FROM jsonb_array_elements(COALESCE(g.payload->'selection'->'workItems','[]'::jsonb)) s
  WHERE s->>'kind'=NEW.kind AND s->>'itemId'=NEW."itemId";
 SELECT s INTO selected FROM jsonb_array_elements(COALESCE(g.payload->'selection'->'workItems','[]'::jsonb)) s
  WHERE s->>'kind'=NEW.kind AND s->>'itemId'=NEW."itemId" LIMIT 1;
 field_count:=(NEW.receipt->>'fieldCount')::integer;
 IF g.id IS NULL OR a.id IS NULL OR e.kind IS NULL OR item_tx IS NULL OR field_count IS NULL
  OR field_count NOT BETWEEN 1 AND (CASE WHEN NEW.kind='Task' THEN 4 ELSE 2 END)
  OR selected_count<>1 OR jsonb_array_length(selected->'editableFields')<field_count
  OR (selected->>'scopeGeneration')::integer IS DISTINCT FROM e."scopeGeneration"
  OR NEW."transactionId"<>txid_current() OR item_tx<>(txid_current()%4294967296)
  OR NOT EXISTS(SELECT 1 FROM "TechnicalWorkItemGeneration" x WHERE x.kind=e.kind AND x."itemId"=e."itemId"
    AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR g.revision<>NEW."assignmentRevision" OR g."revokedAt" IS NOT NULL OR g."recipientId"<>NEW."actorId"
  OR g.kind<>NEW."targetKind" OR COALESCE(g."projectId",g."practiceId")<>NEW."targetId"
  OR NOT (g.payload->'selection'->'actions' ? required_action)
  OR e.generation IS DISTINCT FROM (NEW.receipt->>'itemVersion')::integer
  OR e.generation::bigint IS DISTINCT FROM (NEW.receipt->>'previousItemVersion')::bigint+1
  OR NEW.receipt IS DISTINCT FROM jsonb_build_object('protocol','TECHNICAL_WORK_ITEM_RECEIPT_V1',
    'commandId',NEW.id::text,'assignmentId',NEW."assignmentId"::text,'assignmentRevision',NEW."assignmentRevision",
    'actorId',NEW."actorId",'sessionId',NEW."sessionId"::text,
    'target',jsonb_build_object('kind',NEW."targetKind",'targetId',NEW."targetId"),
    'bindingId',NEW."assignmentId"::text,'bindingRevision',NEW."assignmentRevision",'kind',NEW.kind,'itemId',NEW."itemId",
    'action','update_fields','fieldCount',field_count,'requestDigest',NEW."requestDigest",
    'previousItemVersion',(NEW.receipt->>'previousItemVersion')::integer,'itemVersion',e.generation,
    'recordedAt',NEW.receipt->>'recordedAt','keyVersion',(g.payload->>'keyVersion')::integer)
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=NEW.id::text AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR a."actorId" IS DISTINCT FROM NEW."actorId" OR a.event<>'technical_work_item_recorded'
  OR a."entityType"<>'TechnicalWorkItemCommand' OR a."entityId"<>NEW.id::text OR a."before" IS DISTINCT FROM '{}'::jsonb
  OR a."after" IS DISTINCT FROM jsonb_build_object('action','update_fields','fieldCount',field_count)
 THEN RAISE EXCEPTION 'TECHNICAL_WORK_ITEM_ATOMIC_COMMAND'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER technical_work_item_command_atomic AFTER INSERT ON "TechnicalWorkItemCommand"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_work_item_atomic();
