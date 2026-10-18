#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$RUNNER_TEMP/selective-practice-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261018220000_selective_practice_read_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 57
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE uid text:=gen_random_uuid()::text; cid text:=gen_random_uuid()::text; pid text:=gen_random_uuid()::text; BEGIN
 INSERT INTO "User"(id,email,name,role,"passwordHash","updatedAt")
 VALUES(uid,uid||'@invalid.test','Synthetic schema57 preserved user','admin','synthetic-unusable',now());
 INSERT INTO "Client"(id,type,"displayName",notes,"salesOwnerId","updatedAt")
 VALUES(cid,'societa','Synthetic schema57 preserved client','Private historical content',uid,now());
 INSERT INTO "TechnicalPractice"(id,"clientId",title,"practiceType","targetEntity","internalNotes","technicalOwnerId","createdById","updatedAt")
 VALUES(pid,cid,'Synthetic preserved practice','Sintetica','Ente sintetico','Private historical practice',uid,uid,now());
END $$;
SQL
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix57-before.txt"
psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/legacy-tables.txt"
footprint() {
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  columns="ARRAY[]::text[]"
  if [[ "$table" == User ]]; then columns="ARRAY['selectivePracticeEpoch']"; fi
  printf '%s|' "$table" >> "$1"
  psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg((to_jsonb(t)-$columns)::text,E'\n' ORDER BY (to_jsonb(t)-$columns)::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/legacy-tables.txt"
}
footprint "$evidence/before.txt"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'SelectivePractice%'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='User' AND column_name='selectivePracticeEpoch'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fai_selective_practice_%'")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npm run prisma:migrate:deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 58
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261018220000_selective_practice_read_v1' ORDER BY migration_name" > "$evidence/prefix57-after.txt"
cmp "$evidence/prefix57-before.txt" "$evidence/prefix57-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "SelectivePracticeAuthority") OR EXISTS(SELECT 1 FROM "SelectivePracticeGrant")
 OR EXISTS(SELECT 1 FROM "SelectivePracticeCommand") OR EXISTS(SELECT 1 FROM "SelectivePracticeRevision")
 OR EXISTS(SELECT 1 FROM "User" WHERE "selectivePracticeEpoch"<>1)
 THEN RAISE EXCEPTION 'SELECTIVE_PRACTICE_MIGRATION_MUST_NOT_ACTIVATE'; END IF;
 IF (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
 WHERE t.relname LIKE 'SelectivePractice%' AND c.contype='f' AND c.confdeltype='r' AND c.confupdtype='r')<>8
 THEN RAISE EXCEPTION 'SELECTIVE_PRACTICE_RESTRICTIVE_FOREIGN_KEYS'; END IF;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq SELECTIVE_PRACTICE_SCHEMA57_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/datamodel-diff.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/datamodel-diff.sql"
node --input-type=module - "$evidence/datamodel-diff.sql" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
assert.doesNotMatch(readFileSync(process.argv[2],'utf8'), /(?:ALTER|DROP|CREATE) TABLE "SelectivePractice|DROP (?:INDEX|CONSTRAINT) "SelectivePractice/);
JS
printf '{"synthetic":true,"before":57,"after":58,"prefix57Unchanged":true,"allLegacyRowsPreserved":true,"newTablesEmpty":true,"personalAuthorityEnrolled":false,"atomicFailureRolledBack":true,"replayDenied":true,"restrictiveForeignKeys":8,"productionContact":false}\n' > "$evidence/migration58-proof.json"
cat "$evidence/migration58-proof.json"
