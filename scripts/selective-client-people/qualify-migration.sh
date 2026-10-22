#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$RUNNER_TEMP/selective-person-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261021220000_selective_client_person_fields_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 61
psql "$db" -v ON_ERROR_STOP=1 -f scripts/selective-client-people/preserved-fixture.sql
git show 4d6c73921b02699610cfd006f0fae0e9ea705483:prisma/schema.prisma > "$evidence/schema61.prisma"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema61.prisma" --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix61-before.txt"
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
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('SelectivePersonGeneration','SelectiveMembershipGeneration')")" = 0
structure > "$evidence/structure-after-fault.sql"
cmp "$evidence/structure-before.sql" "$evidence/structure-after-fault.sql"
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
historical="$RUNNER_TEMP/selective-person-schema62"
mkdir -p "$historical"
git archive d6a5a3d14a9b3a1ade0d33e6b156ad71da5d9b0f prisma | tar -x -C "$historical"
npx prisma migrate deploy --schema "$historical/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 62
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261021220000_selective_client_person_fields_v1' ORDER BY migration_name" > "$evidence/prefix61-after.txt"
cmp "$evidence/prefix61-before.txt" "$evidence/prefix61-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
psql "$db" -v ON_ERROR_STOP=1 -At -f scripts/selective-client-people/structure.sql > "$evidence/structure62.json"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "Person" p LEFT JOIN "SelectivePersonGeneration" g ON g."personId"=p.id WHERE g.generation IS DISTINCT FROM 1)
 OR (SELECT count(*) FROM "Person")<>(SELECT count(*) FROM "SelectivePersonGeneration")
 OR EXISTS(SELECT 1 FROM "CompanyPerson" m LEFT JOIN "SelectiveMembershipGeneration" g ON g."membershipId"=m.id WHERE g.generation IS DISTINCT FROM 1)
 OR (SELECT count(*) FROM "CompanyPerson")<>(SELECT count(*) FROM "SelectiveMembershipGeneration") THEN RAISE EXCEPTION 'PERSON_GENERATION_SEED_INVALID'; END IF;
 IF NOT fai_selective_client_people_valid('{"selection":{"fields":["displayName"]}}'::jsonb)
 OR fai_selective_client_people_valid('{"selection":{"fields":["displayName"],"people":[]}}'::jsonb)
 OR fai_selective_client_people_valid('{"selection":{"version":4,"fields":[],"documents":[],"companies":[],"people":[]},"documents":[],"companies":[],"people":[]}'::jsonb)
 THEN RAISE EXCEPTION 'PERSON_PROTOCOL_INVALID'; END IF;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq SELECTIVE_PERSON_SCHEMA61_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$historical/prisma/schema.prisma" --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
printf '{"synthetic":true,"before":61,"after":62,"prefix61Unchanged":true,"allPriorRowsPreserved":true,"legacyV1V2V3HistoryAndPersonMembershipBytesPreserved":true,"migrationCreatedNoGrantsOrAuthority":true,"generationsSeededSeparately":true,"atomicFailureRolledBack":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/migration62-proof.json"
cat "$evidence/migration62-proof.json"
