#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
evidence="$RUNNER_TEMP/record-updates-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261017200000_record_update_notifications_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 52
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix52-before.txt"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "User"("id","name","email","role","passwordHash","updatedAt") VALUES ('updates53-user','Synthetic old user','updates53@invalid.test','admin','unusable-synthetic',now());
INSERT INTO "Lead"("id","firstName","lastName","assignedToId","updatedAt") VALUES ('updates53-lead','Synthetic','Old lead','updates53-user',now());
INSERT INTO "Client"("id","type","displayName","updatedAt") VALUES ('updates53-client','societa','Synthetic old client',now());
INSERT INTO "Project"("id","clientId","title","updatedAt") VALUES ('updates53-project','updates53-client','Synthetic old project',now());
SQL
footprint() {
  local output="$1"
  : > "$output"
  for table in User Lead Client Project ClientService TechnicalPractice ApprovedCommunication CommunicationVersion CommunicationMailbox InternalCommunicationThread InternalCommunicationParticipant InternalSession; do
    printf '%s|' "$table" >> "$output"
    psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg((to_jsonb(t)-'recordUpdateEpoch')::text,E'\n' ORDER BY (to_jsonb(t)-'recordUpdateEpoch')::text),'')) FROM \"$table\" t" >> "$output"
  done
}
footprint "$evidence/before.txt"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'RecordUpdate%'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='recordUpdateEpoch'")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npm run prisma:migrate:deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 53
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261017200000_record_update_notifications_v1' ORDER BY migration_name" > "$evidence/prefix52-after.txt"
cmp "$evidence/prefix52-before.txt" "$evidence/prefix52-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE n text; total bigint; BEGIN
 FOR n IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'RecordUpdate%' LOOP
  EXECUTE format('SELECT count(*) FROM %I',n) INTO total;
  IF total<>0 THEN RAISE EXCEPTION 'UPDATE_MIGRATION_MUST_NOT_BOOTSTRAP'; END IF;
 END LOOP;
 IF (SELECT "recordUpdateEpoch" FROM "Lead" WHERE id='updates53-lead')<>1 THEN RAISE EXCEPTION 'UPDATE_EPOCH_NOT_INITIALIZED'; END IF;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq RECORD_UPDATE_MIGRATION53_BASE_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/datamodel-diff.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/datamodel-diff.sql"
node --input-type=module - "$evidence/datamodel-diff.sql" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const diff=readFileSync(process.argv[2],'utf8');
assert.doesNotMatch(diff,/DROP (?:TABLE|CONSTRAINT) "RecordUpdate|ALTER TABLE "RecordUpdate|DROP COLUMN "recordUpdateEpoch"/);
JS
printf '{"synthetic":true,"before":52,"after":53,"newTablesEmpty":true,"prefix52Unchanged":true,"legacyRowsPreserved":true,"atomicFailureRolledBack":true,"replayDenied":true,"productionContact":false}\n' > "$evidence/migration53-proof.json"
cat "$evidence/migration53-proof.json"
