#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$ADMIN_RECORD_EVIDENCE/migration74"
mkdir -p "$evidence/baseline73"
ddl=prisma/migrations/20261030190000_admin_residual_provenance_v1/migration.sql
git archive bbc76e18a64b8e3ff75c51fe7d966ae31e5f2fd2 prisma | tar -x -C "$evidence/baseline73"
npx prisma migrate deploy --schema "$evidence/baseline73/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 73
node --import tsx tests/admin-residuals/migration-fixture.ts > "$evidence/seed73.json"
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
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix73-before.txt"
psql "$db" -Atc "SELECT pg_get_functiondef('fai_technical_canonical_atomic()'::regprocedure)" > "$evidence/original-guard.sql"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/baseline73/prisma/schema.prisma" --script > "$evidence/drift-before.sql"
# A wrong checksum is changed only in a transaction which the guard must abort.
python3 - "$ddl" "$evidence/wrong-base.sql" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
assert s.count('BEGIN;')==1
s=s.replace('BEGIN;',"""BEGIN;
UPDATE "_prisma_migrations" SET checksum=repeat('0',64) WHERE migration_name='20261030100000_admin_operational_lifecycle_v1';""",1)
Path(sys.argv[2]).write_text(s)
PY
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/wrong-base.sql" > "$evidence/wrong-base.log" 2>&1; then exit 1; fi
grep -Fq ADMIN_RESIDUAL_SCHEMA73_REQUIRED "$evidence/wrong-base.log"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix73-after-wrong-base.txt"
cmp "$evidence/prefix73-before.txt" "$evidence/prefix73-after-wrong-base.txt"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT to_regprocedure('fai_admin_private_version_provenance(text)') IS NULL AND to_regprocedure('fai_admin_service_binding_epoch()') IS NULL")" = t
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_trigger WHERE tgname IN ('admin_private_version_receipt_atomic','zz_admin_service_binding_epoch')")" = 0
psql "$db" -Atc "SELECT pg_get_functiondef('fai_technical_canonical_atomic()'::regprocedure)" > "$evidence/original-guard-after-fault.sql"
cmp "$evidence/original-guard.sql" "$evidence/original-guard-after-fault.sql"
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npm run prisma:migrate:deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 74
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261030190000_admin_residual_provenance_v1' ORDER BY migration_name" > "$evidence/prefix73-after.txt"
cmp "$evidence/prefix73-before.txt" "$evidence/prefix73-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
node --import tsx tests/admin-residuals/migration-fixture.ts verify "$evidence/seed73.json" > "$evidence/read73-after74.json"
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq ADMIN_RESIDUAL_SCHEMA73_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
sha256sum "$ddl" > "$evidence/ddl-sha256.txt"
printf '{"synthetic":true,"before":73,"after":74,"prefix73Unchanged":true,"allPriorRowsPreserved":true,"originalAcquisitionAndFormalizationReadable":true,"atomicFailureRolledBack":true,"originalGuardRestoredOnFailure":true,"wrongBaseDenied":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/proof.json"
cat "$evidence/proof.json"
