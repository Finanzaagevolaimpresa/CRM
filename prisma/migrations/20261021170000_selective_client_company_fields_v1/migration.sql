-- Separate monotone generations: Company bytes and V1/V2 signatures stay intact.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>60
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261021110000_selective_practice_documents_v1'
  AND checksum='3c5be559feca7757ed3e3e9ff56a312489303b896f5a984cc99c571cbc3be791' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 THEN RAISE EXCEPTION 'SELECTIVE_COMPANY_SCHEMA60_REQUIRED'; END IF;
END $$;

CREATE TABLE "SelectiveCompanyGeneration" (
 "companyId" TEXT PRIMARY KEY,
 generation INTEGER NOT NULL DEFAULT 1 CHECK (generation>0)
);
-- Intentionally no cascading FK: removal and re-insertion never reset identity.
INSERT INTO "SelectiveCompanyGeneration"("companyId") SELECT id FROM "Company" ORDER BY id;
CREATE FUNCTION fai_selected_company_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' OR TG_OP='DELETE' OR pg_trigger_depth()<>2 THEN
  RAISE EXCEPTION 'SELECTED_COMPANY_GENERATION_PROTECTED';
 END IF;
 IF TG_OP='UPDATE' AND (NEW."companyId"<>OLD."companyId" OR NEW.generation<>OLD.generation+1) THEN
  RAISE EXCEPTION 'SELECTED_COMPANY_GENERATION_MONOTONIC';
 END IF;
 IF TG_OP='INSERT' AND NEW.generation<>1 THEN RAISE EXCEPTION 'SELECTED_COMPANY_GENERATION_INITIAL'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selected_company_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON "SelectiveCompanyGeneration"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_company_generation_guard();
CREATE TRIGGER selected_company_generation_truncate BEFORE TRUNCATE ON "SelectiveCompanyGeneration"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_selected_company_generation_guard();
CREATE TRIGGER selected_company_no_truncate BEFORE TRUNCATE ON "Company"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_selected_company_generation_guard();
CREATE FUNCTION fai_selected_company_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text[]; company_id text;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN affected:=array_append(affected,OLD.id); END IF;
 IF TG_OP<>'DELETE' THEN affected:=array_append(affected,NEW.id); END IF;
 FOR company_id IN SELECT DISTINCT id FROM unnest(affected) AS ids(id) ORDER BY id LOOP
  INSERT INTO "SelectiveCompanyGeneration"("companyId") VALUES(company_id)
   ON CONFLICT("companyId") DO UPDATE SET generation="SelectiveCompanyGeneration".generation+1;
 END LOOP;
 RETURN NULL;
END $$;
-- Alphabetical order: Company row -> generation -> existing document epochs.
CREATE TRIGGER company_information_epoch AFTER INSERT OR UPDATE OR DELETE ON "Company"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_company_generation();

CREATE FUNCTION fai_selective_client_information_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s jsonb:=p->'selection'; choices jsonb; snapshots jsonb; choice jsonb; snap jsonb; field jsonb;
BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF s->'version' IS DISTINCT FROM '3'::jsonb THEN
  RETURN NOT(s ? 'companies') AND NOT(p ? 'companies') AND fai_selective_client_documents_valid(p);
 END IF;
 IF jsonb_typeof(s->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'fields')>3 THEN RETURN false; END IF;
 IF (SELECT count(DISTINCT f) FROM jsonb_array_elements(s->'fields') f)<>jsonb_array_length(s->'fields') THEN RETURN false; END IF;
 FOR field IN SELECT f FROM jsonb_array_elements(s->'fields') f LOOP
  IF NOT(field <@ '["displayName","type","status"]'::jsonb) THEN RETURN false; END IF;
 END LOOP;
 choices:=s->'companies'; snapshots:=p->'companies';
 IF jsonb_typeof(choices) IS DISTINCT FROM 'array' OR jsonb_typeof(snapshots) IS DISTINCT FROM 'array'
  OR jsonb_typeof(s->'documents') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(choices)>20 OR jsonb_array_length(choices)<>jsonb_array_length(snapshots)
  OR jsonb_array_length(choices)+jsonb_array_length(s->'fields')+jsonb_array_length(s->'documents')=0 THEN RETURN false; END IF;
 -- Reuse exact historical document validation, including for company-only V3.
 -- The temporary scalar is for validation only; no persisted payload is changed.
 IF NOT fai_selective_client_documents_valid(jsonb_set(p-'companies','{selection}',
  (s-'companies') || jsonb_build_object('version',2,'fields',jsonb_build_array('displayName')))) THEN RETURN false; END IF;
 IF (SELECT count(DISTINCT c->>'companyId') FROM jsonb_array_elements(choices) c)<>jsonb_array_length(choices)
  OR (SELECT count(DISTINCT c->>'companyId') FROM jsonb_array_elements(snapshots) c)<>jsonb_array_length(snapshots) THEN RETURN false; END IF;
 FOR choice IN SELECT c FROM jsonb_array_elements(choices) c LOOP
  IF jsonb_typeof(choice) IS DISTINCT FROM 'object' OR (choice-'companyId'-'fields')<>'{}'::jsonb
   OR NOT(COALESCE(choice->>'companyId','') ~ '^[A-Za-z0-9_-]{1,128}$')
   OR jsonb_typeof(choice->'companyId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(choice->'fields') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(choice->'fields') NOT BETWEEN 1 AND 13
   OR (SELECT count(DISTINCT f) FROM jsonb_array_elements(choice->'fields') f)<>jsonb_array_length(choice->'fields') THEN RETURN false; END IF;
  FOR field IN SELECT f FROM jsonb_array_elements(choice->'fields') f LOOP
   IF NOT(field <@ '["name","vatNumber","taxCode","rea","pec","legalAddress","operatingAddress","region","province","city","legalForm","atecoCode","atecoDescription"]'::jsonb) THEN RETURN false; END IF;
  END LOOP;
  SELECT c INTO snap FROM jsonb_array_elements(snapshots) c WHERE c->>'companyId'=choice->>'companyId';
  IF jsonb_typeof(snap) IS DISTINCT FROM 'object' OR (snap-'companyId'-'companyEpoch'-'stateHash')<>'{}'::jsonb
   OR jsonb_typeof(snap->'companyId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(snap->'companyEpoch') IS DISTINCT FROM 'number'
   OR NOT(COALESCE(snap->>'companyEpoch','') ~ '^[1-9][0-9]{0,9}$')
   OR (snap->>'companyEpoch')::numeric>2147483647
   OR jsonb_typeof(snap->'stateHash') IS DISTINCT FROM 'string'
   OR NOT(COALESCE(snap->>'stateHash','') ~ '^[a-f0-9]{64}$') THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER TABLE "SelectiveClientGrant" DROP CONSTRAINT selective_client_payload_structure;
ALTER TABLE "SelectiveClientGrant" ADD CONSTRAINT selective_client_payload_structure CHECK ((
 fai_selective_client_information_valid(payload)
 AND payload->>'id'=id::text AND payload->>'revision'=revision::text
 AND payload->'selection'->>'clientId'="clientId" AND payload->'selection'->>'recipientId'="recipientId"
 AND payload->'selection'->>'revision'=(revision-1)::text
) IS TRUE);

-- The immutable history/audit trigger is expanded below for explicit V3 counts.

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
 IF g.payload->'selection'->'version' IN ('2'::jsonb,'3'::jsonb) THEN
  IF c.receipt->>'protocol' IS DISTINCT FROM CASE WHEN g.payload->'selection'->'version'='3'::jsonb THEN 'SELECTIVE_CLIENT_RECEIPT_V3' ELSE 'SELECTIVE_CLIENT_RECEIPT_V2' END
   OR c.receipt->>'documentCount' IS DISTINCT FROM jsonb_array_length(g.payload->'selection'->'documents')::text THEN
   RAISE EXCEPTION 'SELECTIVE_CLIENT_DOCUMENT_ATOMIC_RECEIPT'; END IF;
  expected_audit:=expected_audit || jsonb_build_object('documentCount',jsonb_array_length(g.payload->'selection'->'documents'));
 ELSIF c.receipt->>'protocol' IS DISTINCT FROM 'SELECTIVE_CLIENT_RECEIPT_V1' OR c.receipt ? 'documentCount' THEN
  RAISE EXCEPTION 'SELECTIVE_CLIENT_LEGACY_RECEIPT';
 END IF;
 IF g.payload->'selection'->'version'='3'::jsonb THEN
  expected_audit:=expected_audit || jsonb_build_object('companyCount',jsonb_array_length(g.payload->'selection'->'companies'),
   'companyFieldCount',(SELECT COALESCE(sum(jsonb_array_length(x->'fields')),0) FROM jsonb_array_elements(g.payload->'selection'->'companies') x));
  IF c.receipt->'companyCount' IS DISTINCT FROM expected_audit->'companyCount'
   OR c.receipt->'companyFieldCount' IS DISTINCT FROM expected_audit->'companyFieldCount' THEN
   RAISE EXCEPTION 'SELECTIVE_CLIENT_COMPANY_ATOMIC_RECEIPT'; END IF;
 ELSIF c.receipt ? 'companyCount' OR c.receipt ? 'companyFieldCount' THEN
  RAISE EXCEPTION 'SELECTIVE_CLIENT_LEGACY_COMPANY_RECEIPT';
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
