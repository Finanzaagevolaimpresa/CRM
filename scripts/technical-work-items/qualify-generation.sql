\set ON_ERROR_STOP on
-- Future CI qualification only. Never call this on production or via a local DB
-- launcher. ROLLBACK discards all fixture rows, DDL and generated epochs.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL fai.technical_work_item_qualification='FAI_CRM_SYNTHETIC_GENERATION_ONLY_V1';
DO $$ BEGIN
 IF current_database()<>'fai_crm_test'
 OR shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database')
    IS DISTINCT FROM 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1'
 THEN RAISE EXCEPTION 'TECHNICAL_WORK_ITEM_SYNTHETIC_DATABASE_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM "Task" WHERE id IN ('synthetic-work-item-generation-fixture','synthetic-work-item-generation-renamed'))
 OR EXISTS(SELECT 1 FROM "DocumentChecklistItem" WHERE id='synthetic-work-item-generation-fixture')
 THEN RAISE EXCEPTION 'TECHNICAL_WORK_ITEM_FIXTURE_COLLISION'; END IF;
END $$;
CREATE TEMP TABLE work_item_before AS
 SELECT 'Task'::text AS kind,id,to_jsonb(t) AS bytes FROM "Task" t
 UNION ALL SELECT 'ChecklistItem',id,to_jsonb(c) FROM "DocumentChecklistItem" c;
\ir generation-draft.sql
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM work_item_before x LEFT JOIN "TechnicalWorkItemGeneration" g
   ON g.kind=x.kind AND g."itemId"=x.id WHERE g.generation IS DISTINCT FROM 1 OR g."scopeGeneration" IS DISTINCT FROM 1)
 OR (SELECT count(*) FROM "TechnicalWorkItemGeneration")<>(SELECT count(*) FROM work_item_before)
 OR EXISTS(SELECT 1 FROM work_item_before x JOIN "Task" t ON x.kind='Task' AND t.id=x.id WHERE x.bytes<>to_jsonb(t))
 OR EXISTS(SELECT 1 FROM work_item_before x JOIN "DocumentChecklistItem" c
   ON x.kind='ChecklistItem' AND c.id=x.id WHERE x.bytes<>to_jsonb(c))
 THEN RAISE EXCEPTION 'GENERATION_BACKFILL_CHANGED_CANONICAL_BYTES'; END IF;
END $$;
INSERT INTO "Task"(id,title,"updatedAt") VALUES('synthetic-work-item-generation-fixture','Synthetic task',now());
INSERT INTO "DocumentChecklistItem"(id,"clientId",title,"updatedAt")
 VALUES('synthetic-work-item-generation-fixture','synthetic-client','Synthetic checklist',now());
UPDATE "Task" SET title='Changed' WHERE id='synthetic-work-item-generation-fixture';
UPDATE "Task" SET title=title WHERE id='synthetic-work-item-generation-fixture';
DO $$ BEGIN
 IF (SELECT generation FROM "TechnicalWorkItemGeneration" WHERE kind='Task' AND "itemId"='synthetic-work-item-generation-fixture')<>2
 OR (SELECT "scopeGeneration" FROM "TechnicalWorkItemGeneration" WHERE kind='Task' AND "itemId"='synthetic-work-item-generation-fixture')<>1
 OR (SELECT generation FROM "TechnicalWorkItemGeneration" WHERE kind='ChecklistItem' AND "itemId"='synthetic-work-item-generation-fixture')<>1
 THEN RAISE EXCEPTION 'GENERATION_KIND_ISOLATION_OR_NOOP'; END IF;
END $$;
UPDATE "Task" SET "dueAt"='2026-11-01T10:00:00Z' WHERE id='synthetic-work-item-generation-fixture';
DELETE FROM "Task" WHERE id='synthetic-work-item-generation-fixture';
INSERT INTO "Task"(id,title,"updatedAt") VALUES('synthetic-work-item-generation-fixture','Reinserted',now());
DO $$ BEGIN
 IF (SELECT generation FROM "TechnicalWorkItemGeneration" WHERE kind='Task' AND "itemId"='synthetic-work-item-generation-fixture')<>5
 OR (SELECT "scopeGeneration" FROM "TechnicalWorkItemGeneration" WHERE kind='Task' AND "itemId"='synthetic-work-item-generation-fixture')<>3
 THEN RAISE EXCEPTION 'GENERATION_IDENTITY_REUSE_RESET'; END IF;
END $$;
UPDATE "Task" SET id='synthetic-work-item-generation-renamed' WHERE id='synthetic-work-item-generation-fixture';
DO $$ BEGIN
 IF (SELECT generation FROM "TechnicalWorkItemGeneration" WHERE kind='Task' AND "itemId"='synthetic-work-item-generation-fixture')<>6
 OR (SELECT "scopeGeneration" FROM "TechnicalWorkItemGeneration" WHERE kind='Task' AND "itemId"='synthetic-work-item-generation-fixture')<>4
 OR (SELECT generation FROM "TechnicalWorkItemGeneration" WHERE kind='Task' AND "itemId"='synthetic-work-item-generation-renamed')<>1
 THEN RAISE EXCEPTION 'GENERATION_RENAME_RESET'; END IF;
END $$;
UPDATE "DocumentChecklistItem" SET status='richiesto' WHERE id='synthetic-work-item-generation-fixture';
UPDATE "DocumentChecklistItem" SET "documentId"='synthetic-document' WHERE id='synthetic-work-item-generation-fixture';
UPDATE "DocumentChecklistItem" SET "clientId"='synthetic-other-client' WHERE id='synthetic-work-item-generation-fixture';
UPDATE "DocumentChecklistItem" SET active=false WHERE id='synthetic-work-item-generation-fixture';
UPDATE "DocumentChecklistItem" SET "deletedAt"=now() WHERE id='synthetic-work-item-generation-fixture';
DO $$ BEGIN
 IF (SELECT generation FROM "TechnicalWorkItemGeneration" WHERE kind='ChecklistItem' AND "itemId"='synthetic-work-item-generation-fixture')<>6
 OR (SELECT "scopeGeneration" FROM "TechnicalWorkItemGeneration" WHERE kind='ChecklistItem' AND "itemId"='synthetic-work-item-generation-fixture')<>6
 THEN RAISE EXCEPTION 'GENERATION_RELATION_LIFECYCLE_NOT_TRACKED'; END IF;
END $$;
UPDATE "DocumentChecklistItem" SET status='da_richiedere',"documentId"=NULL,"clientId"='synthetic-client',
 active=true,"deletedAt"=NULL WHERE id='synthetic-work-item-generation-fixture';
DO $$ BEGIN
 IF (SELECT "scopeGeneration" FROM "TechnicalWorkItemGeneration"
  WHERE kind='ChecklistItem' AND "itemId"='synthetic-work-item-generation-fixture')<>7
 THEN RAISE EXCEPTION 'GENERATION_RESTORED_CONTEXT_RESURRECTED_SCOPE'; END IF;
END $$;
DO $$
DECLARE op text; rejected boolean;
BEGIN
 FOREACH op IN ARRAY ARRAY[
   'UPDATE "TechnicalWorkItemGeneration" SET generation=1',
   'DELETE FROM "TechnicalWorkItemGeneration"',
   'TRUNCATE "TechnicalWorkItemGeneration"',
   'INSERT INTO "TechnicalWorkItemGeneration"(kind,"itemId") VALUES(''Task'',''synthetic-forged'')'
 ] LOOP
  rejected:=false;
  BEGIN EXECUTE op;
  EXCEPTION WHEN OTHERS THEN
   IF SQLERRM<>'TECHNICAL_WORK_ITEM_GENERATION_PROTECTED' THEN RAISE; END IF;
   rejected:=true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'GENERATION_DIRECT_WRITE_ADMITTED'; END IF;
 END LOOP;
END $$;
DO $$ BEGIN
 BEGIN
  UPDATE "Task" SET title='Must roll back' WHERE id='synthetic-work-item-generation-renamed';
  RAISE EXCEPTION 'SYNTHETIC_LATE_FAILURE';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM<>'SYNTHETIC_LATE_FAILURE' THEN RAISE; END IF;
 END;
 IF (SELECT title FROM "Task" WHERE id='synthetic-work-item-generation-renamed')<>'Reinserted'
 OR (SELECT generation FROM "TechnicalWorkItemGeneration" WHERE kind='Task' AND "itemId"='synthetic-work-item-generation-renamed')<>1
 THEN RAISE EXCEPTION 'GENERATION_NOT_ATOMIC_WITH_CANONICAL_WRITE'; END IF;
END $$;
SELECT json_build_object('synthetic',true,'canonicalBytesPreserved',true,
 'kindIsolation',true,'identityReuseMonotone',true,'renameTracked',true,'relationsAndLifecycleTracked',true,
 'retainedScopeCannotResurrect',true,
 'directWritesDenied',true,'lateFailureAtomic',true,'productionContact',false) AS qualification;
ROLLBACK;
