#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$RUNNER_TEMP/admin-request-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261023160000_admin_request_queue_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 64
git show 4c2fe838e9c557d59802a71aa4f42fbae5c74327:prisma/schema.prisma > "$evidence/schema64.prisma"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema64.prisma" --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix64-before.txt"
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/tables.txt"
footprint() {
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  printf '%s|' "$table" >> "$1"
  psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/tables.txt"
}
footprint "$evidence/before.txt"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('AdminRequest','AdminRequestEvent','AdminRequestDraft')")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npx prisma migrate deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 65
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261023160000_admin_request_queue_v1' ORDER BY migration_name" > "$evidence/prefix64-after.txt"
cmp "$evidence/prefix64-before.txt" "$evidence/prefix64-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT (SELECT count(*) FROM "AdminRequest")+(SELECT count(*) FROM "AdminRequestEvent")+(SELECT count(*) FROM "AdminRequestDraft")')" = 0
psql "$db" -v ON_ERROR_STOP=1 -At -f scripts/admin-requests/structure.sql > "$evidence/structure65.json"
node -e 'const a=require("node:assert/strict"),s=require(process.argv[1]); a.deepEqual(s.tables.map(t=>t.name),["AdminRequest","AdminRequestDraft","AdminRequestEvent"]); a.equal(s.functions.length,3); a.equal(s.triggers.length,9); a.equal(s.constraints.filter(c=>c.type==="f").length,11); a.equal(s.triggers.filter(t=>t.deferrable&&t.initiallyDeferred).length,3); a(s.tables.every(t=>t.kind==="r"&&t.persistence==="p"&&t.ownerMatches)); a(s.constraints.every(c=>c.validated));' "$evidence/structure65.json"
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq ADMIN_REQUEST_SCHEMA64_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
printf '{"synthetic":true,"before":64,"after":65,"prefix64Unchanged":true,"allPriorRowsPreserved":true,"newTablesEmpty":true,"atomicFailureRolledBackAllObjects":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/migration65-proof.json"
