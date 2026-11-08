#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$ADMIN_RECORD_EVIDENCE/migration75"
mkdir -p "$evidence/baseline74"
ddl=prisma/migrations/20261101090000_ordinary_email_reconciliation_v1/migration.sql
git archive 562bfae09c73c8d93332630b5381e764488a4cab prisma | tar -x -C "$evidence/baseline74"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 74
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/prior-tables.txt"
footprint() {
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  printf '%s|' "$table" >> "$1"
  psql "${2:-$db}" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/prior-tables.txt"
}
footprint "$evidence/before.txt"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix74-before.txt"
psql "$db" -Atc "SELECT pg_get_functiondef('ordinary_email_attempt_binding()'::regprocedure)" > "$evidence/original-guard.sql"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/baseline74/prisma/schema.prisma" --script > "$evidence/drift-before.sql"
pg_dump "$db" -Fc > "$evidence/baseline74.dump"
psql "$db" -v ON_ERROR_STOP=1 -c 'CREATE DATABASE fai_crm_recovery_restore_test'
restore="${db%/fai_crm_test}/fai_crm_recovery_restore_test"
pg_restore --exit-on-error --dbname="$restore" "$evidence/baseline74.dump"
footprint "$evidence/restored.txt" "$restore"
cmp "$evidence/before.txt" "$evidence/restored.txt"
psql "$restore" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/restored-prefix.txt"
cmp "$evidence/prefix74-before.txt" "$evidence/restored-prefix.txt"
python3 - "$ddl" "$evidence/wrong-base.sql" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
assert s.count('BEGIN;')==1
s=s.replace('BEGIN;',"""BEGIN;
UPDATE "_prisma_migrations" SET checksum=repeat('0',64) WHERE migration_name='20261030190000_admin_residual_provenance_v1';""",1)
Path(sys.argv[2]).write_text(s)
PY
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/wrong-base.sql" > "$evidence/wrong-base.log" 2>&1; then exit 1; fi
grep -Fq ORDINARY_EMAIL_RECONCILIATION_SCHEMA74_REQUIRED "$evidence/wrong-base.log"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT to_regclass('public.\"OrdinaryEmailReconciliation\"') IS NULL")" = t
psql "$db" -Atc "SELECT pg_get_functiondef('ordinary_email_attempt_binding()'::regprocedure)" > "$evidence/original-guard-after-fault.sql"
cmp "$evidence/original-guard.sql" "$evidence/original-guard-after-fault.sql"
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix74-after-fault.txt"
cmp "$evidence/prefix74-before.txt" "$evidence/prefix74-after-fault.txt"
mkdir -p "$evidence/schema75"
git archive 1a5195730b1b396354ec405118bcbb8187c72311 prisma | tar -x -C "$evidence/schema75"
npx prisma migrate deploy --schema "$evidence/schema75/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 75
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261101090000_ordinary_email_reconciliation_v1' ORDER BY migration_name" > "$evidence/prefix74-after.txt"
cmp "$evidence/prefix74-before.txt" "$evidence/prefix74-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "OrdinaryEmailReconciliation"')" = 0
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq ORDINARY_EMAIL_RECONCILIATION_SCHEMA74_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema75/prisma/schema.prisma" --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
sha256sum "$ddl" "$evidence/baseline74.dump" > "$evidence/sha256.txt"
printf '{"synthetic":true,"before":74,"after":75,"prefix74Unchanged":true,"allPriorRowsPreserved":true,"backupAndRestoreEqual":true,"atomicFailureRolledBack":true,"originalGuardRestoredOnFailure":true,"wrongBaseDenied":true,"replayDenied":true,"datamodelDriftUnchanged":true,"newRecoveryTableEmpty":true,"productionContact":false}\n' > "$evidence/proof.json"
cat "$evidence/proof.json"
