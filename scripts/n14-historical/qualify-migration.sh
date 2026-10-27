#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$HISTORY_EVIDENCE/migration70"
mkdir -p "$evidence/baseline69"
git archive e8104aa0f2ceea2f44d5da51b8f4ff7c2e1f6adf prisma | tar -x -C "$evidence/baseline69"
npx prisma migrate deploy --schema "$evidence/baseline69/prisma/schema.prisma"
node --import tsx tests/n14-historical-contact/migration-state.ts
ddl=prisma/migrations/20261027220000_historical_lead_contact_v1/migration.sql
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/baseline69/prisma/schema.prisma" --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix69-before.txt"
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/prior-tables.txt"
footprint() {
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  printf '%s|' "$table" >> "$1"
  psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/prior-tables.txt"
}
constraint() { psql "$db" -Atc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='CommercialLeadSlaCycle_contract_check'"; }
footprint "$evidence/before.txt"
constraint > "$evidence/constraint-before.txt"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('CommercialLeadHistoricalContact','CommercialLeadHistoricalConversion')")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'n14_historical_%'")" = 0
footprint "$evidence/after-fault.txt"
constraint > "$evidence/constraint-after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
cmp "$evidence/constraint-before.txt" "$evidence/constraint-after-fault.txt"
npm run prisma:migrate:deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 70
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261027220000_historical_lead_contact_v1' ORDER BY migration_name" > "$evidence/prefix69-after.txt"
cmp "$evidence/prefix69-before.txt" "$evidence/prefix69-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT (SELECT count(*) FROM "CommercialLeadHistoricalContact")+(SELECT count(*) FROM "CommercialLeadHistoricalConversion")')" = 0
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq N14_HISTORICAL_SCHEMA69_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
sha256sum "$ddl" > "$evidence/ddl-sha256.txt"
psql "$db" -X -At -v ON_ERROR_STOP=1 -f scripts/n14-historical/schema70-structure.sql > "$evidence/structure.json"
node --input-type=module - "$evidence/structure.json" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert.equal(s.tables.length,2); assert(s.tables.every(t=>t.ownerMatches&&t.kind==='r'));
assert.equal(s.columns.length,27);
assert.equal(s.triggers.length,8); assert(s.triggers.every(t=>t.enabled==='O'&&t.functionSchema==='public'));
assert.equal(s.triggers.filter(t=>t.deferrable&&t.initiallyDeferred).length,3);
assert.equal(s.functions.length,4); assert(s.functions.every(f=>f.ownerMatches&&!f.securityDefiner&&f.language==='plpgsql'&&/^[a-f0-9]{64}$/.test(f.bodySha256)));
assert(s.constraints.every(c=>c.validated)); assert.equal(s.constraints.filter(c=>c.type==='f').length,13);
assert.equal(s.indexes.length,10);
console.log('SCHEMA70_STRUCTURE_JSON='+JSON.stringify(s));
JS
printf '{"synthetic":true,"before":69,"after":70,"prefix69Unchanged":true,"allPriorRowsAndRelationsPreserved":true,"previousResponsesAndSlaPreserved":true,"newTablesEmpty":true,"atomicFailureRolledBackAllObjects":true,"previousSlaConstraintRestoredOnFailure":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/proof.json"
cat "$evidence/proof.json"
