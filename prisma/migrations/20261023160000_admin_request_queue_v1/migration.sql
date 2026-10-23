-- Empty private queue. No recipients, grants, bindings, messages or scheduler.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>64
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261022200000_technical_assignments_v1'
   AND checksum='9b3a7b1cab3cd97df9c110bff4b7590f7bee8acaabe7e985e3bfbfba3f5b7583'
   AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 OR EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL
   AND migration_name<>'20261023160000_admin_request_queue_v1')
 THEN RAISE EXCEPTION 'ADMIN_REQUEST_SCHEMA64_REQUIRED'; END IF;
END $$;

CREATE TABLE "AdminRequest" (
 id UUID PRIMARY KEY, "authorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sessionId" UUID NOT NULL, kind VARCHAR(17) NOT NULL CHECK(kind IN ('Lead','Client','Project','TechnicalPractice')),
 "leadId" TEXT REFERENCES "Lead"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "clientId" TEXT REFERENCES "Client"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "projectId" TEXT REFERENCES "Project"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "practiceId" TEXT REFERENCES "TechnicalPractice"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 revision INTEGER NOT NULL CHECK(revision>0), state JSONB NOT NULL,
 "stateHash" TEXT NOT NULL CHECK("stateHash" ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(num_nonnulls("leadId","clientId","projectId","practiceId")=1),
 CHECK((kind='Lead' AND "leadId" IS NOT NULL) OR (kind='Client' AND "clientId" IS NOT NULL)
  OR (kind='Project' AND "projectId" IS NOT NULL) OR (kind='TechnicalPractice' AND "practiceId" IS NOT NULL)),
 CHECK((state->>'requestId'=id::text AND state->>'authorId'="authorId" AND state->>'sessionId'="sessionId"::text
  AND state->>'revision'=revision::text AND state->'submitted'->'subject'->>'kind'=kind
  AND state->'submitted'->'subject'->>'targetId'=COALESCE("leadId","clientId","projectId","practiceId")
  AND state->>'status' IN ('OPEN','NEEDS_INFORMATION','DRAFT_PREPARED','REJECTED','WITHDRAWN')) IS TRUE)
);
CREATE INDEX "AdminRequest_authorId_createdAt_idx" ON "AdminRequest"("authorId","createdAt",id);
CREATE TABLE "AdminRequestEvent" (
 id UUID PRIMARY KEY, "requestId" UUID NOT NULL REFERENCES "AdminRequest"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 revision INTEGER NOT NULL CHECK(revision>0), "commandId" UUID NOT NULL UNIQUE,
 "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT, "sessionId" UUID NOT NULL,
 operation VARCHAR(24) NOT NULL CHECK(operation IN ('SUBMIT','AMEND','WITHDRAW','REQUEST_INFORMATION','REJECT','PREPARE_DRAFT')),
 "commandHash" TEXT NOT NULL CHECK("commandHash" ~ '^[a-f0-9]{64}$'),
 state JSONB NOT NULL, "stateHash" TEXT NOT NULL CHECK("stateHash" ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
 UNIQUE("requestId",revision)
);
CREATE TABLE "AdminRequestDraft" (
 "requestId" UUID PRIMARY KEY REFERENCES "AdminRequest"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "messageId" UUID NOT NULL UNIQUE REFERENCES "ApprovedCommunication"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sourceHash" TEXT NOT NULL CHECK("sourceHash" ~ '^[a-f0-9]{64}$'),
 "authorityRevision" INTEGER NOT NULL CHECK("authorityRevision">0),
 "createdById" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "eventId" UUID NOT NULL UNIQUE REFERENCES "AdminRequestEvent"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK("requestId"="messageId")
);
CREATE FUNCTION fai_admin_request_retained() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') OR TG_TABLE_NAME<>'AdminRequest' THEN RAISE EXCEPTION 'ADMIN_REQUEST_HISTORY_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'ADMIN_REQUEST_INITIAL_REVISION'; END IF;
 ELSE
  IF NEW.id<>OLD.id OR NEW."authorId"<>OLD."authorId" OR NEW."sessionId"<>OLD."sessionId" OR NEW.kind<>OLD.kind
   OR NEW."leadId" IS DISTINCT FROM OLD."leadId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
   OR NEW."projectId" IS DISTINCT FROM OLD."projectId" OR NEW."practiceId" IS DISTINCT FROM OLD."practiceId"
   OR NEW."createdAt"<>OLD."createdAt" OR NEW.revision<>OLD.revision+1
   OR OLD.state->>'status' IN ('DRAFT_PREPARED','REJECTED','WITHDRAWN') THEN RAISE EXCEPTION 'ADMIN_REQUEST_IDENTITY_OR_REVISION'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER admin_request_retained BEFORE INSERT OR UPDATE OR DELETE ON "AdminRequest" FOR EACH ROW EXECUTE FUNCTION fai_admin_request_retained();
CREATE TRIGGER admin_request_no_truncate BEFORE TRUNCATE ON "AdminRequest" FOR EACH STATEMENT EXECUTE FUNCTION fai_admin_request_retained();
CREATE TRIGGER admin_request_event_retained BEFORE UPDATE OR DELETE ON "AdminRequestEvent" FOR EACH ROW EXECUTE FUNCTION fai_admin_request_retained();
CREATE TRIGGER admin_request_event_no_truncate BEFORE TRUNCATE ON "AdminRequestEvent" FOR EACH STATEMENT EXECUTE FUNCTION fai_admin_request_retained();
CREATE TRIGGER admin_request_draft_retained BEFORE UPDATE OR DELETE ON "AdminRequestDraft" FOR EACH ROW EXECUTE FUNCTION fai_admin_request_retained();
CREATE TRIGGER admin_request_draft_no_truncate BEFORE TRUNCATE ON "AdminRequestDraft" FOR EACH STATEMENT EXECUTE FUNCTION fai_admin_request_retained();

CREATE FUNCTION fai_admin_request_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "AdminRequest"%ROWTYPE; e "AdminRequestEvent"%ROWTYPE; a "AuditLog"%ROWTYPE; rid uuid; rev integer;
BEGIN
 IF TG_TABLE_NAME='AdminRequest' THEN rid:=NEW.id; rev:=NEW.revision;
 ELSE rid:=NEW."requestId"; rev:=NEW.revision; END IF;
 SELECT * INTO r FROM "AdminRequest" WHERE id=rid;
 SELECT * INTO e FROM "AdminRequestEvent" WHERE "requestId"=rid AND revision=rev;
 SELECT * INTO a FROM "AuditLog" WHERE id=e.id::text;
 IF r.id IS NULL OR e.id IS NULL OR a.id IS NULL OR e."transactionId"<>txid_current()
  OR r.revision<>rev OR r.state<>e.state OR r."stateHash"<>e."stateHash"
  OR a."actorId"<>e."actorId" OR a.event<>'admin_request_changed' OR a."entityType"<>'AdminRequestEvent' OR a."entityId"<>e.id::text
  OR a.before IS DISTINCT FROM jsonb_build_object('revision',rev-1)
  OR a.after IS DISTINCT FROM jsonb_build_object('revision',rev,'operation',e.operation,'stateHash',e."stateHash")
 THEN RAISE EXCEPTION 'ADMIN_REQUEST_ATOMIC_EVENT_AUDIT_REQUIRED'; END IF;
 IF rev=1 AND (e.operation<>'SUBMIT' OR e."actorId"<>r."authorId" OR r.state->>'status'<>'OPEN')
 THEN RAISE EXCEPTION 'ADMIN_REQUEST_INITIAL_EVENT_REQUIRED'; END IF;
 IF rev>1 AND NOT EXISTS(SELECT 1 FROM "AdminRequestEvent" WHERE "requestId"=rid AND revision=rev-1)
 THEN RAISE EXCEPTION 'ADMIN_REQUEST_CONTIGUOUS_HISTORY_REQUIRED'; END IF;
 IF (r.state->>'status'='DRAFT_PREPARED') IS DISTINCT FROM EXISTS(SELECT 1 FROM "AdminRequestDraft" WHERE "requestId"=rid)
 THEN RAISE EXCEPTION 'ADMIN_REQUEST_DRAFT_ATOMIC_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER admin_request_atomic AFTER INSERT OR UPDATE ON "AdminRequest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_admin_request_atomic();
CREATE CONSTRAINT TRIGGER admin_request_event_atomic AFTER INSERT ON "AdminRequestEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_admin_request_atomic();
CREATE FUNCTION fai_admin_request_draft_atomic() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "AdminRequestEvent" e JOIN "AdminRequest" r ON r.id=e."requestId"
   JOIN "ApprovedCommunication" m ON m.id=NEW."messageId"
   WHERE e.id=NEW."eventId" AND e."requestId"=NEW."requestId" AND e.operation='PREPARE_DRAFT'
   AND e.revision=r.revision AND r.state->>'status'='DRAFT_PREPARED' AND e."actorId"=NEW."createdById"
   AND m."createdById"=NEW."createdById" AND e."transactionId"=txid_current()
   AND m.state='DRAFT' AND m."currentRevision"=1)
 THEN RAISE EXCEPTION 'ADMIN_REQUEST_DRAFT_ORIGIN_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER admin_request_draft_atomic AFTER INSERT ON "AdminRequestDraft" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_admin_request_draft_atomic();
COMMIT;
