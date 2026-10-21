#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$RUNNER_TEMP/selective-document-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261021080000_selective_client_documents_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 58
# Preserve the complete historical Prisma drift, including legacy defaults.
# No new mismatch is admitted by the migration to schema59.
baseline="$(node --input-type=module -e "import {readFileSync} from 'node:fs';process.stdout.write(JSON.parse(readFileSync('scripts/selective-client-documents/schema-binding.json','utf8')).baseline)")"
[[ "$baseline" =~ ^[a-f0-9]{40}$ ]]
git show "$baseline:prisma/schema.prisma" > "$evidence/schema58.prisma"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema58.prisma" --script > "$evidence/datamodel-diff-before.sql"
# A structurally valid historical V1 command is retained byte for byte. Its
# synthetic proof is deliberately unusable by the application HMAC verifier.
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $$ DECLARE uid text:=gen_random_uuid()::text; rid text:=gen_random_uuid()::text;
 cid text:=gen_random_uuid()::text; did text:=gen_random_uuid()::text;
 gid uuid:=gen_random_uuid(); cmd uuid:=gen_random_uuid(); rev uuid:=gen_random_uuid(); p jsonb; receipt jsonb;
BEGIN
 INSERT INTO "User"(id,email,name,role,"passwordHash","updatedAt") VALUES
 (uid,uid||'@invalid.test','Synthetic schema58 manager','admin','synthetic-unusable',now()),
 (rid,rid||'@invalid.test','Synthetic schema58 recipient','commerciale','synthetic-unusable',now());
 INSERT INTO "Client"(id,type,"displayName","salesOwnerId","updatedAt")
 VALUES(cid,'societa','Synthetic schema58 preserved client',uid,now());
 INSERT INTO "Document"(id,"clientId",type,title,"fileName","mimeType","sizeBytes","storagePath","uploadedById","updatedAt")
 VALUES(did,cid,'altro','Synthetic preserved document','preserved.txt','text/plain',9,'synthetic/not-a-real-file',uid,now());
 INSERT INTO "DocumentVersion"(id,"documentId",version,"storagePath",checksum)
 VALUES(gen_random_uuid()::text,did,1,'synthetic/not-a-real-file',repeat('0',64));
 p:=jsonb_build_object('id',gid::text,'revision',1,'approvedById',uid,'selection',
  jsonb_build_object('clientId',cid,'recipientId',rid,'revision',0,'commandId',cmd::text,'fields',jsonb_build_array('displayName')));
 receipt:=jsonb_build_object('protocol','SELECTIVE_CLIENT_RECEIPT_V1','commandId',cmd::text,'grantId',gid::text,
  'revisionId',rev::text,'revision',1,'operation','GRANT','fieldCount',1);
 INSERT INTO "SelectiveClientGrant"(id,"clientId","recipientId",revision,payload,proof)
 VALUES(gid,cid,rid,1,p,repeat('0',64));
 INSERT INTO "SelectiveClientCommand"(id,"actorId","sessionId","clientId","recipientId","expectedRevision",operation,"requestDigest",receipt,"receiptProof")
 VALUES(cmd,uid,gen_random_uuid(),cid,rid,0,'GRANT',repeat('0',64),receipt,repeat('0',64));
 INSERT INTO "SelectiveClientRevision"(id,"grantId",revision,"commandId",payload,proof)
 VALUES(rev,gid,1,cmd,p,repeat('0',64));
 INSERT INTO "AuditLog"(id,"actorId",event,"entityType","entityId","before","after")
 VALUES(rev::text,uid,'selective_client_changed','SelectiveClientRevision',rev::text,
  jsonb_build_object('version',0),jsonb_build_object('version',1,'action','GRANT','fieldCount',1));
END $$;
COMMIT;
SQL
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix58-before.txt"
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/legacy-tables.txt"
footprint() {
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  columns="ARRAY[]::text[]"
  if [[ "$table" == Document ]]; then columns="ARRAY['selectiveEpoch']"; fi
  printf '%s|' "$table" >> "$1"
  psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg((to_jsonb(t)-$columns)::text,E'\n' ORDER BY (to_jsonb(t)-$columns)::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/legacy-tables.txt"
}
footprint "$evidence/before.txt"
psql "$db" -Atc "SELECT pg_get_functiondef('fai_selective_client_atomic()'::regprocedure)" > "$evidence/atomic-before.sql"
psql "$db" -Atc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='selective_client_payload_structure'" > "$evidence/constraint-before.sql"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='Document' AND column_name='selectiveEpoch'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'fai_selected_document_%' OR proname='fai_selective_client_documents_valid')")" = 0
psql "$db" -Atc "SELECT pg_get_functiondef('fai_selective_client_atomic()'::regprocedure)" > "$evidence/atomic-after-fault.sql"
psql "$db" -Atc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='selective_client_payload_structure'" > "$evidence/constraint-after-fault.sql"
cmp "$evidence/atomic-before.sql" "$evidence/atomic-after-fault.sql"
cmp "$evidence/constraint-before.sql" "$evidence/constraint-after-fault.sql"
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
historical="$RUNNER_TEMP/selective-practice-document-historical-schema59"
mkdir -p "$historical"
git archive 64d8f4e4d761fdae6429f019f249f8f1fb3c55be prisma | tar -x -C "$historical"
npx prisma migrate deploy --schema "$historical/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 59
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261021080000_selective_client_documents_v1' ORDER BY migration_name" > "$evidence/prefix58-after.txt"
cmp "$evidence/prefix58-before.txt" "$evidence/prefix58-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "Document" WHERE "selectiveEpoch"<>1')" = 0
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE did text; old_title text; old_updated timestamp(3); epoch integer;
BEGIN
 SELECT id,title,"updatedAt","selectiveEpoch" INTO STRICT did,old_title,old_updated,epoch
 FROM "Document" WHERE "storagePath"='synthetic/not-a-real-file';
 UPDATE "Document" SET title='Synthetic changed title' WHERE id=did;
 UPDATE "Document" SET title=old_title,"updatedAt"=old_updated WHERE id=did;
 IF (SELECT "selectiveEpoch" FROM "Document" WHERE id=did)<>epoch+2 THEN RAISE EXCEPTION 'DOCUMENT_REVERT_REVIVED_GENERATION'; END IF;
 BEGIN
  UPDATE "Document" SET "selectiveEpoch"=epoch WHERE id=did;
  RAISE EXCEPTION 'EXPECTED_EPOCH_REJECTION';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'SELECTED_DOCUMENT_EPOCH_MONOTONIC' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'selected_document_%')<>8
 THEN RAISE EXCEPTION 'DOCUMENT_REFERENCE_TRIGGER_COUNT'; END IF;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq SELECTIVE_DOCUMENT_SCHEMA58_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/datamodel-diff.sql"
cmp "$evidence/datamodel-diff-before.sql" "$evidence/datamodel-diff.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/datamodel-diff.sql"
psql "$db" -X -qAt -v ON_ERROR_STOP=1 -f scripts/selective-client-documents/structure-readonly.sql > "$evidence/structure59.json"
node --input-type=module - "$evidence/datamodel-diff.sql" "$ddl" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const binding=JSON.parse(readFileSync('scripts/selective-client-documents/schema-binding.json','utf8'));
assert.equal(createHash('sha256').update(readFileSync(process.argv[3])).digest('hex'),binding.migrationSha256);
assert.doesNotMatch(readFileSync(process.argv[2],'utf8'), /selectiveEpoch/);
JS
printf '{"synthetic":true,"before":58,"after":59,"prefix58Unchanged":true,"allLegacyRowsPreserved":true,"legacyV1CommandHistoryAndAuditPreserved":true,"migrationCreatedNoGrantsOrAuthority":true,"atomicFailureRolledBack":true,"replayDenied":true,"documentGenerationMonotonic":true,"productionContact":false}\n' > "$evidence/migration59-proof.json"
cat "$evidence/migration59-proof.json"
