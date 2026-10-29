#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$RECORD_REMINDER_EVIDENCE/migration71"
mkdir -p "$evidence/baseline70"
git archive f1818bde23496b310a297b4f0ed3260bdce85e33 prisma | tar -x -C "$evidence/baseline70"
npx prisma migrate deploy --schema "$evidence/baseline70/prisma/schema.prisma"
node --import tsx tests/record-reminders/migration-state.ts
ddl=prisma/migrations/20261028180000_record_deadline_reminders_v1/migration.sql
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/baseline70/prisma/schema.prisma" --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix70-before.txt"
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/prior-tables.txt"
footprint() {
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  printf '%s|' "$table" >> "$1"
  psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/prior-tables.txt"
}
constraint() { psql "$db" -Atc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='RecordUpdateCommand_operation_check'"; }
footprint "$evidence/before.txt"
constraint > "$evidence/constraint-before.txt"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('RecordUpdateReminder','RecordUpdateReminderCancellation')")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'fai_record_reminder_%'")" = 0
footprint "$evidence/after-fault.txt"
constraint > "$evidence/constraint-after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
cmp "$evidence/constraint-before.txt" "$evidence/constraint-after-fault.txt"
npm run prisma:migrate:deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 71
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261028180000_record_deadline_reminders_v1' ORDER BY migration_name" > "$evidence/prefix70-after.txt"
cmp "$evidence/prefix70-before.txt" "$evidence/prefix70-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT (SELECT count(*) FROM "RecordUpdateReminder")+(SELECT count(*) FROM "RecordUpdateReminderCancellation")')" = 0
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq RECORD_REMINDER_SCHEMA70_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
sha256sum "$ddl" > "$evidence/ddl-sha256.txt"
psql "$db" -X -At -v ON_ERROR_STOP=1 -f scripts/record-reminders/schema71-structure.sql > "$evidence/structure.json"
node scripts/record-reminders/verify-structure.mjs "$evidence/structure.json"
printf '{"synthetic":true,"before":70,"after":71,"prefix70Unchanged":true,"allPriorRowsAndRelationsPreserved":true,"previousUpdatesAndReadReceiptsPreserved":true,"newTablesEmpty":true,"atomicFailureRolledBackAllObjects":true,"previousCommandConstraintRestoredOnFailure":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/proof.json"
cat "$evidence/proof.json"
