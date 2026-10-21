-- Exact versions explicitly linked to a technical practice in a signed,
-- immutable personal selection. Existing V1 grants/history remain unchanged.
-- No document, authority, real association or recipient is created by this SQL.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>59
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261021080000_selective_client_documents_v1'
  AND checksum='1890bda902d186dd8ea1b84cac2b46b9412e0740c1cf02b413384f086761f053' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 THEN RAISE EXCEPTION 'SELECTIVE_PRACTICE_DOCUMENT_SCHEMA59_REQUIRED'; END IF;
END $$;

-- V1 remains byte-compatible. V2 requires explicit, unique version choices and
-- signed snapshots; an empty field selection is valid only with chosen files.
CREATE FUNCTION fai_selective_practice_documents_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s jsonb:=p->'selection'; choices jsonb; snapshots jsonb; choice jsonb; snap jsonb;
BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s->'fields') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF NOT (s ? 'version') THEN
  RETURN jsonb_array_length(s->'fields') BETWEEN 1 AND 6 AND NOT (s ? 'documents') AND NOT (p ? 'documents');
 END IF;
 IF s->'version' IS DISTINCT FROM '2'::jsonb OR jsonb_array_length(s->'fields')>6 THEN RETURN false; END IF;
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
   OR snap->>'practiceId' IS DISTINCT FROM s->>'practiceId'
   OR NOT (COALESCE(snap->>'documentId','') ~ '^[A-Za-z0-9_-]{1,128}$') THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER TABLE "SelectivePracticeGrant" DROP CONSTRAINT selective_practice_payload_structure;
ALTER TABLE "SelectivePracticeGrant" ADD CONSTRAINT selective_practice_payload_structure CHECK ((
 (payload->>'contextHash') ~ '^[a-f0-9]{64}$' AND fai_selective_practice_documents_valid(payload)
 AND payload->>'id'=id::text AND payload->>'revision'=revision::text
 AND payload->'selection'->>'practiceId'="practiceId" AND payload->'selection'->>'recipientId'="recipientId"
 AND payload->'selection'->>'revision'=(revision-1)::text
) IS TRUE);

CREATE OR REPLACE FUNCTION fai_selective_practice_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g "SelectivePracticeGrant"%ROWTYPE; h "SelectivePracticeRevision"%ROWTYPE;
 c "SelectivePracticeCommand"%ROWTYPE; a "AuditLog"%ROWTYPE; grant_id uuid; rev integer; expected_audit jsonb;
BEGIN
 IF TG_TABLE_NAME='SelectivePracticeGrant' THEN grant_id:=NEW.id;rev:=NEW.revision;
 ELSIF TG_TABLE_NAME='SelectivePracticeRevision' THEN grant_id:=NEW."grantId";rev:=NEW.revision;
 ELSE
  SELECT * INTO h FROM "SelectivePracticeRevision" WHERE "commandId"=NEW.id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'SELECTIVE_PRACTICE_ATOMIC_HISTORY'; END IF;
  grant_id:=h."grantId";rev:=h.revision;
 END IF;
 SELECT * INTO g FROM "SelectivePracticeGrant" WHERE id=grant_id;
 SELECT * INTO h FROM "SelectivePracticeRevision" WHERE "grantId"=grant_id AND revision=rev;
 SELECT * INTO c FROM "SelectivePracticeCommand" WHERE id=h."commandId";
 SELECT * INTO a FROM "AuditLog" WHERE id=h.id::text;
 expected_audit:=jsonb_build_object('version',rev,'action',c.operation,'fieldCount',jsonb_array_length(g.payload->'selection'->'fields'));
 IF g.payload->'selection'->'version'='2'::jsonb THEN
  IF c.receipt->>'protocol' IS DISTINCT FROM 'SELECTIVE_PRACTICE_RECEIPT_V2'
   OR c.receipt->>'documentCount' IS DISTINCT FROM jsonb_array_length(g.payload->'selection'->'documents')::text THEN
   RAISE EXCEPTION 'SELECTIVE_PRACTICE_DOCUMENT_ATOMIC_RECEIPT'; END IF;
  expected_audit:=expected_audit || jsonb_build_object('documentCount',jsonb_array_length(g.payload->'selection'->'documents'));
 ELSIF c.receipt->>'protocol' IS DISTINCT FROM 'SELECTIVE_PRACTICE_RECEIPT_V1' OR c.receipt ? 'documentCount' THEN
  RAISE EXCEPTION 'SELECTIVE_PRACTICE_LEGACY_RECEIPT';
 END IF;
 IF g.id IS NULL OR h.id IS NULL OR c.id IS NULL OR a.id IS NULL
  OR g.revision<>rev OR h."transactionId"<>txid_current() OR c."transactionId"<>txid_current()
  OR c."practiceId"<>g."practiceId" OR c."recipientId"<>g."recipientId" OR c."expectedRevision"+1<>rev
  OR g.payload->>'approvedById' IS DISTINCT FROM c."actorId"
  OR g.payload->'selection'->>'commandId' IS DISTINCT FROM c.id::text
  OR (rev>1 AND NOT EXISTS (SELECT 1 FROM "SelectivePracticeRevision" WHERE "grantId"=g.id AND revision=rev-1))
  OR c.receipt->>'commandId' IS DISTINCT FROM c.id::text
  OR c.receipt->>'grantId' IS DISTINCT FROM g.id::text OR c.receipt->>'revisionId' IS DISTINCT FROM h.id::text
  OR c.receipt->>'revision' IS DISTINCT FROM rev::text OR c.receipt->>'operation' IS DISTINCT FROM c.operation
  OR c.receipt->>'fieldCount' IS DISTINCT FROM jsonb_array_length(g.payload->'selection'->'fields')::text
  OR NOT EXISTS(SELECT 1 FROM "AuditLog" x WHERE x.id=h.id::text AND x.xmin::text::bigint=(txid_current()%4294967296))
  OR h.payload IS DISTINCT FROM g.payload OR h.proof<>g.proof OR h."revokedAt" IS DISTINCT FROM g."revokedAt"
  OR (c.operation='REVOKE') IS DISTINCT FROM (g."revokedAt" IS NOT NULL)
  OR a."actorId" IS DISTINCT FROM c."actorId" OR a.event<>'selective_practice_changed'
  OR a."entityType"<>'SelectivePracticeRevision' OR a."entityId"<>h.id::text
  OR a."before" IS DISTINCT FROM jsonb_build_object('version',c."expectedRevision")
  OR a."after" IS DISTINCT FROM expected_audit THEN
  RAISE EXCEPTION 'SELECTIVE_PRACTICE_ATOMIC_HISTORY';
 END IF;
 RETURN NULL;
END $$;

COMMIT;
