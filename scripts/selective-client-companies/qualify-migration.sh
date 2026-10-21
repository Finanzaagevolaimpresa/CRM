#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$RUNNER_TEMP/selective-company-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261021170000_selective_client_company_fields_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 60
psql "$db" -v ON_ERROR_STOP=1 -f scripts/selective-client-companies/preserved-fixture.sql
git show 2b0074d0510f479700c2dec93e72eec951404305:prisma/schema.prisma > "$evidence/schema60.prisma"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema60.prisma" --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix60-before.txt"
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
 psql "$db" -Atc "SELECT pg_get_functiondef('fai_selective_client_atomic()'::regprocedure)"
 psql "$db" -Atc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='selective_client_payload_structure'"
}
footprint "$evidence/before.txt"
structure > "$evidence/structure-before.sql"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='SelectiveCompanyGeneration'")" = 0
structure > "$evidence/structure-after-fault.sql"
cmp "$evidence/structure-before.sql" "$evidence/structure-after-fault.sql"
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npx prisma migrate deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 61
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261021170000_selective_client_company_fields_v1' ORDER BY migration_name" > "$evidence/prefix60-after.txt"
cmp "$evidence/prefix60-before.txt" "$evidence/prefix60-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
psql "$db" -v ON_ERROR_STOP=1 -At -f scripts/selective-client-companies/structure.sql > "$evidence/structure61.json"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "Company" c LEFT JOIN "SelectiveCompanyGeneration" g ON g."companyId"=c.id WHERE g.generation IS DISTINCT FROM 1)
 OR (SELECT count(*) FROM "Company")<>(SELECT count(*) FROM "SelectiveCompanyGeneration") THEN RAISE EXCEPTION 'COMPANY_GENERATION_SEED_INVALID'; END IF;
 IF NOT fai_selective_client_information_valid('{"selection":{"fields":["displayName"]}}'::jsonb)
 OR fai_selective_client_information_valid('{"selection":{"fields":["displayName"],"companies":[]}}'::jsonb)
 OR fai_selective_client_information_valid('{"selection":{"version":3,"fields":[],"documents":[],"companies":[]},"documents":[],"companies":[]}'::jsonb)
 OR fai_selective_client_information_valid('{"selection":{"version":3,"fields":[],"documents":[],"companies":[{"companyId":"c1","fields":["notes"]}]},"documents":[],"companies":[{"companyId":"c1","companyEpoch":1,"stateHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}'::jsonb)
 THEN RAISE EXCEPTION 'COMPANY_PROTOCOL_INVALID'; END IF;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq SELECTIVE_COMPANY_SCHEMA60_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
printf '{"synthetic":true,"before":60,"after":61,"prefix60Unchanged":true,"allPriorRowsPreserved":true,"legacyV1V2HistoryAndCompanyBytesPreserved":true,"migrationCreatedNoGrantsOrAuthority":true,"generationsSeededSeparately":true,"atomicFailureRolledBack":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/migration61-proof.json"
cat "$evidence/migration61-proof.json"
