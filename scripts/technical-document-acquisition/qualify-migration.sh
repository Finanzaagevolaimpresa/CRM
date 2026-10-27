#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 67
evidence="$TECHNICAL_UPLOAD_EVIDENCE/migration68"
mkdir -p "$evidence"
ddl=prisma/migrations/20261024190000_technical_document_acquisition_v1/migration.sql
git show 5acb9e9e0f87d14fa3075b2f6dfe307352f9ffa7:prisma/schema.prisma > "$evidence/schema67.prisma"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema67.prisma" --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix67-before.txt"
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
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='TechnicalDocumentAcquisition'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE proname IN ('fai_technical_acquisition_atomic','fai_technical_canonical_atomic','fai_technical_canonical_immutable')")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
historical68="$RUNNER_TEMP/acquisition-immutable-schema68"
mkdir -p "$historical68"
git archive f04cb9936085636a5ed2f56cc8967ea854b81480 prisma | tar -x -C "$historical68"
npx prisma migrate deploy --schema "$historical68/prisma/schema.prisma"
psql "$db" -At -v ON_ERROR_STOP=1 -f scripts/technical-document-acquisition/structure.sql > "$evidence/structure68.json"
node -e 'const fs=require("node:fs"),a=require("node:assert/strict"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));a.deepEqual(v.tables.map(x=>x.name),["TechnicalDocumentAcquisition"]);a.equal(v.columns.length,10);a.equal(v.functions.length,3);a.equal(v.triggers.length,7);a.equal(v.triggers.filter(x=>x.deferrable&&x.initiallyDeferred).length,3);a.equal(v.constraints.filter(x=>x.type==="f").length,5)' "$evidence/structure68.json"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 68
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261024190000_technical_document_acquisition_v1' ORDER BY migration_name" > "$evidence/prefix67-after.txt"
cmp "$evidence/prefix67-before.txt" "$evidence/prefix67-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "TechnicalDocumentAcquisition"')" = 0
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq TECHNICAL_ACQUISITION_SCHEMA67_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$historical68/prisma/schema.prisma" --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
sha256sum "$ddl" > "$evidence/ddl-sha256.txt"
printf '{"synthetic":true,"before":67,"after":68,"prefix67Unchanged":true,"allPriorRowsPreserved":true,"newTableEmpty":true,"atomicFailureRolledBackAllObjects":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/proof.json"
npx prisma migrate deploy
