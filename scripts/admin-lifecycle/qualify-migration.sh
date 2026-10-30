#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$ADMIN_RECORD_EVIDENCE/migration73"
mkdir -p "$evidence"
ddl=prisma/migrations/20261030100000_admin_operational_lifecycle_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 72
node --import tsx tests/admin-lifecycle/migration-fixture.ts > "$evidence/seed72.log"
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
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix72-before.txt"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$ADMIN_RECORD_EVIDENCE/migration72/baseline72/prisma/schema.prisma" --script > "$evidence/drift-before.sql"
# The checksum mutation is confined to a transaction in the owned synthetic DB.
# The candidate guard must reject it and leave the ledger unchanged on failure.
python3 - "$ddl" "$evidence/wrong-base.sql" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
assert s.count('BEGIN;')==1
s=s.replace('BEGIN;',"""BEGIN;
UPDATE "_prisma_migrations" SET checksum=repeat('0',64) WHERE migration_name='20261029190000_admin_record_revisions_v1';""",1)
Path(sys.argv[2]).write_text(s)
PY
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/wrong-base.sql" > "$evidence/wrong-base.log" 2>&1; then exit 1; fi
grep -Fq ADMIN_OPERATIONAL_SCHEMA72_REQUIRED "$evidence/wrong-base.log"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix72-after-wrong-base.txt"
cmp "$evidence/prefix72-before.txt" "$evidence/prefix72-after-wrong-base.txt"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT to_regclass('public.\"AdminOperationalState\"') IS NULL")" = t
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'fai_admin_operational_%' OR p.proname LIKE 'fai_require_admin_%')")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npm run prisma:migrate:deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 73
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261030100000_admin_operational_lifecycle_v1' ORDER BY migration_name" > "$evidence/prefix72-after.txt"
cmp "$evidence/prefix72-before.txt" "$evidence/prefix72-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "AdminOperationalState" WHERE state<>'ACTIVE' OR version<>0 OR "lastCommandId" IS NOT NULL) THEN RAISE EXCEPTION 'INITIAL_STATE_CHANGED'; END IF;
 IF (SELECT count(*) FROM "AdminOperationalState") <>
   (SELECT count(*) FROM "ControlledIntake")+(SELECT count(*) FROM "PracticeReadiness")+(SELECT count(*) FROM "ApprovedCommunication")+
   (SELECT count(*) FROM "CommunicationReply")+(SELECT count(*) FROM "Document" WHERE "visibilityLevel"='technical_admin_private_v1')
 THEN RAISE EXCEPTION 'SOURCE_ENROLLMENT_MISMATCH'; END IF;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq ADMIN_OPERATIONAL_SCHEMA72_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
sha256sum "$ddl" > "$evidence/ddl-sha256.txt"
printf '{"synthetic":true,"before":72,"after":73,"prefix72Unchanged":true,"allPriorRowsPreserved":true,"initialSourcesEnrolledAtActiveZero":true,"atomicFailureRolledBack":true,"wrongBaseDenied":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/proof.json"
cat "$evidence/proof.json"
