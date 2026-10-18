#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
evidence="$RUNNER_TEMP/private-video-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261018000000_private_video_library_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 53
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix53-before.txt"
# Preserve the populated legacy fixture produced by the historical qualification,
# including every schema53 table, session, epoch, approval and audit record.
footprint() {
 psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('_prisma_migrations','VideoAsset','VideoEntry','VideoRevision','VideoCommand') ORDER BY tablename" > "$evidence/tables.txt"
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
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('VideoAsset','VideoEntry','VideoRevision','VideoCommand')")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fai_video_%'")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
historical="$RUNNER_TEMP/private-video-schema54"
mkdir -p "$historical"
git archive a3dd15e8b295bb603e772f6ecfafc60e8da0c07f prisma | tar -x -C "$historical"
npx prisma migrate deploy --schema "$historical/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 54
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261018000000_private_video_library_v1' ORDER BY migration_name" > "$evidence/prefix53-after.txt"
cmp "$evidence/prefix53-before.txt" "$evidence/prefix53-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE n text; total bigint; BEGIN
 FOR n IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('VideoAsset','VideoEntry','VideoRevision','VideoCommand') LOOP
  EXECUTE format('SELECT count(*) FROM %I',n) INTO total;
  IF total<>0 THEN RAISE EXCEPTION 'VIDEO_MIGRATION_MUST_NOT_BOOTSTRAP'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid IN ('"VideoAsset"'::regclass,'"VideoEntry"'::regclass,'"VideoRevision"'::regclass,'"VideoCommand"'::regclass) AND confdeltype='r' AND confupdtype='r')<>8
 THEN RAISE EXCEPTION 'VIDEO_RESTRICTIVE_RELATIONS_REQUIRED'; END IF;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq VIDEO_MIGRATION54_BASE_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$historical/prisma/schema.prisma" --script > "$evidence/datamodel-diff.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/datamodel-diff.sql"
node --input-type=module - "$evidence/datamodel-diff.sql" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
assert.doesNotMatch(readFileSync(process.argv[2],'utf8'),/DROP (?:TABLE|CONSTRAINT) "Video|ALTER TABLE "Video|CREATE TABLE "Video/);
JS
printf '{"synthetic":true,"before":53,"after":54,"newTablesEmpty":true,"prefix53Unchanged":true,"allLegacyRowsPreserved":true,"atomicFailureRolledBack":true,"replayDenied":true,"restrictiveForeignKeys":8,"productionContact":false}\n' > "$evidence/migration54-proof.json"
cat "$evidence/migration54-proof.json"
