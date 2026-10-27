#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 68
evidence="$TECHNICAL_PRIVATE_ITEM_EVIDENCE/migration69"
mkdir -p "$evidence"
ddl=prisma/migrations/20261027010000_technical_private_items_v1/migration.sql
git show 8dc6a994f0e0ccb8169b1d0b959ddb822b4dac09:prisma/schema.prisma > "$evidence/schema68.prisma"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema68.prisma" --script > "$evidence/drift-before.sql"
# These are isolated preexisting rows, never a production fixture.
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "Client"(id,type,"displayName","updatedAt") VALUES('private69-historical-client','societa','Storico sintetico SQL69',now());
INSERT INTO "Task"(id,title,"clientId","updatedAt") VALUES('private69-historical-task','Attività storica sintetica','private69-historical-client',now());
INSERT INTO "DocumentChecklistItem"(id,title,"clientId","updatedAt") VALUES('private69-historical-check','Checklist storica sintetica','private69-historical-client',now());
SQL
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix68-before.txt"
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/prior-tables.txt"
footprint() {
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  printf '%s|' "$table" >> "$1"
  # Exclude only the newly added false flag; compare every previous field.
  json='to_jsonb(t)'
  if [[ "$table" == Task || "$table" == DocumentChecklistItem ]]; then json="(to_jsonb(t)-'technicalPrivate')"; fi
  psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg($json::text,E'\n' ORDER BY $json::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/prior-tables.txt"
}
footprint "$evidence/before.txt"
python3 -B scripts/technical-private-items/release-observer/qualify_snapshot.py capture68
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='TechnicalPrivateItemOrigin'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('Task','DocumentChecklistItem') AND column_name='technicalPrivate'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE proname LIKE 'fai_technical_private_%'")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npx prisma migrate deploy
python3 -B scripts/technical-private-items/release-observer/qualify_snapshot.py initialization
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 69
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261027010000_technical_private_items_v1' ORDER BY migration_name" > "$evidence/prefix68-after.txt"
cmp "$evidence/prefix68-before.txt" "$evidence/prefix68-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "TechnicalPrivateItemOrigin"')" = 0
test "$(psql "$db" -Atc 'SELECT (SELECT count(*) FROM "Task" WHERE "technicalPrivate")+(SELECT count(*) FROM "DocumentChecklistItem" WHERE "technicalPrivate")')" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('technical_private_origin_retained','technical_private_origin_no_truncate','task_private_marker_guard','checklist_private_marker_guard','task_private_origin_required','checklist_private_origin_required','technical_private_creation_atomic','technical_private_audit_retained')")" = 8
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgdeferrable AND tginitdeferred AND tgname IN ('task_private_origin_required','checklist_private_origin_required','technical_private_creation_atomic')")" = 3
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq TECHNICAL_PRIVATE_ITEM_SCHEMA68_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
sha256sum "$ddl" > "$evidence/ddl-sha256.txt"
psql "$db" -X -At -v ON_ERROR_STOP=1 -f scripts/technical-private-items/schema69-structure.sql > "$evidence/structure.json"
node --input-type=module - "$evidence/structure.json" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(s.tables.length, 1);
assert.equal(s.tables[0].ownerMatches, true);
assert.equal(s.tables[0].kind, 'r');
assert.equal(s.columns.length, 15);
for (const table of ['Task', 'DocumentChecklistItem']) {
 const marker = s.columns.find(c => c.table === table && c.name === 'technicalPrivate');
 assert.equal(marker?.type, 'boolean'); assert.equal(marker.nullable, 'NO'); assert.equal(marker.default, 'false');
}
assert.equal(s.triggers.length, 8);
assert.ok(s.triggers.every(t => t.enabled === 'O' && t.functionSchema === 'public'));
assert.equal(s.triggers.filter(t => t.deferrable && t.initiallyDeferred).length, 3);
assert.equal(s.functions.length, 3);
assert.ok(s.functions.every(f => f.ownerMatches && !f.securityDefiner && f.language === 'plpgsql' && /^[a-f0-9]{64}$/.test(f.bodySha256)));
assert.ok(s.constraints.every(c => c.validated));
assert.equal(s.constraints.filter(c => c.type === 'f').length, 1);
assert.equal(s.indexes.length, 3);
console.log('SCHEMA69_STRUCTURE_JSON=' + JSON.stringify(s));
JS
printf '{"synthetic":true,"before":68,"after":69,"prefix68Unchanged":true,"previousFieldsAndRelationsPreserved":true,"allExistingMarkersFalse":true,"newTableEmpty":true,"atomicFailureRolledBackAllObjects":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/proof.json"
