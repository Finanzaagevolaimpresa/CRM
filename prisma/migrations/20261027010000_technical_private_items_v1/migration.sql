-- Private creation is separate from assignment. No grants or content backfill.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>68
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261024190000_technical_document_acquisition_v1'
 AND checksum='9ac78fa51a45db97d38725d0df8dd17812abfcf60acbbf6de7f70cd7e0f4d4f9'
 AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 OR EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL
 AND migration_name<>'20261027010000_technical_private_items_v1')
 THEN RAISE EXCEPTION 'TECHNICAL_PRIVATE_ITEM_SCHEMA68_REQUIRED'; END IF;
END $$;

-- A marker on the canonical row permits exclusion in the same SQL snapshot,
-- before ordinary limits/counts. It cannot be added to old rows or cleared.
ALTER TABLE "Task" ADD COLUMN "technicalPrivate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DocumentChecklistItem" ADD COLUMN "technicalPrivate" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "TechnicalPrivateItemOrigin" (
 kind TEXT NOT NULL CHECK(kind IN ('Task','ChecklistItem')),
 "itemId" TEXT NOT NULL CHECK("itemId" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
 "commandId" UUID NOT NULL UNIQUE,
 "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sessionId" UUID NOT NULL,
 command JSONB NOT NULL CHECK(jsonb_typeof(command)='object'),
 admission JSONB NOT NULL CHECK(jsonb_typeof(admission)='object'),
 origin JSONB NOT NULL CHECK(jsonb_typeof(origin)='object'),
 "originProof" TEXT NOT NULL CHECK("originProof" ~ '^[a-f0-9]{64}$'),
 receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 "receiptProof" TEXT NOT NULL CHECK("receiptProof" ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMP(3) NOT NULL,
 "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
 PRIMARY KEY(kind,"itemId")
);
CREATE INDEX "TechnicalPrivateItemOrigin_actor_created_idx" ON "TechnicalPrivateItemOrigin"("actorId","createdAt");
CREATE TRIGGER technical_private_origin_retained BEFORE UPDATE OR DELETE ON "TechnicalPrivateItemOrigin"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_private_origin_no_truncate BEFORE TRUNCATE ON "TechnicalPrivateItemOrigin"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_technical_assignment_retained();
-- Retain the exact minimal creation audit even if another statement is issued
-- later in the same transaction, after the immediate atomicity check.
CREATE TRIGGER technical_private_audit_retained BEFORE UPDATE OR DELETE ON "AuditLog"
 FOR EACH ROW WHEN (OLD.event='technical_item_created_private')
 EXECUTE FUNCTION fai_technical_assignment_retained();

CREATE FUNCTION fai_technical_private_marker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD."technicalPrivate" THEN RAISE EXCEPTION 'TECHNICAL_PRIVATE_ITEM_RETAINED'; END IF;
  RETURN OLD;
 END IF;
 IF NEW."technicalPrivate" IS DISTINCT FROM OLD."technicalPrivate" THEN
  RAISE EXCEPTION 'TECHNICAL_PRIVATE_ITEM_MARKER_IMMUTABLE';
 END IF;
 IF OLD."technicalPrivate" AND (NEW.id IS DISTINCT FROM OLD.id
  OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
  OR NEW."clientServiceId" IS DISTINCT FROM OLD."clientServiceId" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
  OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  OR (TG_TABLE_NAME='Task' AND (to_jsonb(NEW)->'assignedToId' IS DISTINCT FROM 'null'::jsonb
    OR to_jsonb(NEW)->'companyId' IS DISTINCT FROM to_jsonb(OLD)->'companyId')))
 THEN RAISE EXCEPTION 'TECHNICAL_PRIVATE_ITEM_ORIGIN_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_private_marker_guard BEFORE UPDATE OR DELETE ON "Task"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_private_marker_guard();
CREATE TRIGGER checklist_private_marker_guard BEFORE UPDATE OR DELETE ON "DocumentChecklistItem"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_private_marker_guard();

CREATE FUNCTION fai_technical_private_creation_required() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_kind text:=CASE TG_TABLE_NAME WHEN 'Task' THEN 'Task' ELSE 'ChecklistItem' END;
BEGIN
 IF NEW."technicalPrivate" AND NOT EXISTS(SELECT 1 FROM "TechnicalPrivateItemOrigin"
  WHERE kind=item_kind AND "itemId"=NEW.id AND "transactionId"=txid_current())
 THEN RAISE EXCEPTION 'TECHNICAL_PRIVATE_ITEM_ORIGIN_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER task_private_origin_required AFTER INSERT ON "Task"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_private_creation_required();
CREATE CONSTRAINT TRIGGER checklist_private_origin_required AFTER INSERT ON "DocumentChecklistItem"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_private_creation_required();

CREATE FUNCTION fai_technical_private_creation_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c jsonb:=NEW.command; a jsonb:=NEW.admission; o jsonb:=NEW.origin; r jsonb:=NEW.receipt;
 row_json jsonb; row_tx bigint; g "TechnicalWorkItemGeneration"%ROWTYPE; log "AuditLog"%ROWTYPE;
 authority "TechnicalAssignmentAuthority"%ROWTYPE; actor "User"%ROWTYPE; request_hash text;
BEGIN
 IF NEW.kind='Task' THEN
  SELECT to_jsonb(t),xmin::text::bigint INTO row_json,row_tx FROM "Task" t WHERE id=NEW."itemId";
 ELSE
  SELECT to_jsonb(t),xmin::text::bigint INTO row_json,row_tx FROM "DocumentChecklistItem" t WHERE id=NEW."itemId";
 END IF;
 SELECT * INTO g FROM "TechnicalWorkItemGeneration" WHERE kind=NEW.kind AND "itemId"=NEW."itemId";
 SELECT * INTO log FROM "AuditLog" WHERE id=NEW."commandId"::text;
 SELECT * INTO authority FROM "TechnicalAssignmentAuthority" WHERE id='technical-assignment';
 SELECT * INTO actor FROM "User" WHERE id=NEW."actorId";
 request_hash:=encode(sha256(convert_to(canonicalize_ai_execution_jsonb_v2(
  jsonb_build_object('protocol','TECHNICAL_PRIVATE_ITEM_REQUEST_V1','command',c)),'UTF8')),'hex');
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'serializable'
 OR NEW."transactionId"<>txid_current() OR row_tx IS DISTINCT FROM (txid_current()%4294967296)
 OR row_json IS NULL OR row_json->'technicalPrivate' IS DISTINCT FROM 'true'::jsonb
 OR g.generation IS DISTINCT FROM 1 OR g."scopeGeneration" IS DISTINCT FROM 1
 OR authority.id IS NULL OR NOT authority.enabled OR authority."userId"<>NEW."actorId"
 OR actor.id IS NULL OR NOT actor.active OR actor."deletedAt" IS NOT NULL OR actor.role::text<>'admin'
 OR authority.revision IS DISTINCT FROM (a->>'authorityRevision')::integer
 OR actor."recordUpdateEpoch" IS DISTINCT FROM (a->>'actorEpoch')::integer
 OR a->>'authorityId' IS DISTINCT FROM 'technical-assignment' OR a->>'authorityUserId' IS DISTINCT FROM NEW."actorId"
 OR a->>'actorId' IS DISTINCT FROM NEW."actorId" OR a->>'sessionId' IS DISTINCT FROM NEW."sessionId"::text
 OR a->>'role' IS DISTINCT FROM 'admin' OR a->'authorityEnabled' IS DISTINCT FROM 'true'::jsonb
 OR a->'managerAllowed' IS DISTINCT FROM 'true'::jsonb OR a->'serviceWriteAllowed' IS DISTINCT FROM 'true'::jsonb
 OR a->'targetOperational' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(a->'sessionExpiresAt') IS DISTINCT FROM 'number'
 OR jsonb_typeof(a->'personalProofExpiresAt') IS DISTINCT FROM 'number'
 OR COALESCE((a->>'keyVersion')::integer,0)<1
 OR NOT EXISTS(SELECT 1 FROM "InternalSession" s WHERE s.id=NEW."sessionId" AND s."userId"=NEW."actorId"
  AND s."revokedAt" IS NULL AND (s."expiresAt" AT TIME ZONE 'UTC')>clock_timestamp()
  AND (s."expiresAt" AT TIME ZONE 'UTC')>=to_timestamp((a->>'sessionExpiresAt')::double precision/1000))
 OR EXISTS(SELECT 1 FROM "UserPermissionOverride" p WHERE p."userId"=NEW."actorId" AND p.permission='service.write' AND NOT p.allowed)
 OR clock_timestamp()>=to_timestamp((a->>'sessionExpiresAt')::double precision/1000)
 OR clock_timestamp()>=to_timestamp((a->>'personalProofExpiresAt')::double precision/1000)
 OR c IS DISTINCT FROM jsonb_build_object('commandId',NEW."commandId"::text,'itemId',NEW."itemId",'kind',NEW.kind,
  'target',a->'target','expectedContextSha256',a->>'contextSha256','values',c->'values')
 OR COALESCE(c->'target'->>'kind','') NOT IN ('Project','TechnicalPractice')
 OR COALESCE(c->'target'->>'targetId','') !~ '^[A-Za-z0-9_-]{1,128}$'
 OR COALESCE(a->>'contextSha256','') !~ '^[a-f0-9]{64}$'
 OR COALESCE(length(c->'values'->>'title'),0) NOT BETWEEN 1 AND 200
 OR COALESCE(a->'parent'->>'clientId','') !~ '^[A-Za-z0-9_-]{1,128}$'
 OR o IS DISTINCT FROM jsonb_build_object('protocol','TECHNICAL_PRIVATE_ITEM_ORIGIN_V1','commandId',NEW."commandId"::text,
  'kind',NEW.kind,'itemId',NEW."itemId",'target',c->'target','clientId',a->'parent'->'clientId',
  'projectId',a->'parent'->'projectId','serviceId',a->'parent'->'serviceId','companyId',a->'parent'->'companyId',
  'actorId',NEW."actorId",'createdAt',r->>'recordedAt')
 OR r IS DISTINCT FROM jsonb_build_object('protocol','TECHNICAL_PRIVATE_ITEM_RECEIPT_V1',
  'commandId',NEW."commandId"::text,'itemId',NEW."itemId",'kind',NEW.kind,'target',c->'target',
  'actorId',NEW."actorId",'sessionId',NEW."sessionId"::text,'authorityRevision',authority.revision,
  'keyVersion',(a->>'keyVersion')::integer,'requestDigest',request_hash,
  'admissionSha256',encode(sha256(convert_to(canonicalize_ai_execution_jsonb_v2(a),'UTF8')),'hex'),'recordedAt',r->>'recordedAt',
  'grantCreated',false,'notificationCreated',false)
 OR (r->>'recordedAt')::timestamptz IS DISTINCT FROM (NEW."createdAt" AT TIME ZONE 'UTC')
 OR (row_json->>'createdAt')::timestamp IS DISTINCT FROM NEW."createdAt"
 OR (row_json->>'updatedAt')::timestamp IS DISTINCT FROM NEW."createdAt"
 OR row_json->'clientId' IS DISTINCT FROM a->'parent'->'clientId'
 OR row_json->'projectId' IS DISTINCT FROM a->'parent'->'projectId'
 OR row_json->'clientServiceId' IS DISTINCT FROM a->'parent'->'serviceId'
 OR row_json->>'createdById' IS DISTINCT FROM NEW."actorId" OR row_json->'deletedAt' IS DISTINCT FROM 'null'::jsonb
 OR row_json->'title' IS DISTINCT FROM c->'values'->'title'
 OR (NEW.kind='Task' AND (c->'values' IS DISTINCT FROM jsonb_build_object('title',c->'values'->'title',
   'description',c->'values'->'description','priority',c->'values'->'priority','dueAt',c->'values'->'dueAt')
  OR row_json->'companyId' IS DISTINCT FROM a->'parent'->'companyId'
  OR row_json->'description' IS DISTINCT FROM c->'values'->'description'
  OR row_json->'priority' IS DISTINCT FROM c->'values'->'priority'
  OR (row_json->>'dueAt')::timestamp IS DISTINCT FROM ((c->'values'->>'dueAt')::timestamptz AT TIME ZONE 'UTC')
  OR row_json->>'status' IS DISTINCT FROM 'aperta' OR row_json->'assignedToId' IS DISTINCT FROM 'null'::jsonb
  OR row_json->'completedAt' IS DISTINCT FROM 'null'::jsonb OR row_json->'type' IS DISTINCT FROM 'null'::jsonb))
 OR (NEW.kind='ChecklistItem' AND (c->'values' IS DISTINCT FROM jsonb_build_object('title',c->'values'->'title','notes',c->'values'->'notes')
  OR row_json->'notes' IS DISTINCT FROM c->'values'->'notes' OR row_json->>'status' IS DISTINCT FROM 'da_richiedere'
  OR row_json->'documentId' IS DISTINCT FROM 'null'::jsonb OR row_json->'active' IS DISTINCT FROM 'true'::jsonb
  OR row_json->>'updatedById' IS DISTINCT FROM NEW."actorId"))
 OR log.id IS NULL OR log."actorId" IS DISTINCT FROM NEW."actorId" OR log.event<>'technical_item_created_private'
 OR log."entityType"<>'TechnicalPrivateItemOrigin' OR log."entityId"<>NEW."commandId"::text
 OR log."before" IS DISTINCT FROM '{}'::jsonb
 OR log."after" IS DISTINCT FROM jsonb_build_object('action','create_private_item','type',NEW.kind)
 OR log."createdAt" IS DISTINCT FROM NEW."createdAt"
 OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=NEW."commandId"::text AND x.xmin::text::bigint=(txid_current()%4294967296))
 THEN RAISE EXCEPTION 'TECHNICAL_PRIVATE_ITEM_ATOMIC_CREATION'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER technical_private_creation_atomic AFTER INSERT ON "TechnicalPrivateItemOrigin"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_private_creation_atomic();
COMMIT;
