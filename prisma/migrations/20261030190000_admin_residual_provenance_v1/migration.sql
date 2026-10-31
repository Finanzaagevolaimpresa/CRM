-- Additive provenance for later private-document versions and operational link epochs.
-- Existing signed rows, original versions, acceptance and delivery facts are retained.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>73
 OR NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261030100000_admin_operational_lifecycle_v1'
   AND checksum='40daf3e4509e79efc4f72bfb9b1cbeddcc58d116bbc8ef959de37860aeb72e36' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 OR EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL
   AND migration_name<>'20261030190000_admin_residual_provenance_v1')
 THEN RAISE EXCEPTION 'ADMIN_RESIDUAL_SCHEMA73_REQUIRED'; END IF;
END $$;

CREATE FUNCTION fai_admin_private_version_provenance(version_id text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v "DocumentVersion"%ROWTYPE; d "Document"%ROWTYPE; r "AdminRecordRevision"%ROWTYPE; a "TechnicalDocumentAcquisition"%ROWTYPE;
BEGIN
 SELECT * INTO v FROM "DocumentVersion" WHERE id=version_id;
 IF NOT FOUND OR v.version<2 OR NOT EXISTS (SELECT 1 FROM "DocumentVersion" x WHERE x.id=v.id
   AND x.xmin::text::bigint=(txid_current()%4294967296)) THEN RETURN false; END IF;
 SELECT * INTO d FROM "Document" WHERE id=v."documentId";
 SELECT * INTO a FROM "TechnicalDocumentAcquisition" WHERE "documentId"=d.id;
 SELECT * INTO r FROM "AdminRecordRevision" WHERE model='AdminPrivateDocumentVersion' AND "recordId"=d.id
   AND operation='UPDATE' AND after->'version'->>'id'=v.id AND "transactionId"=txid_current();
 IF r."commandId" IS NULL OR NOT COALESCE(
   r.before ?& ARRAY['id','sourceAcquisitionCommandId','versionCount','latestVersionId']
   AND r.after ?& ARRAY['id','sourceAcquisitionCommandId','versionCount','latestVersionId','version','file']
   AND (r.after->'version') ?& ARRAY['id','documentId','version','storagePath','checksum','createdAt']
   AND (r.after->'file') ?& ARRAY['fileName','mimeType','sizeBytes','sha256'],false)
 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_each_text(r.before) x WHERE x.value IS NULL)
   OR EXISTS (SELECT 1 FROM jsonb_each_text(r.after-'version'-'file') x WHERE x.value IS NULL)
   OR EXISTS (SELECT 1 FROM jsonb_each_text(r.after->'version') x WHERE x.value IS NULL)
   OR EXISTS (SELECT 1 FROM jsonb_each_text(r.after->'file') x WHERE x.value IS NULL)
 THEN RETURN false; END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'serializable'
   OR d."visibilityLevel"<>'technical_admin_private_v1' OR a."commandId" IS NULL OR r."commandId" IS NULL OR v.checksum IS NULL
   OR r."actorId"<>a."actorId" OR r.before->>'sourceAcquisitionCommandId'<>a."commandId"::text
   OR r."beforeHash"<>encode(sha256(convert_to(canonicalize_ai_execution_jsonb_v2(r.before),'UTF8')),'hex')
   OR r."afterHash"<>encode(sha256(convert_to(canonicalize_ai_execution_jsonb_v2(r.after),'UTF8')),'hex')
   OR r.after->>'sourceAcquisitionCommandId'<>a."commandId"::text
   OR (r.before->>'versionCount')::integer<>v.version-1 OR (r.after->>'versionCount')::integer<>v.version
   OR r.after->>'latestVersionId'<>v.id
   OR v.id<>'admin-version-'||r."commandId"::text OR v."createdAt">r."createdAt"
   OR r.after->'version'->>'documentId'<>d.id OR (r.after->'version'->>'version')::integer<>v.version
   OR r.after->'version'->>'storagePath'<>v."storagePath" OR r.after->'version'->>'checksum'<>v.checksum
   OR (r.after->'version'->>'createdAt')::timestamptz IS DISTINCT FROM v."createdAt"
   OR r.after->'file'->>'sha256'<>v.checksum OR v.checksum !~ '^[a-f0-9]{64}$'
   OR NOT ((r.after->'file'->>'sizeBytes')::integer BETWEEN 1 AND 26214400)
   OR length(r.after->'file'->>'fileName') NOT BETWEEN 1 AND 255
   OR position('..' in r.after->'file'->>'fileName')>0
   OR (r.after->'file'->>'fileName') ~ '[[:cntrl:]/\\]'
   OR NOT EXISTS (SELECT 1 FROM "DocumentVersion" p WHERE p.id=r.before->>'latestVersionId'
     AND p."documentId"=d.id AND p.version=v.version-1 AND p."createdAt"<=v."createdAt")
   OR (SELECT count(*) FROM "DocumentVersion" WHERE "documentId"=d.id)<>v.version
   OR (SELECT count(*) FROM "AdminRecordRevision" WHERE model='AdminPrivateDocumentVersion' AND "recordId"=d.id AND operation='UPDATE')<>v.version-1
   OR NOT EXISTS (SELECT 1 FROM "AdminOperationalState" s WHERE s.model='Document' AND s."recordId"=d.id AND s.state='ACTIVE')
   OR NOT EXISTS (SELECT 1 FROM "TechnicalAssignmentAuthority" t JOIN "User" u ON u.id=t."userId"
     WHERE t.id='technical-assignment' AND t.enabled AND t."userId"=r."actorId" AND u.role='admin' AND u.active
     AND u."deletedAt" IS NULL AND t.revision=(a.record->'admission'->>'authorityRevision')::integer)
 THEN RETURN false; END IF;
 RETURN true;
END $$;

-- Preserve the original acquisition-only branch. A subsequent version is admitted
-- solely with a same-transaction Admin receipt; existing version immutability stays.
CREATE OR REPLACE FUNCTION fai_technical_canonical_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc text; visibility text;
BEGIN
 IF TG_TABLE_NAME='Document' THEN doc:=NEW.id; ELSE doc:=NEW."documentId"; END IF;
 SELECT "visibilityLevel" INTO visibility FROM "Document" WHERE id=doc;
 IF TG_TABLE_NAME='DocumentVersion' AND visibility='technical_admin_private_v1'
   AND fai_admin_private_version_provenance(NEW.id) THEN RETURN NULL; END IF;
 IF visibility LIKE 'technical\_%' ESCAPE '\' AND (visibility<>'technical_admin_private_v1'
  OR NOT EXISTS(SELECT 1 FROM "TechnicalDocumentAcquisition" a WHERE a."documentId"=doc AND a."transactionId"=txid_current()
   AND (TG_TABLE_NAME='Document' OR a."versionId"=NEW.id)))
 THEN RAISE EXCEPTION 'TECHNICAL_CANONICAL_ATOMIC'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION fai_admin_private_version_receipt_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.operation<>'UPDATE' OR NOT COALESCE(fai_admin_private_version_provenance(NEW.after->'version'->>'id'),false)
 THEN RAISE EXCEPTION 'ADMIN_PRIVATE_VERSION_ATOMIC'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER admin_private_version_receipt_atomic AFTER INSERT ON "AdminRecordRevision"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.model='AdminPrivateDocumentVersion' AND NEW.operation<>'CLOSE')
 EXECUTE FUNCTION fai_admin_private_version_receipt_atomic();

-- Runs after the existing record_update_epoch trigger. A correction and a later
-- reversal must not revive grants or decisions bound to the old service context.
CREATE FUNCTION fai_admin_service_binding_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."serviceCatalogId",NEW."contractId",NEW."paymentId") IS DISTINCT FROM
    ROW(OLD."serviceCatalogId",OLD."contractId",OLD."paymentId")
 THEN NEW."recordUpdateEpoch":=GREATEST(NEW."recordUpdateEpoch",OLD."recordUpdateEpoch"+1); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_admin_service_binding_epoch BEFORE UPDATE ON "ClientService"
 FOR EACH ROW EXECUTE FUNCTION fai_admin_service_binding_epoch();
COMMIT;
