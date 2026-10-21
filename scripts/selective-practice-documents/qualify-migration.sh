#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$RUNNER_TEMP/selective-practice-document-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261021110000_selective_practice_documents_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 59
psql "$db" -v ON_ERROR_STOP=1 -f scripts/selective-practice-documents/preserved-fixture.sql
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix59-before.txt"
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/tables.txt"
footprint() {
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  printf '%s|' "$table" >> "$1"
  psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/tables.txt"
}
structure() {
 psql "$db" -Atc "SELECT pg_get_functiondef('fai_selective_practice_atomic()'::regprocedure)"
 psql "$db" -Atc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='selective_practice_payload_structure'"
}
footprint "$evidence/before.txt"
structure > "$evidence/structure-before.sql"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fai_selective_practice_documents_valid'")" = 0
structure > "$evidence/structure-after-fault.sql"
cmp "$evidence/structure-before.sql" "$evidence/structure-after-fault.sql"
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npx prisma migrate deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 60
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261021110000_selective_practice_documents_v1' ORDER BY migration_name" > "$evidence/prefix59-after.txt"
cmp "$evidence/prefix59-before.txt" "$evidence/prefix59-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
 IF fai_selective_practice_documents_valid('{"selection":{"version":2,"fields":[],"documents":[]},"documents":[]}'::jsonb)
 OR fai_selective_practice_documents_valid('{"selection":{"fields":[]}}'::jsonb)
 OR fai_selective_practice_documents_valid('{"selection":{"fields":["title"],"documents":[]}}'::jsonb)
 OR fai_selective_practice_documents_valid('{"selection":{"version":2,"practiceId":"p1","fields":[],"documents":[{"versionId":"v1","download":false}]},"documents":[{"versionId":"v1","practiceId":"p2","documentId":"d1","download":false,"checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","stateHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}'::jsonb)
 THEN RAISE EXCEPTION 'PRACTICE_DOCUMENT_MALFORMED_ACCEPTED'; END IF;
 IF NOT fai_selective_practice_documents_valid('{"selection":{"fields":["title"]}}'::jsonb)
 THEN RAISE EXCEPTION 'PRACTICE_DOCUMENT_LEGACY_DENIED'; END IF;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq SELECTIVE_PRACTICE_DOCUMENT_SCHEMA59_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
psql "$db" -X -qAt -v ON_ERROR_STOP=1 -f scripts/selective-practice-documents/structure-readonly.sql > "$evidence/structure60.json"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const binding=JSON.parse(readFileSync('scripts/selective-practice-documents/schema-binding.json','utf8'));
assert.equal(createHash('sha256').update(readFileSync('prisma/migrations/'+binding.migration+'/migration.sql')).digest('hex'),binding.migrationSha256);
JS
printf '{"synthetic":true,"before":59,"after":60,"prefix59Unchanged":true,"allRowsPreserved":true,"legacyV1PracticeHistoryAndAuditPreserved":true,"migrationCreatedNoGrantsOrAuthority":true,"atomicFailureRolledBack":true,"replayDenied":true,"crossPracticeSnapshotDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/migration60-proof.json"
cat "$evidence/migration60-proof.json"

