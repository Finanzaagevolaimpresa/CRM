-- Canonical private acquisition: no binding, grant, file transfer or real content.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>67
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261024160000_technical_document_upload_v1'
 AND checksum='8f961cde28d543f0e515fc03898ae9edd0e67a98f373e7805ce4a7c258202d0a'
 AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 OR EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL
 AND migration_name<>'20261024190000_technical_document_acquisition_v1')
 THEN RAISE EXCEPTION 'TECHNICAL_ACQUISITION_SCHEMA67_REQUIRED'; END IF;
END $$;
CREATE TABLE "TechnicalDocumentAcquisition" (
 "commandId" UUID PRIMARY KEY,
 "submissionCommandId" UUID NOT NULL UNIQUE REFERENCES "TechnicalUploadSubmission"("commandId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "reviewCommandId" UUID NOT NULL UNIQUE REFERENCES "TechnicalUploadReview"("commandId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "documentId" TEXT NOT NULL UNIQUE REFERENCES "Document"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "versionId" TEXT NOT NULL UNIQUE REFERENCES "DocumentVersion"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sessionId" UUID NOT NULL, record JSONB NOT NULL CHECK(jsonb_typeof(record)='object'),
 "createdAt" TIMESTAMP(3) NOT NULL, "transactionId" BIGINT NOT NULL DEFAULT txid_current()
);
CREATE TRIGGER technical_acquisition_immutable BEFORE UPDATE OR DELETE ON "TechnicalDocumentAcquisition"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_assignment_retained();
CREATE TRIGGER technical_acquisition_no_truncate BEFORE TRUNCATE ON "TechnicalDocumentAcquisition"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_technical_assignment_retained();

CREATE FUNCTION fai_technical_acquisition_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "TechnicalUploadSubmission"%ROWTYPE; w "TechnicalUploadReview"%ROWTYPE;
 g "TechnicalAssignment"%ROWTYPE; authority "TechnicalAssignmentAuthority"%ROWTYPE;
 d "Document"%ROWTYPE; v "DocumentVersion"%ROWTYPE; audit "AuditLog"%ROWTYPE;
 c jsonb:=NEW.record->'command'; r jsonb:=NEW.record->'receipt'; a jsonb:=NEW.record->'admission'; category text;
BEGIN
 SELECT * INTO s FROM "TechnicalUploadSubmission" WHERE "commandId"=NEW."submissionCommandId";
 SELECT * INTO w FROM "TechnicalUploadReview" WHERE "commandId"=NEW."reviewCommandId";
 SELECT * INTO g FROM "TechnicalAssignment" WHERE id=s."assignmentId" FOR UPDATE;
 SELECT * INTO authority FROM "TechnicalAssignmentAuthority" WHERE id='technical-assignment';
 SELECT * INTO d FROM "Document" WHERE id=NEW."documentId";
 SELECT * INTO v FROM "DocumentVersion" WHERE id=NEW."versionId";
 SELECT * INTO audit FROM "AuditLog" WHERE id=NEW."commandId"::text;
 category:=CASE c->>'classification' WHEN 'TECHNICAL_DOCUMENT' THEN 'documento_tecnico' WHEN 'CONTRACT' THEN 'contratto'
  WHEN 'PAYMENT' THEN 'pagamento' WHEN 'OTHER_CONFIDENTIAL' THEN 'riservato' ELSE NULL END;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'serializable'
 OR s.id IS NULL OR w."commandId" IS NULL OR g.id IS NULL OR d.id IS NULL OR v.id IS NULL OR category IS NULL
 OR w."submissionCommandId"<>s."commandId" OR w.command->>'verdict' IS DISTINCT FROM 'APPROVE_PRIVATE'
 OR w."actorId"<>NEW."actorId" OR authority.id IS NULL OR NOT authority.enabled OR authority."userId"<>NEW."actorId"
 OR authority.revision IS DISTINCT FROM (a->>'authorityRevision')::integer
 OR g.revision<>s."assignmentRevision" OR g."revokedAt" IS NOT NULL OR g."recipientId"<>s."actorId"
 OR g.payload->>'approvedById' IS DISTINCT FROM NEW."actorId"
 OR clock_timestamp()>=(g.payload->'selection'->>'expiresAt')::timestamptz
 OR clock_timestamp()>=to_timestamp((a->>'validUntil')::double precision/1000)
 OR a->>'assignmentId' IS DISTINCT FROM s."assignmentId"::text
 OR (a->>'assignmentRevision')::integer IS DISTINCT FROM s."assignmentRevision"
 OR a->>'assignmentStateSha256' IS DISTINCT FROM g."stateSha256"
 OR a->>'contextSha256' IS DISTINCT FROM g.payload->>'contextSha256'
 OR a->'existingAcquisitionId' IS DISTINCT FROM 'null'::jsonb
 OR a->>'actorId' IS DISTINCT FROM NEW."actorId" OR a->>'sessionId' IS DISTINCT FROM NEW."sessionId"::text
 OR a->'reference' IS DISTINCT FROM jsonb_build_object('kind',s."targetKind",'targetId',s."targetId",'recipientId',s."actorId")
 OR a->>'submissionCommandId' IS DISTINCT FROM s."commandId"::text OR a->>'reviewCommandId' IS DISTINCT FROM w."commandId"::text
 OR a->>'sourceSha256' IS DISTINCT FROM w.command->>'sourceSha256'
 OR a->>'fileSha256' IS DISTINCT FROM s."contentSha256" OR (a->>'sizeBytes')::integer IS DISTINCT FROM s."sizeBytes"
 OR c IS DISTINCT FROM jsonb_build_object('commandId',NEW."commandId"::text,'submissionCommandId',s."commandId"::text,
  'reviewCommandId',w."commandId"::text,'sourceSha256',a->>'sourceSha256','reviewSha256',a->>'reviewSha256',
  'classification',c->>'classification','title',c->>'title','expiresAt',c->'expiresAt','visibility','ADMIN_PRIVATE')
 OR COALESCE(length(c->>'title'),0) NOT BETWEEN 3 AND 180
 OR r IS DISTINCT FROM jsonb_build_object('protocol','TECHNICAL_DOCUMENT_ACQUISITION_RECEIPT_V1',
  'commandId',NEW."commandId"::text,'submissionCommandId',s."commandId"::text,'reviewCommandId',w."commandId"::text,
  'actorId',NEW."actorId",'sessionId',NEW."sessionId"::text,'reference',a->'reference','documentId',d.id,'versionId',v.id,
  'version',1,'fileSha256',s."contentSha256",'sizeBytes',s."sizeBytes",'classification',c->>'classification',
  'visibilityLevel','technical_admin_private_v1','requestDigest',r->>'requestDigest','admissionSha256',r->>'admissionSha256',
  'recordedAt',r->>'recordedAt','keyVersion',(g.payload->>'keyVersion')::integer)
 OR COALESCE(NEW.record->>'proof','') !~ '^[a-f0-9]{64}$'
 OR COALESCE(r->>'requestDigest','') !~ '^[a-f0-9]{64}$' OR COALESCE(r->>'admissionSha256','') !~ '^[a-f0-9]{64}$'
 OR COALESCE(a->>'reviewSha256','') !~ '^[a-f0-9]{64}$'
 OR (r->>'recordedAt')::timestamptz IS DISTINCT FROM (NEW."createdAt" AT TIME ZONE 'UTC')
 OR d."clientId" IS DISTINCT FROM a->>'clientId' OR d."projectId" IS DISTINCT FROM a->>'projectId'
 OR d."clientServiceId" IS DISTINCT FROM a->>'clientServiceId' OR d."companyId" IS NOT NULL
 OR d."serviceArea"::text<>'altro' OR d."documentCategory"<>category OR d.type<>category OR d.title IS DISTINCT FROM c->>'title'
 OR d."fileName" IS DISTINCT FROM s.command->'file'->>'fileName'
 OR d."mimeType" IS DISTINCT FROM split_part(COALESCE(s.command->'file'->>'previewMime','application/octet-stream'),';',1)
 OR d."sizeBytes"<>s."sizeBytes" OR d."storagePath"<>s."storageKey" OR d.checksum IS DISTINCT FROM s."contentSha256"
 OR d."uploadedById"<>NEW."actorId" OR d.status::text<>'caricato' OR d."visibilityLevel"<>'technical_admin_private_v1'
 OR d."containsSensitiveData" IS DISTINCT FROM ((c->>'classification')<>'TECHNICAL_DOCUMENT')
 OR d."validUntil" IS DISTINCT FROM ((c->>'expiresAt')::timestamptz AT TIME ZONE 'UTC')
 OR (d."validUntil" IS NOT NULL AND (d."validUntil" AT TIME ZONE 'UTC')<=clock_timestamp()) OR d."deletedAt" IS NOT NULL
 OR d."createdAt"<>NEW."createdAt" OR d."updatedAt"<>NEW."createdAt" OR d."selectiveEpoch"<>2
 OR v."documentId"<>d.id OR v.version<>1 OR v."storagePath"<>s."storageKey" OR v.checksum IS DISTINCT FROM s."contentSha256"
 OR v."createdAt"<>NEW."createdAt" OR (SELECT count(*) FROM "DocumentVersion" WHERE "documentId"=d.id)<>1
 OR audit.id IS NULL OR audit."actorId"<>NEW."actorId" OR audit.event<>'technical_document_acquired_private'
 OR audit."entityType"<>'Document' OR audit."entityId"<>d.id OR audit."before" IS DISTINCT FROM '{}'::jsonb
 OR audit."after" IS DISTINCT FROM jsonb_build_object('action','acquire_private_document',
  'type',c->>'classification','visibilityMode','ADMIN_PRIVATE','requestHash',r->>'requestDigest')
 OR NEW."transactionId"<>txid_current()
 OR NOT EXISTS(SELECT 1 FROM "Document" x WHERE x.id=d.id AND x.xmin::text::bigint=(txid_current()%4294967296))
 OR NOT EXISTS(SELECT 1 FROM "DocumentVersion" x WHERE x.id=v.id AND x.xmin::text::bigint=(txid_current()%4294967296))
 OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=audit.id AND x.xmin::text::bigint=(txid_current()%4294967296))
 THEN RAISE EXCEPTION 'TECHNICAL_ACQUISITION_ATOMIC'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER technical_acquisition_atomic AFTER INSERT ON "TechnicalDocumentAcquisition"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_acquisition_atomic();

-- Generic edits, new versions or relabelling cannot erase the private boundary.
-- Existing epoch triggers remain effective for association/context revocation.
CREATE FUNCTION fai_technical_canonical_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE private boolean;
BEGIN
 IF TG_TABLE_NAME='Document' THEN
  IF TG_OP='UPDATE' AND NEW."visibilityLevel" LIKE 'technical\_%' ESCAPE '\' AND OLD."visibilityLevel" NOT LIKE 'technical\_%' ESCAPE '\'
  THEN RAISE EXCEPTION 'TECHNICAL_CANONICAL_RETAINED'; END IF;
  private:=OLD."visibilityLevel" LIKE 'technical\_%' ESCAPE '\';
  IF private AND TG_OP='UPDATE' AND (to_jsonb(NEW)-'selectiveEpoch')=(to_jsonb(OLD)-'selectiveEpoch')
    AND NEW."selectiveEpoch">OLD."selectiveEpoch" THEN RETURN NEW; END IF;
 ELSE
  SELECT "visibilityLevel" LIKE 'technical\_%' ESCAPE '\' INTO private FROM "Document" WHERE id=OLD."documentId";
 END IF;
 IF private THEN RAISE EXCEPTION 'TECHNICAL_CANONICAL_RETAINED'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER technical_canonical_document_immutable BEFORE UPDATE OR DELETE ON "Document"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_canonical_immutable();
CREATE TRIGGER technical_canonical_version_immutable BEFORE UPDATE OR DELETE ON "DocumentVersion"
 FOR EACH ROW EXECUTE FUNCTION fai_technical_canonical_immutable();
CREATE FUNCTION fai_technical_canonical_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc text; visibility text;
BEGIN
 IF TG_TABLE_NAME='Document' THEN doc:=NEW.id; ELSE doc:=NEW."documentId"; END IF;
 SELECT "visibilityLevel" INTO visibility FROM "Document" WHERE id=doc;
 IF visibility LIKE 'technical\_%' ESCAPE '\' AND (visibility<>'technical_admin_private_v1'
  OR NOT EXISTS(SELECT 1 FROM "TechnicalDocumentAcquisition" a WHERE a."documentId"=doc AND a."transactionId"=txid_current()
   AND (TG_TABLE_NAME='Document' OR a."versionId"=NEW.id)))
 THEN RAISE EXCEPTION 'TECHNICAL_CANONICAL_ATOMIC'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER technical_acquisition_document_atomic AFTER INSERT ON "Document"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_canonical_atomic();
CREATE CONSTRAINT TRIGGER technical_acquisition_version_atomic AFTER INSERT ON "DocumentVersion"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fai_technical_canonical_atomic();
COMMIT;
