#!/usr/bin/env bash
set -Eeuo pipefail
test "${CI:-}" = true
test "${GITHUB_ACTIONS:-}" = true
test "${APP_ENV:-}" = test
test "${ORDINARY_EMAIL_STORE_CONFIRMED:-}" = 1
# This qualification script is CI-only; the migration itself has no test bypass.
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
node scripts/m4/verify-schema.mjs
evidence="$RUNNER_TEMP/ordinary-email"
prior="$RUNNER_TEMP/ordinary-schema-prior"
mkdir -p "$evidence" "$prior"
db="${DATABASE_URL%%\?*}"
ddl=prisma/migrations/20261017120000_ordinary_email_v1/migration.sql
# Schema49 must refuse the new migration before making any objects.
git archive c2948f387dfe7235bbdaf19f501b676cbf36aba2 prisma | tar -x -C "$prior"
npx prisma migrate deploy --schema "$prior/prisma/schema.prisma"
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/wrong-base.log" 2>&1; then exit 1; fi
grep -Fq ORDINARY_EMAIL_MIGRATION51_BASE_REQUIRED "$evidence/wrong-base.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'OrdinaryEmail%'")" = 0
git archive 57b265e9829b9ccd9ffe86314db9ef7071d1c2e7 prisma | tar -x -C "$prior"
npx prisma migrate deploy --schema "$prior/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 50
# The next context migration must also refuse schema50 without any new object.
if psql "$db" -v ON_ERROR_STOP=1 -f prisma/migrations/20261017160000_admin_email_contexts_v1/migration.sql > "$evidence/context-wrong-base.log" 2>&1; then exit 1; fi
grep -Fq ADMIN_EMAIL_MIGRATION52_BASE_REQUIRED "$evidence/context-wrong-base.log"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix50-before.txt"
# Historical synthetic-only SQL stays guarded and is never the release migration.
for historical in scripts/ordinary-email/storage-candidate.sql scripts/ordinary-email/inbound-candidate.sql; do
  if psql "$db" -v ON_ERROR_STOP=1 -f "$historical" > "$evidence/historical-guard.log" 2>&1; then exit 1; fi
  grep -Fq ORDINARY_EMAIL_SYNTHETIC_DATABASE_REQUIRED "$evidence/historical-guard.log"
done
psql "$db" -v ON_ERROR_STOP=1 -c "COMMENT ON DATABASE fai_crm_test IS 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1'"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'OrdinaryEmail%'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'ordinary_email_%' OR proname LIKE 'ordinary_inbound_%')")" = 0
git archive 5f0d6e00b3cf08d4f789eb94fcde29ed27720cf4 prisma | tar -x -C "$prior"
npx prisma migrate deploy --schema "$prior/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 51
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261017120000_ordinary_email_v1' ORDER BY migration_name" > "$evidence/prefix50-after.txt"
cmp "$evidence/prefix50-before.txt" "$evidence/prefix50-after.txt"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'OrdinaryEmail%'")" = 11
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE name text; total bigint; BEGIN
  FOR name IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'OrdinaryEmail%' LOOP
    EXECUTE format('SELECT count(*) FROM %I',name) INTO total;
    IF total<>0 THEN RAISE EXCEPTION 'ORDINARY_MIGRATION_MUST_NOT_BOOTSTRAP'; END IF;
  END LOOP;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq ORDINARY_EMAIL_MIGRATION51_BASE_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$prior/prisma/schema.prisma" --script > "$evidence/datamodel-diff.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/datamodel-diff.sql"
printf '{"synthetic":true,"before":50,"after":51,"tablesAdded":11,"newTablesEmpty":true,"prefix50Unchanged":true,"wrongBaseDenied":true,"atomicFailureRolledBackAllObjects":true,"replayDenied":true,"activation":false,"productionContact":false}\n' > "$evidence/migration51-proof.json"
cat "$evidence/migration51-proof.json"

bash scripts/admin-email/qualify-migration.sh
bash scripts/record-updates/qualify-migration.sh

bash scripts/private-videos/qualify-migration.sh
bash scripts/record-update-email/qualify-migration.sh
bash scripts/selective-leads/qualify-migration.sh
bash scripts/selective-clients/qualify-migration.sh
bash scripts/selective-practices/qualify-migration.sh
bash scripts/selective-client-documents/qualify-migration.sh
bash scripts/selective-practice-documents/qualify-migration.sh
bash scripts/selective-client-companies/qualify-migration.sh
bash scripts/selective-client-people/qualify-migration.sh
bash scripts/selective-lead-edit/qualify-migration.sh
bash scripts/technical-assignments/qualify-migration.sh

bash scripts/admin-requests/qualify-migration.sh
