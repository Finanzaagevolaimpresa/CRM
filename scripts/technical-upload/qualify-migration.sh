#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 66
evidence="$TECHNICAL_UPLOAD_EVIDENCE/migration67"
mkdir -p "$evidence"
ddl=prisma/migrations/20261024160000_technical_document_upload_v1/migration.sql
# Preserve non-empty canonical rows and every historical checksum.
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "Client"(id,type,"displayName","updatedAt") VALUES('csyntheticmigration67client','societa','Synthetic upload preservation',now());
INSERT INTO "Task"(id,"clientId",title,"updatedAt") VALUES('csyntheticmigration67task','csyntheticmigration67client','Synthetic retained task',now());
SQL
git show aa30d5c8ca4f483ae6cd0e77ec9fade8794646b4:prisma/schema.prisma > "$evidence/schema66.prisma"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema66.prisma" --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix66-before.txt"
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
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('TechnicalUploadSubmission','TechnicalUploadReview')")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE proname IN ('fai_technical_upload_atomic','fai_technical_upload_review_atomic')")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npx prisma migrate deploy
psql "$db" -At -v ON_ERROR_STOP=1 -f scripts/technical-upload/structure.sql > "$evidence/structure67.json"
node -e 'const fs=require("node:fs"),a=require("node:assert/strict"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));a.deepEqual(v.tables.map(x=>x.name),["TechnicalUploadReview","TechnicalUploadSubmission"]);a.equal(v.columns.length,26);a.equal(v.functions.length,2);a.equal(v.triggers.length,6);a.equal(v.triggers.filter(x=>x.deferrable&&x.initiallyDeferred).length,2);a.equal(v.constraints.filter(x=>x.type==="f").length,4)' "$evidence/structure67.json"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 67
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261024160000_technical_document_upload_v1' ORDER BY migration_name" > "$evidence/prefix66-after.txt"
cmp "$evidence/prefix66-before.txt" "$evidence/prefix66-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT (SELECT count(*) FROM "TechnicalUploadSubmission")+(SELECT count(*) FROM "TechnicalUploadReview")')" = 0
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq TECHNICAL_UPLOAD_SCHEMA66_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
sha256sum "$ddl" > "$evidence/ddl-sha256.txt"
printf '{"synthetic":true,"before":66,"after":67,"prefix66Unchanged":true,"allPriorRowsPreserved":true,"newTablesEmpty":true,"atomicFailureRolledBackAllObjects":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/proof.json"
