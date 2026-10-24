#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$TECHNICAL_ITEM_EVIDENCE/migration66"
mkdir -p "$evidence"
ddl=prisma/migrations/20261024090000_technical_work_items_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 65
# Non-empty canonical fixtures verify backfill without creating any authorization.
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "Client"(id,type,"displayName","updatedAt") VALUES('csyntheticmigration66client','societa','Synthetic migration preservation',now());
INSERT INTO "Task"(id,"clientId",title,"updatedAt") VALUES('csyntheticmigration66task','csyntheticmigration66client','Synthetic task preserved',now());
INSERT INTO "DocumentChecklistItem"(id,"clientId",title,"updatedAt") VALUES('csyntheticmigration66check','csyntheticmigration66client','Synthetic checklist preserved',now());
SQL
git show eb5511fb6c82e15263d6cddf18e7ed36e5100442:prisma/schema.prisma > "$evidence/schema65.prisma"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema65.prisma" --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$evidence/prefix65-before.txt"
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/tables.txt"
footprint() {
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  printf '%s|' "$table" >> "$1"
  psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/tables.txt"
}
footprint "$evidence/before.txt"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('TechnicalWorkItemGeneration','TechnicalWorkItemCommand')")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE proname LIKE 'fai_technical_work_item_%'")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
historical66="$evidence/immutable66"
mkdir -p "$historical66"
git archive aa30d5c8ca4f483ae6cd0e77ec9fade8794646b4 prisma | tar -x -C "$historical66"
npx prisma migrate deploy --schema "$historical66/prisma/schema.prisma"
psql "$db" -At -v ON_ERROR_STOP=1 -f scripts/technical-work-items/structure.sql > "$evidence/structure66.json"
node -e 'const fs=require("node:fs"),a=require("node:assert/strict"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));a.deepEqual(v.tables.map(x=>x.name),["TechnicalWorkItemCommand","TechnicalWorkItemGeneration"]);a.equal(v.columns.length,18);a.equal(v.functions.length,3);a.equal(v.triggers.length,9);a.equal(v.triggers.filter(x=>x.deferrable&&x.initiallyDeferred).length,1);a.equal(v.constraints.filter(x=>x.type==="f").length,2)' "$evidence/structure66.json"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 66
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE migration_name<'20261024090000_technical_work_items_v1' ORDER BY migration_name" > "$evidence/prefix65-after.txt"
cmp "$evidence/prefix65-before.txt" "$evidence/prefix65-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "TechnicalWorkItemCommand"')" = 0
test "$(psql "$db" -Atc 'SELECT count(*) FROM "TechnicalWorkItemGeneration" WHERE generation=1 AND "scopeGeneration"=1')" = "$(psql "$db" -Atc 'SELECT (SELECT count(*) FROM "Task")+(SELECT count(*) FROM "DocumentChecklistItem")')"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_trigger WHERE tgname='technical_work_item_command_atomic' AND tgdeferrable AND tginitdeferred")" = 1
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq TECHNICAL_WORK_ITEM_SCHEMA65_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$historical66/prisma/schema.prisma" --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
printf '{"synthetic":true,"before":65,"after":66,"prefix65Unchanged":true,"allPriorRowsPreserved":true,"generationBackfillExact":true,"newCommandsEmpty":true,"atomicFailureRolledBackAllObjects":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/proof.json"

# Current runtime regressions include all later additive migrations.
npx prisma migrate deploy
