#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$ADMIN_RECORD_EVIDENCE/migration72"
mkdir -p "$evidence/baseline71"
ddl=prisma/migrations/20261029190000_admin_record_revisions_v1/migration.sql
# A wrong base must fail before creating any journal object.
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/wrong-base.log" 2>&1; then exit 1; fi
test "$(psql "$db" -Atc "SELECT to_regclass('public.\"AdminRecordRevision\"') IS NULL")" = t
git archive 60b7b1ea78c85c945b7637f75c3c5e312a508e04 prisma | tar -x -C "$evidence/baseline71"
npx prisma migrate deploy --schema "$evidence/baseline71/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 71
psql "$db" -v ON_ERROR_STOP=1 -c "INSERT INTO \"Client\"(id,\"displayName\",type,\"updatedAt\") VALUES ('admin-synthetic-migration-client','Cliente migrazione sintetico','societa',clock_timestamp())"
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/prior-tables.txt"
footprint() {
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  printf '%s|' "$table" >> "$1"
  psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/prior-tables.txt"
}
footprint "$evidence/before.txt"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix71-before.txt"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/baseline71/prisma/schema.prisma" --script > "$evidence/drift-before.sql"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT to_regclass('public.\"AdminRecordRevision\"') IS NULL")" = t
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'fai_admin_record_revision_%'")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npm run prisma:migrate:deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 72
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261029190000_admin_record_revisions_v1' ORDER BY migration_name" > "$evidence/prefix71-after.txt"
cmp "$evidence/prefix71-before.txt" "$evidence/prefix71-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "AdminRecordRevision"')" = 0
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq ADMIN_RECORD_SCHEMA71_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
sha256sum "$ddl" > "$evidence/ddl-sha256.txt"
printf '{"synthetic":true,"before":71,"after":72,"prefix71Unchanged":true,"allPriorRowsPreserved":true,"emptyNewJournal":true,"atomicFailureRolledBack":true,"wrongBaseDenied":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/proof.json"
cat "$evidence/proof.json"
