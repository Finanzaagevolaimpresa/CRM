#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 66
evidence="$TECHNICAL_UPLOAD_EVIDENCE/isolated-ddl"
mkdir -p "$evidence"
ddl=scripts/technical-upload/schema67-draft.sql
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename" > "$evidence/prior-tables.txt"
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
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='TechnicalUploadSubmission'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE proname='fai_technical_upload_atomic'")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/applied.log"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "TechnicalUploadSubmission"')" = 0
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 66
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'technical_upload_%' AND NOT tgisinternal")" = 3
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_trigger WHERE tgname='technical_upload_atomic' AND tgdeferrable AND tginitdeferred")" = 1
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_constraint WHERE conrelid='\"TechnicalUploadSubmission\"'::regclass AND contype='f'")" = 2
sha256sum "$ddl" > "$evidence/ddl-sha256.txt"
printf '{"synthetic":true,"migrationCount":66,"draftOutsidePrisma":true,"priorRowsAndHistoryUnchanged":true,"newSubmissionTableEmpty":true,"atomicFailureRolledBackAllObjects":true,"productionContact":false}\n' > "$evidence/proof.json"
