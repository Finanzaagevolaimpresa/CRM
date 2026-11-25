#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?}" "${SETTER_EVIDENCE:?}"
test "${APP_ENV:-}" = test
case "$DATABASE_URL" in postgresql://*@127.0.0.1:15477/fai_crm_test\?schema=public) ;; *) exit 2 ;; esac
connection="${DATABASE_URL%%\?*}"
query() { psql "$connection" -XAtq -v ON_ERROR_STOP=1 -c "$1"; }
test "$(query "SELECT current_database(),shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = 'fai_crm_test|FAI_CRM_EPHEMERAL_TEST_ONLY_V1'
test "$(query "SELECT to_regclass('public._prisma_migrations') IS NULL")" = t
baseline=0769dd4362200d978dbe4cb2d4a3e5c57ca6b0e2
migration=20261125120000_lead_setter_workflow_v1
scratch="$(mktemp -d)"
git archive "$baseline" prisma | tar -x -C "$scratch"
node node_modules/prisma/build/index.js migrate deploy --schema "$scratch/prisma/schema.prisma" > "$SETTER_EVIDENCE/prefix.log"
ledger() { query 'SELECT migration_name,checksum,finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL ORDER BY migration_name'; }
ledger > "$SETTER_EVIDENCE/prefix-ledger"
test "$(wc -l < "$SETTER_EVIDENCE/prefix-ledger")" -eq 76
query "INSERT INTO \"Lead\" (id,\"firstName\",\"lastName\",\"updatedAt\") VALUES ('setter-schema-fixture','Sintetico','Preesistente',CURRENT_TIMESTAMP)"
legacy() { query "SELECT to_jsonb(l)-'setterNextKind' FROM \"Lead\" l WHERE id='setter-schema-fixture'"; }
legacy > "$SETTER_EVIDENCE/legacy-before.json"
sql="prisma/migrations/$migration/migration.sql"
node -e 'const a=require("node:assert/strict"),fs=require("node:fs"),b=require("./scripts/lead-setter/schema-binding.json");a.equal(require("node:crypto").createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"),b.migrationSha256)' "$sql"
sed '/^COMMIT;$/i SELECT 1/0;' "$sql" > "$scratch/injected.sql"
if psql "$connection" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f "$scratch/injected.sql" > "$SETTER_EVIDENCE/rollback.log" 2>&1; then exit 1; else test "$?" -eq 3; fi
grep -q '22012' "$SETTER_EVIDENCE/rollback.log"
test "$(query "SELECT to_regclass('public.\"LeadSetterCall\"') IS NULL")" = t
test "$(query "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('setterNextKind','ordinaryConfirmedAt','ordinaryDigest')")" = 0
ledger | cmp - "$SETTER_EVIDENCE/prefix-ledger"
legacy | cmp - "$SETTER_EVIDENCE/legacy-before.json"
npm run prisma:migrate:deploy > "$SETTER_EVIDENCE/migrate.log"
ledger > "$SETTER_EVIDENCE/ledger"
test "$(wc -l < "$SETTER_EVIDENCE/ledger")" -eq 77
head -n 76 "$SETTER_EVIDENCE/ledger" | cmp - "$SETTER_EVIDENCE/prefix-ledger"
legacy | cmp - "$SETTER_EVIDENCE/legacy-before.json"
test "$(query 'SELECT count(*) FROM "LeadSetterCall"')" = 0
test "$(query 'SELECT count(*) FROM "Lead" WHERE "setterNextKind" IS NOT NULL')" = 0
