-- Exact per-company person selections; existing Person, membership and grant bytes are preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>61
 OR NOT EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261021170000_selective_client_company_fields_v1'
  AND checksum='9c65f0a874c1abdb6529fa87e2a9dac2c991c7412fbc9e795a18d89968fc7fd5' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
 THEN RAISE EXCEPTION 'SELECTIVE_PERSON_SCHEMA61_REQUIRED'; END IF;
END $$;

CREATE TABLE "SelectivePersonGeneration" (
 "personId" TEXT PRIMARY KEY,
 generation INTEGER NOT NULL DEFAULT 1 CHECK (generation>0)
);
-- Tombstones have no cascading FK: removal and reuse cannot reset identity.
INSERT INTO "SelectivePersonGeneration"("personId") SELECT id FROM "Person" ORDER BY id;
CREATE FUNCTION fai_selected_person_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' OR TG_OP='DELETE' OR pg_trigger_depth()<>2 THEN
  RAISE EXCEPTION 'SELECTED_PERSON_GENERATION_PROTECTED';
 END IF;
 IF TG_OP='UPDATE' AND (NEW."personId"<>OLD."personId" OR NEW.generation<>OLD.generation+1) THEN
  RAISE EXCEPTION 'SELECTED_PERSON_GENERATION_MONOTONIC';
 END IF;
 IF TG_OP='INSERT' AND NEW.generation<>1 THEN RAISE EXCEPTION 'SELECTED_PERSON_GENERATION_INITIAL'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selected_person_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON "SelectivePersonGeneration"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_person_generation_guard();
CREATE TRIGGER selected_person_generation_truncate BEFORE TRUNCATE ON "SelectivePersonGeneration"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_selected_person_generation_guard();
CREATE TRIGGER selected_person_no_truncate BEFORE TRUNCATE ON "Person"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_selected_person_generation_guard();
CREATE FUNCTION fai_selected_person_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text[]; target_id text;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN affected:=array_append(affected,OLD.id); END IF;
 IF TG_OP<>'DELETE' THEN affected:=array_append(affected,NEW.id); END IF;
 FOR target_id IN SELECT DISTINCT id FROM unnest(affected) AS ids(id) ORDER BY id LOOP
  INSERT INTO "SelectivePersonGeneration"("personId") VALUES(target_id)
   ON CONFLICT("personId") DO UPDATE SET generation="SelectivePersonGeneration".generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER person_information_epoch AFTER INSERT OR UPDATE OR DELETE ON "Person"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_person_generation();

CREATE TABLE "SelectiveMembershipGeneration" (
 "membershipId" TEXT PRIMARY KEY,
 generation INTEGER NOT NULL DEFAULT 1 CHECK (generation>0)
);
-- Tombstones have no cascading FK: removal and reuse cannot reset identity.
INSERT INTO "SelectiveMembershipGeneration"("membershipId") SELECT id FROM "CompanyPerson" ORDER BY id;
CREATE FUNCTION fai_selected_membership_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' OR TG_OP='DELETE' OR pg_trigger_depth()<>2 THEN
  RAISE EXCEPTION 'SELECTED_MEMBERSHIP_GENERATION_PROTECTED';
 END IF;
 IF TG_OP='UPDATE' AND (NEW."membershipId"<>OLD."membershipId" OR NEW.generation<>OLD.generation+1) THEN
  RAISE EXCEPTION 'SELECTED_MEMBERSHIP_GENERATION_MONOTONIC';
 END IF;
 IF TG_OP='INSERT' AND NEW.generation<>1 THEN RAISE EXCEPTION 'SELECTED_MEMBERSHIP_GENERATION_INITIAL'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selected_membership_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON "SelectiveMembershipGeneration"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_membership_generation_guard();
CREATE TRIGGER selected_membership_generation_truncate BEFORE TRUNCATE ON "SelectiveMembershipGeneration"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_selected_membership_generation_guard();
CREATE TRIGGER selected_membership_no_truncate BEFORE TRUNCATE ON "CompanyPerson"
 FOR EACH STATEMENT EXECUTE FUNCTION fai_selected_membership_generation_guard();
CREATE FUNCTION fai_selected_membership_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text[]; target_id text;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN affected:=array_append(affected,OLD.id); END IF;
 IF TG_OP<>'DELETE' THEN affected:=array_append(affected,NEW.id); END IF;
 FOR target_id IN SELECT DISTINCT id FROM unnest(affected) AS ids(id) ORDER BY id LOOP
  INSERT INTO "SelectiveMembershipGeneration"("membershipId") VALUES(target_id)
   ON CONFLICT("membershipId") DO UPDATE SET generation="SelectiveMembershipGeneration".generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER membership_information_epoch AFTER INSERT OR UPDATE OR DELETE ON "CompanyPerson"
 FOR EACH ROW EXECUTE FUNCTION fai_selected_membership_generation();

CREATE FUNCTION fai_selective_client_people_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s jsonb:=p->'selection'; choices jsonb; snapshots jsonb; choice jsonb; snap jsonb; field jsonb; epoch text; legacy_fields jsonb;
BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF s->'version' IS DISTINCT FROM '4'::jsonb THEN
  RETURN NOT(s ? 'people') AND NOT(p ? 'people') AND fai_selective_client_information_valid(p);
 END IF;
 choices:=s->'people'; snapshots:=p->'people';
 IF jsonb_typeof(choices) IS DISTINCT FROM 'array' OR jsonb_typeof(snapshots) IS DISTINCT FROM 'array'
  OR jsonb_typeof(s->'fields') IS DISTINCT FROM 'array' OR jsonb_typeof(s->'companies') IS DISTINCT FROM 'array'
  OR jsonb_typeof(s->'documents') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(choices)>20 OR jsonb_array_length(choices)<>jsonb_array_length(snapshots)
  OR jsonb_array_length(choices)+jsonb_array_length(s->'fields')+jsonb_array_length(s->'companies')+jsonb_array_length(s->'documents')=0 THEN RETURN false; END IF;
 -- A person-only selection uses a temporary field solely for the historical
 -- V3 validator. Existing signed payloads, choices and snapshots are not changed.
 legacy_fields:=s->'fields';
 IF jsonb_array_length(legacy_fields)+jsonb_array_length(s->'companies')+jsonb_array_length(s->'documents')=0 THEN
  legacy_fields:=jsonb_build_array('displayName');
 END IF;
 IF NOT fai_selective_client_information_valid(jsonb_set(p-'people','{selection}',
  (s-'people') || jsonb_build_object('version',3,'fields',legacy_fields))) THEN RETURN false; END IF;
 IF (SELECT count(DISTINCT c->>'membershipId') FROM jsonb_array_elements(choices) c)<>jsonb_array_length(choices)
  OR (SELECT count(DISTINCT c->>'membershipId') FROM jsonb_array_elements(snapshots) c)<>jsonb_array_length(snapshots) THEN RETURN false; END IF;
 FOR choice IN SELECT c FROM jsonb_array_elements(choices) c LOOP
  IF jsonb_typeof(choice) IS DISTINCT FROM 'object' OR (choice-'membershipId'-'companyId'-'personId'-'fields')<>'{}'::jsonb
   OR jsonb_typeof(choice->'fields') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  FOREACH epoch IN ARRAY ARRAY['membershipId','companyId','personId'] LOOP
   IF jsonb_typeof(choice->epoch) IS DISTINCT FROM 'string' OR NOT(COALESCE(choice->>epoch,'') ~ '^[A-Za-z0-9_-]{1,128}$') THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_array_length(choice->'fields') NOT BETWEEN 1 AND 7
   OR (SELECT count(DISTINCT f) FROM jsonb_array_elements(choice->'fields') f)<>jsonb_array_length(choice->'fields') THEN RETURN false; END IF;
  FOR field IN SELECT f FROM jsonb_array_elements(choice->'fields') f LOOP
   IF NOT(field <@ '["firstName","lastName","email","phone","taxCode","role","ownershipPercent"]'::jsonb) THEN RETURN false; END IF;
  END LOOP;
  SELECT c INTO snap FROM jsonb_array_elements(snapshots) c WHERE c->>'membershipId'=choice->>'membershipId';
  IF jsonb_typeof(snap) IS DISTINCT FROM 'object' OR (snap-'membershipId'-'companyId'-'personId'-'companyEpoch'-'membershipEpoch'-'personEpoch'-'stateHash')<>'{}'::jsonb
   OR snap->'membershipId' IS DISTINCT FROM choice->'membershipId' OR snap->'companyId' IS DISTINCT FROM choice->'companyId'
   OR snap->'personId' IS DISTINCT FROM choice->'personId'
   OR jsonb_typeof(snap->'stateHash') IS DISTINCT FROM 'string'
   OR NOT(COALESCE(snap->>'stateHash','') ~ '^[a-f0-9]{64}$') THEN RETURN false; END IF;
  FOREACH epoch IN ARRAY ARRAY['companyEpoch','membershipEpoch','personEpoch'] LOOP
   IF jsonb_typeof(snap->epoch) IS DISTINCT FROM 'number' OR NOT(COALESCE(snap->>epoch,'') ~ '^[1-9][0-9]{0,9}$')
    OR (snap->>epoch)::numeric>2147483647 THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;
ALTER TABLE "SelectiveClientGrant" DROP CONSTRAINT selective_client_payload_structure;
ALTER TABLE "SelectiveClientGrant" ADD CONSTRAINT selective_client_payload_structure CHECK ((
 fai_selective_client_people_valid(payload)
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
 IF g.payload->'selection'->'version' IN ('2'::jsonb,'3'::jsonb,'4'::jsonb) THEN
  IF c.receipt->>'protocol' IS DISTINCT FROM (CASE WHEN g.payload->'selection'->'version'='4'::jsonb THEN 'SELECTIVE_CLIENT_RECEIPT_V4' WHEN g.payload->'selection'->'version'='3'::jsonb THEN 'SELECTIVE_CLIENT_RECEIPT_V3' ELSE 'SELECTIVE_CLIENT_RECEIPT_V2' END)
   OR c.receipt->>'documentCount' IS DISTINCT FROM jsonb_array_length(g.payload->'selection'->'documents')::text THEN
   RAISE EXCEPTION 'SELECTIVE_CLIENT_DOCUMENT_ATOMIC_RECEIPT'; END IF;
  expected_audit:=expected_audit || jsonb_build_object('documentCount',jsonb_array_length(g.payload->'selection'->'documents'));
 ELSIF c.receipt->>'protocol' IS DISTINCT FROM 'SELECTIVE_CLIENT_RECEIPT_V1' OR c.receipt ? 'documentCount' THEN
  RAISE EXCEPTION 'SELECTIVE_CLIENT_LEGACY_RECEIPT';
 END IF;
 IF g.payload->'selection'->'version' IN ('3'::jsonb,'4'::jsonb) THEN
  expected_audit:=expected_audit || jsonb_build_object('companyCount',jsonb_array_length(g.payload->'selection'->'companies'),
   'companyFieldCount',(SELECT COALESCE(sum(jsonb_array_length(x->'fields')),0) FROM jsonb_array_elements(g.payload->'selection'->'companies') x));
  IF c.receipt->'companyCount' IS DISTINCT FROM expected_audit->'companyCount'
   OR c.receipt->'companyFieldCount' IS DISTINCT FROM expected_audit->'companyFieldCount' THEN
   RAISE EXCEPTION 'SELECTIVE_CLIENT_COMPANY_ATOMIC_RECEIPT'; END IF;
 ELSIF c.receipt ? 'companyCount' OR c.receipt ? 'companyFieldCount' THEN
  RAISE EXCEPTION 'SELECTIVE_CLIENT_LEGACY_COMPANY_RECEIPT';
 END IF;
 IF g.payload->'selection'->'version'='4'::jsonb THEN
  expected_audit:=expected_audit || jsonb_build_object('personCount',jsonb_array_length(g.payload->'selection'->'people'),
   'personFieldCount',(SELECT COALESCE(sum(jsonb_array_length(x->'fields')),0) FROM jsonb_array_elements(g.payload->'selection'->'people') x));
  IF c.receipt->'personCount' IS DISTINCT FROM expected_audit->'personCount'
   OR c.receipt->'personFieldCount' IS DISTINCT FROM expected_audit->'personFieldCount' THEN
   RAISE EXCEPTION 'SELECTIVE_CLIENT_PERSON_ATOMIC_RECEIPT'; END IF;
 ELSIF c.receipt ? 'personCount' OR c.receipt ? 'personFieldCount' THEN
  RAISE EXCEPTION 'SELECTIVE_CLIENT_LEGACY_PERSON_RECEIPT';
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
