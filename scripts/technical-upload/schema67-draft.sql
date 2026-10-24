-- Synthetic qualification draft only; not part of prisma/migrations and not
-- authorized for production. Empty private submissions, no Document exposure.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>66
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261024090000_technical_work_items_v1'
   AND checksum='7facd68cdc4c943554fdf3b68f2e773b9609aa02bee1b427f29b9b177c130636'
   AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 OR EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL)
 THEN RAISE EXCEPTION 'TECHNICAL_UPLOAD_SCHEMA66_REQUIRED'; END IF;
END $$;

CREATE TABLE "TechnicalUploadSubmission" (
 id UUID PRIMARY KEY, "commandId" UUID NOT NULL UNIQUE,
 "assignmentId" UUID NOT NULL, "assignmentRevision" INTEGER NOT NULL CHECK("assignmentRevision">0),
 "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sessionId" UUID NOT NULL,
 "targetKind" TEXT NOT NULL CHECK("targetKind" IN ('Project','TechnicalPractice')),
 "targetId" TEXT NOT NULL CHECK(length("targetId") BETWEEN 1 AND 128),
 "requestDigest" TEXT NOT NULL CHECK("requestDigest" ~ '^[a-f0-9]{64}$'),
 command JSONB NOT NULL CHECK(jsonb_typeof(command)='object'),
 "storageKey" TEXT NOT NULL UNIQUE CHECK("storageKey" ~ '^technical-submissions/v1/[a-f0-9]{64}/[a-f0-9]{64}$'),
 "sizeBytes" INTEGER NOT NULL CHECK("sizeBytes" BETWEEN 1 AND 26214400),
 "contentSha256" TEXT NOT NULL CHECK("contentSha256" ~ '^[a-f0-9]{64}$'),
 receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 proof TEXT NOT NULL CHECK(proof ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMP(3) NOT NULL,
 "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
 FOREIGN KEY("assignmentId","assignmentRevision") REFERENCES "TechnicalAssignmentRevision"("assignmentId",revision)
   ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "TechnicalUploadSubmission_assignment_revision_idx"
 ON "TechnicalUploadSubmission"("assignmentId","assignmentRevision",id);
CREATE INDEX "TechnicalUploadSubmission_actor_created_idx"
 ON "TechnicalUploadSubmission"("actorId","createdAt");
CREATE TRIGGER technical_upload_immutable BEFORE UPDATE OR DELETE ON "TechnicalUploadSubmission"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_upload_no_truncate BEFORE TRUNCATE ON "TechnicalUploadSubmission"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_technical_assignment_retained();

CREATE FUNCTION fai_technical_upload_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g "TechnicalAssignment"%ROWTYPE; a "AuditLog"%ROWTYPE; p jsonb;
 files bigint; bytes bigint; max_file integer; max_files integer; max_bytes bigint;
BEGIN
 -- Application lock order is directory/users/session/context/assignment before
 -- this insert. This also serializes raw competing inserts against one quota.
 SELECT * INTO g FROM "TechnicalAssignment" WHERE id=NEW."assignmentId" FOR UPDATE;
 SELECT * INTO a FROM "AuditLog" WHERE id=NEW."commandId"::text;
 IF a.id IS NULL OR a."actorId" IS DISTINCT FROM NEW."actorId"
  OR a.event IS DISTINCT FROM 'technical_upload_deposited'
  OR a."entityType" IS DISTINCT FROM 'TechnicalUploadSubmission' OR a."entityId" IS DISTINCT FROM NEW.id::text
  OR a."before" IS DISTINCT FROM '{}'::jsonb
  OR a."after" IS DISTINCT FROM jsonb_build_object('action','deposit_private_document','fileCount',1)
 THEN RAISE EXCEPTION 'TECHNICAL_UPLOAD_ATOMIC_SUBMISSION'; END IF;
 p:=g.payload->'selection'->'uploadProfile';
 max_file:=(p->>'maxFileBytes')::integer;
 max_files:=(p->>'maxFilesPerRevision')::integer;
 max_bytes:=(p->>'maxBytesPerRevision')::bigint;
 SELECT count(*),sum("sizeBytes") INTO files,bytes FROM "TechnicalUploadSubmission"
  WHERE "assignmentId"=NEW."assignmentId" AND "assignmentRevision"=NEW."assignmentRevision";
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'serializable'
  OR g.id IS NULL OR a.id IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object'
  OR max_file IS NULL OR max_file NOT BETWEEN 1 AND 26214400
  OR max_files IS NULL OR max_files NOT BETWEEN 1 AND 20
  OR max_bytes IS NULL OR max_bytes<max_file OR max_bytes>max_file::bigint*max_files
  OR p->>'visibility' IS DISTINCT FROM 'PRIVATE_PENDING_ADMIN_REVIEW'
  OR g.revision<>NEW."assignmentRevision" OR g."revokedAt" IS NOT NULL OR g."recipientId"<>NEW."actorId"
  OR g.kind<>NEW."targetKind" OR COALESCE(g."projectId",g."practiceId")<>NEW."targetId"
  OR NOT COALESCE(g.payload->'selection'->'actions' ? 'upload_document',false)
  OR NOT COALESCE(p->'formats' ? (NEW.command->'file'->>'extension'),false)
  OR NEW.command->'file'->>'extension'='.zip'
  OR NEW."sizeBytes">max_file OR files>max_files OR bytes>max_bytes
  OR (NEW."createdAt" AT TIME ZONE 'UTC')<(g.payload->>'approvedAt')::timestamptz
  OR clock_timestamp()>=(g.payload->'selection'->>'expiresAt')::timestamptz
  OR NEW.command IS DISTINCT FROM jsonb_build_object(
    'commandId',NEW."commandId"::text,'assignmentId',NEW."assignmentId"::text,
    'assignmentRevision',NEW."assignmentRevision",'expectedContextSha256',g.payload->>'contextSha256',
    'title',NEW.command->>'title','action','deposit_private_document','file',jsonb_build_object(
      'fileName',NEW.command->'file'->>'fileName','extension',NEW.command->'file'->>'extension',
      'sizeBytes',NEW."sizeBytes",'contentSha256',NEW."contentSha256",'previewMime',NEW.command->'file'->'previewMime'))
  OR COALESCE(length(NEW.command->>'title'),0) NOT BETWEEN 1 AND 200
  OR COALESCE(length(NEW.command->'file'->>'fileName'),0) NOT BETWEEN 1 AND 255
  OR regexp_replace(normalize(concat_ws(' ',NEW.command->>'title',NEW.command->'file'->>'fileName'),NFKD),'[̀-ͯ]','','g')
     ~* 'contratt|contract|incaric|pagament|payment|bonific|incass|fattur[ae]|invoice'
  OR NEW.receipt IS DISTINCT FROM jsonb_build_object(
    'protocol','TECHNICAL_UPLOAD_RECEIPT_V1','commandId',NEW."commandId"::text,'submissionId',NEW.id::text,
    'actorId',NEW."actorId",'sessionId',NEW."sessionId"::text,
    'target',jsonb_build_object('kind',NEW."targetKind",'targetId',NEW."targetId"),
    'assignmentId',NEW."assignmentId"::text,'assignmentRevision',NEW."assignmentRevision",
    'requestDigest',NEW."requestDigest",'contentSha256',NEW."contentSha256",'sizeBytes',NEW."sizeBytes",
    'status','PRIVATE_STORED','recordedAt',NEW.receipt->>'recordedAt','keyVersion',(g.payload->>'keyVersion')::integer)
  OR (NEW.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM (NEW."createdAt" AT TIME ZONE 'UTC')
  OR NEW."transactionId"<>txid_current()
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=NEW."commandId"::text
     AND x.xmin::text::bigint=(txid_current()%4294967296))
 THEN RAISE EXCEPTION 'TECHNICAL_UPLOAD_ATOMIC_SUBMISSION'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER technical_upload_atomic AFTER INSERT ON "TechnicalUploadSubmission"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_upload_atomic();
CREATE TABLE "TechnicalUploadReview" (
 "commandId" UUID PRIMARY KEY,
 "submissionCommandId" UUID NOT NULL UNIQUE REFERENCES "TechnicalUploadSubmission"("commandId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sessionId" UUID NOT NULL, command JSONB NOT NULL, receipt JSONB NOT NULL,
 proof TEXT NOT NULL CHECK(proof ~ '^[a-f0-9]{64}$'), "createdAt" TIMESTAMP(3) NOT NULL,
 "transactionId" BIGINT NOT NULL DEFAULT txid_current()
);
CREATE TRIGGER technical_upload_review_immutable BEFORE UPDATE OR DELETE ON "TechnicalUploadReview"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_upload_review_no_truncate BEFORE TRUNCATE ON "TechnicalUploadReview"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE FUNCTION fai_technical_upload_review_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "TechnicalUploadSubmission"%ROWTYPE; g "TechnicalAssignment"%ROWTYPE; a "AuditLog"%ROWTYPE;
 authority "TechnicalAssignmentAuthority"%ROWTYPE;
BEGIN
 SELECT * INTO s FROM "TechnicalUploadSubmission" WHERE "commandId"=NEW."submissionCommandId";
 SELECT * INTO g FROM "TechnicalAssignment" WHERE id=s."assignmentId" FOR UPDATE;
 SELECT * INTO a FROM "AuditLog" WHERE id=NEW."commandId"::text;
 SELECT * INTO authority FROM "TechnicalAssignmentAuthority" WHERE id='technical-assignment';
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'serializable'
 OR s.id IS NULL OR g.id IS NULL OR g.revision<>s."assignmentRevision" OR g."revokedAt" IS NOT NULL
 OR clock_timestamp()>=(g.payload->'selection'->>'expiresAt')::timestamptz
 OR authority.id IS NULL OR NOT authority.enabled OR authority."userId"<>NEW."actorId"
 OR authority.revision<>(g.payload->>'authorityRevision')::integer
 OR NEW."actorId" IS DISTINCT FROM (g.payload->>'approvedById')
 OR a.id IS NULL OR a."actorId" IS DISTINCT FROM NEW."actorId" OR a.event IS DISTINCT FROM 'technical_upload_reviewed'
 OR a."entityType" IS DISTINCT FROM 'TechnicalUploadSubmission' OR a."entityId" IS DISTINCT FROM NEW."submissionCommandId"::text
 OR a."before" IS DISTINCT FROM '{}'::jsonb
 OR a."after" IS DISTINCT FROM jsonb_build_object('status',NEW.command->>'verdict')
 OR NEW.command->>'verdict' IS NULL OR NEW.command->>'verdict' NOT IN ('APPROVE_PRIVATE','REJECT_PRIVATE')
 OR COALESCE(length(NEW.command->>'reason'),0) NOT BETWEEN 3 AND 500
 OR COALESCE(NEW.command->>'sourceSha256','') !~ '^[a-f0-9]{64}$'
 OR NEW.command IS DISTINCT FROM jsonb_build_object('commandId',NEW."commandId"::text,
   'submissionCommandId',NEW."submissionCommandId"::text,'sourceSha256',NEW.command->>'sourceSha256',
   'verdict',NEW.command->>'verdict','reason',NEW.command->>'reason')
 OR NEW.receipt IS DISTINCT FROM jsonb_build_object('protocol','TECHNICAL_UPLOAD_REVIEW_RECEIPT_V1',
   'commandId',NEW."commandId"::text,'submissionCommandId',NEW."submissionCommandId"::text,
   'actorId',NEW."actorId",'sessionId',NEW."sessionId"::text,
   'reference',jsonb_build_object('kind',s."targetKind",'targetId',s."targetId",'recipientId',s."actorId"),
   'requestDigest',NEW.receipt->>'requestDigest','verdict',NEW.command->>'verdict',
   'recordedAt',NEW.receipt->>'recordedAt','keyVersion',(g.payload->>'keyVersion')::integer)
 OR COALESCE(NEW.receipt->>'requestDigest','') !~ '^[a-f0-9]{64}$'
 OR (NEW.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM (NEW."createdAt" AT TIME ZONE 'UTC')
 OR NEW."transactionId"<>txid_current()
 OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=NEW."commandId"::text AND x.xmin::text::bigint=(txid_current()%4294967296))
 THEN RAISE EXCEPTION 'TECHNICAL_UPLOAD_ATOMIC_REVIEW'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER technical_upload_review_atomic AFTER INSERT ON "TechnicalUploadReview"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_upload_review_atomic();
COMMIT;
