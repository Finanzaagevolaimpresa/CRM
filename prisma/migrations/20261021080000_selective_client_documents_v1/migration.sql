-- Exact selected document versions. No authority, grant or real document is created.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>58
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261018220000_selective_practice_read_v1'
  AND checksum='98ccebc553699d31ffbfa9cbdf7de028482c7decc4efe5cf0ef099eee54fa550' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 THEN RAISE EXCEPTION 'SELECTIVE_DOCUMENT_SCHEMA58_REQUIRED'; END IF;
END $$;

-- Metadata changes, even when later reverted, cannot revive an old approval.
ALTER TABLE "Document" ADD COLUMN "selectiveEpoch" INTEGER NOT NULL DEFAULT 1 CHECK ("selectiveEpoch">0);
CREATE FUNCTION fai_selected_document_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."selectiveEpoch"<OLD."selectiveEpoch" THEN RAISE EXCEPTION 'SELECTED_DOCUMENT_EPOCH_MONOTONIC'; END IF;
 IF (to_jsonb(NEW)-'selectiveEpoch') IS DISTINCT FROM (to_jsonb(OLD)-'selectiveEpoch') THEN
  NEW."selectiveEpoch":=GREATEST(NEW."selectiveEpoch",OLD."selectiveEpoch"+1);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selected_document_epoch BEFORE UPDATE ON "Document" FOR EACH ROW EXECUTE FUNCTION fai_selected_document_epoch();

-- Canonical association changes cannot reclassify an already selected version
-- silently. The caller's transaction also rolls back these generation changes.
CREATE FUNCTION fai_selected_document_reference_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_id text; new_id text; target_id text; affected text[]; context_id text;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN old_id:=to_jsonb(OLD)->>TG_ARGV[0]; END IF;
 IF TG_OP<>'DELETE' THEN new_id:=to_jsonb(NEW)->>TG_ARGV[0]; END IF;
 affected:=ARRAY[old_id,new_id];
 IF TG_TABLE_NAME='Contract' THEN
  IF TG_OP='DELETE' THEN context_id:=OLD.id; ELSE context_id:=NEW.id; END IF;
  affected:=affected || ARRAY(SELECT "accountingDocumentId" FROM "Payment" WHERE "contractId"=context_id)
    || ARRAY(SELECT "signedDocumentId" FROM "PracticeFormalization" WHERE "contractId"=context_id);
 END IF;
 FOR target_id IN SELECT DISTINCT x FROM unnest(affected) AS ids(x) WHERE x IS NOT NULL ORDER BY x LOOP
  UPDATE "Document" SET "selectiveEpoch"="selectiveEpoch"+1 WHERE id=target_id;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER selected_document_version_epoch AFTER INSERT OR UPDATE OR DELETE ON "DocumentVersion"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_document_reference_epoch('documentId');
CREATE TRIGGER selected_document_contract_epoch AFTER INSERT OR UPDATE OR DELETE ON "Contract"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_document_reference_epoch('signedDocumentId');
CREATE TRIGGER selected_document_payment_epoch AFTER INSERT OR UPDATE OR DELETE ON "Payment"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_document_reference_epoch('accountingDocumentId');
CREATE TRIGGER selected_document_formalization_epoch AFTER INSERT OR UPDATE OR DELETE ON "PracticeFormalization"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_document_reference_epoch('signedDocumentId');
CREATE TRIGGER selected_document_material_epoch AFTER INSERT OR UPDATE OR DELETE ON "PracticeMaterialEvidence"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_document_reference_epoch('documentId');

-- These parents have no monotonic access generation of their own. Record the
-- change on their attached documents even if metadata and timestamps are later
-- restored. Existing Project/ClientService generations are already signed.
CREATE FUNCTION fai_selected_document_context_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE context_id text; target_id text; affected text[];
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN context_id:=to_jsonb(OLD)->>'id'; ELSE context_id:=to_jsonb(NEW)->>'id'; END IF;
 IF TG_TABLE_NAME='Company' THEN
  affected:=ARRAY(SELECT id FROM "Document" WHERE "companyId"=context_id);
 ELSIF TG_TABLE_NAME='PracticeReadiness' THEN
  affected:=ARRAY(SELECT "documentId" FROM "PracticeMaterialEvidence" WHERE "practiceId"::text=context_id)
    || ARRAY(SELECT "signedDocumentId" FROM "PracticeFormalization" WHERE "practiceId"::text=context_id);
  IF TG_OP<>'INSERT' THEN affected:=array_append(affected,OLD."signedDocumentId"); END IF;
  IF TG_OP<>'DELETE' THEN affected:=array_append(affected,NEW."signedDocumentId"); END IF;
 ELSE RAISE EXCEPTION 'SELECTED_DOCUMENT_CONTEXT_INVALID'; END IF;
 FOR target_id IN SELECT DISTINCT x FROM unnest(affected) AS ids(x) WHERE x IS NOT NULL ORDER BY x LOOP
  UPDATE "Document" SET "selectiveEpoch"="selectiveEpoch"+1 WHERE id=target_id;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER selected_document_company_epoch AFTER INSERT OR UPDATE OR DELETE ON "Company"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_document_context_epoch();
CREATE TRIGGER selected_document_readiness_epoch AFTER INSERT OR UPDATE OR DELETE ON "PracticeReadiness"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_document_context_epoch();

-- V1 remains byte-compatible. V2 requires explicit, unique version choices and
-- signed snapshots; an empty field selection is valid only with chosen files.
CREATE FUNCTION fai_selective_client_documents_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s jsonb:=p->'selection'; choices jsonb; snapshots jsonb; choice jsonb; snap jsonb;
BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s->'fields') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF NOT (s ? 'version') THEN
  RETURN jsonb_array_length(s->'fields') BETWEEN 1 AND 3 AND NOT (s ? 'documents') AND NOT (p ? 'documents');
 END IF;
 IF s->'version' IS DISTINCT FROM '2'::jsonb OR jsonb_array_length(s->'fields')>3 THEN RETURN false; END IF;
 choices:=s->'documents'; snapshots:=p->'documents';
 IF jsonb_typeof(choices) IS DISTINCT FROM 'array' OR jsonb_typeof(snapshots) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(choices)>20 OR jsonb_array_length(choices)<>jsonb_array_length(snapshots)
  OR jsonb_array_length(choices)+jsonb_array_length(s->'fields')=0 THEN RETURN false; END IF;
 IF (SELECT count(DISTINCT x->>'versionId') FROM jsonb_array_elements(choices) x)<>jsonb_array_length(choices)
  OR (SELECT count(DISTINCT x->>'versionId') FROM jsonb_array_elements(snapshots) x)<>jsonb_array_length(snapshots) THEN RETURN false; END IF;
 FOR choice IN SELECT x FROM jsonb_array_elements(choices) x LOOP
  IF jsonb_typeof(choice) IS DISTINCT FROM 'object' OR (choice-'versionId'-'download')<>'{}'::jsonb
   OR jsonb_typeof(choice->'versionId') IS DISTINCT FROM 'string' OR NOT ((choice->>'versionId') ~ '^[A-Za-z0-9_-]{1,128}$')
   OR jsonb_typeof(choice->'download') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  SELECT x INTO snap FROM jsonb_array_elements(snapshots) x WHERE x->>'versionId'=choice->>'versionId';
  IF jsonb_typeof(snap) IS DISTINCT FROM 'object' OR snap->'download' IS DISTINCT FROM choice->'download'
   OR NOT (COALESCE(snap->>'checksum','') ~ '^[a-f0-9]{64}$') OR NOT (COALESCE(snap->>'stateHash','') ~ '^[a-f0-9]{64}$')
   OR NOT (COALESCE(snap->>'documentId','') ~ '^[A-Za-z0-9_-]{1,128}$') THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER TABLE "SelectiveClientGrant" DROP CONSTRAINT selective_client_payload_structure;
ALTER TABLE "SelectiveClientGrant" ADD CONSTRAINT selective_client_payload_structure CHECK ((
 fai_selective_client_documents_valid(payload)
 AND payload->>'id'=id::text AND payload->>'revision'=revision::text
 AND payload->'selection'->>'clientId'="clientId" AND payload->'selection'->>'recipientId'="recipientId"
 AND payload->'selection'->>'revision'=(revision-1)::text
) IS TRUE);

CREATE OR REPLACE FUNCTION fai_selective_client_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g "SelectiveClientGrant"%ROWTYPE; h "SelectiveClientRevision"%ROWTYPE;
 c "SelectiveClientCommand"%ROWTYPE; a "AuditLog"%ROWTYPE; grant_id uuid; rev integer; expected_audit jsonb;
BEGIN
 IF TG_TABLE_NAME='SelectiveClientGrant' THEN grant_id:=NEW.id;rev:=NEW.revision;
 ELSIF TG_TABLE_NAME='SelectiveClientRevision' THEN grant_id:=NEW."grantId";rev:=NEW.revision;
 ELSE
  SELECT * INTO h FROM "SelectiveClientRevision" WHERE "commandId"=NEW.id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'SELECTIVE_CLIENT_ATOMIC_HISTORY'; END IF;
  grant_id:=h."grantId";rev:=h.revision;
 END IF;
 SELECT * INTO g FROM "SelectiveClientGrant" WHERE id=grant_id;
 SELECT * INTO h FROM "SelectiveClientRevision" WHERE "grantId"=grant_id AND revision=rev;
 SELECT * INTO c FROM "SelectiveClientCommand" WHERE id=h."commandId";
 SELECT * INTO a FROM "AuditLog" WHERE id=h.id::text;
 expected_audit:=jsonb_build_object('version',rev,'action',c.operation,'fieldCount',jsonb_array_length(g.payload->'selection'->'fields'));
 IF g.payload->'selection'->'version'='2'::jsonb THEN
  IF c.receipt->>'protocol' IS DISTINCT FROM 'SELECTIVE_CLIENT_RECEIPT_V2'
   OR c.receipt->>'documentCount' IS DISTINCT FROM jsonb_array_length(g.payload->'selection'->'documents')::text THEN
   RAISE EXCEPTION 'SELECTIVE_CLIENT_DOCUMENT_ATOMIC_RECEIPT'; END IF;
  expected_audit:=expected_audit || jsonb_build_object('documentCount',jsonb_array_length(g.payload->'selection'->'documents'));
 ELSIF c.receipt->>'protocol' IS DISTINCT FROM 'SELECTIVE_CLIENT_RECEIPT_V1' OR c.receipt ? 'documentCount' THEN
  RAISE EXCEPTION 'SELECTIVE_CLIENT_LEGACY_RECEIPT';
 END IF;
 IF g.id IS NULL OR h.id IS NULL OR c.id IS NULL OR a.id IS NULL
  OR g.revision<>rev OR h."transactionId"<>txid_current() OR c."transactionId"<>txid_current()
  OR c."clientId"<>g."clientId" OR c."recipientId"<>g."recipientId" OR c."expectedRevision"+1<>rev
  OR g.payload->>'approvedById' IS DISTINCT FROM c."actorId"
  OR g.payload->'selection'->>'commandId' IS DISTINCT FROM c.id::text
  OR (rev>1 AND NOT EXISTS (SELECT 1 FROM "SelectiveClientRevision" WHERE "grantId"=g.id AND revision=rev-1))
  OR c.receipt->>'commandId' IS DISTINCT FROM c.id::text
  OR c.receipt->>'grantId' IS DISTINCT FROM g.id::text OR c.receipt->>'revisionId' IS DISTINCT FROM h.id::text
  OR c.receipt->>'revision' IS DISTINCT FROM rev::text OR c.receipt->>'operation' IS DISTINCT FROM c.operation
  OR c.receipt->>'fieldCount' IS DISTINCT FROM jsonb_array_length(g.payload->'selection'->'fields')::text
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=h.id::text AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR h.payload IS DISTINCT FROM g.payload OR h.proof<>g.proof OR h."revokedAt" IS DISTINCT FROM g."revokedAt"
  OR (c.operation='REVOKE') IS DISTINCT FROM (g."revokedAt" IS NOT NULL)
  OR a."actorId" IS DISTINCT FROM c."actorId" OR a.event<>'selective_client_changed'
  OR a."entityType"<>'SelectiveClientRevision' OR a."entityId"<>h.id::text
  OR a."before" IS DISTINCT FROM jsonb_build_object('version',c."expectedRevision")
  OR a."after" IS DISTINCT FROM expected_audit THEN
  RAISE EXCEPTION 'SELECTIVE_CLIENT_ATOMIC_HISTORY';
 END IF;
 RETURN NULL;
END $$;

COMMIT;
