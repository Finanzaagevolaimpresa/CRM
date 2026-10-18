#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$RUNNER_TEMP/record-update-email-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261018060000_record_update_email_drafts_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 54
# Populated schema54 CRM work, created through its actual capture trigger.
# This is an isolated CI database, never the production migration or fixture.
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE uid text := gen_random_uuid()::text; lid text := gen_random_uuid()::text; BEGIN
 INSERT INTO "User"(id,email,name,role,"passwordHash","updatedAt")
  VALUES(uid,uid||'@invalid.test','Synthetic schema54 update owner','admin','synthetic-unusable',now());
 INSERT INTO "Lead"(id,"firstName","lastName","assignedToId","updatedAt")
  VALUES(lid,'Synthetic migration55','history',uid,now());
 INSERT INTO "RecordUpdateRule"(id,kind,"recordId","authorId","authorEpoch",scope,selection,"directoryBinding",recipients,events,"updatedAt")
  VALUES(gen_random_uuid(),'LEAD',lid,uid,1,fai_record_update_scope('LEAD',lid),
   jsonb_build_object('people',jsonb_build_array(uid),'groups','[]'::jsonb),repeat('a',64),
   jsonb_build_array(jsonb_build_object('id',uid,'epoch',1,'communication',true)),ARRAY['NEXT_ACTION'],now());
 UPDATE "Lead" SET "nextActionNote"='SYNTHETIC MIGRATION HISTORY' WHERE id=lid;
 IF NOT EXISTS(SELECT 1 FROM "RecordUpdateDelivery" d JOIN "RecordUpdateEvent" e ON e.id=d."eventId" WHERE e."recordId"=lid)
 THEN RAISE EXCEPTION 'UPDATE_EMAIL_OLD_CRM_FIXTURE_REQUIRED'; END IF;
END $$;
SQL
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix54-before.txt"
footprint() {
 psql "$db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename" > "$evidence/tables.txt"
 : > "$1"
 while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]]
  columns="ARRAY[]::text[]"
  case "$table" in
   RecordUpdateRule|RecordUpdateCommand) columns="ARRAY['mode','emailAuthorityRevision']";;
   RecordUpdateDelivery) columns="ARRAY['mode']";;
   ApprovedCommunication) columns="ARRAY['updateDeliveryId']";;
   CommunicationVersion) columns="ARRAY['updateSource','updateSourceHash']";;
  esac
  printf '%s|' "$table" >> "$1"
  psql "$db" -Atc "SELECT count(*)||'|'||md5(coalesce(string_agg((to_jsonb(t)-$columns)::text,E'\n' ORDER BY (to_jsonb(t)-$columns)::text),'')) FROM \"$table\" t" >> "$1"
 done < "$evidence/tables.txt"
}
footprint "$evidence/before.txt"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/fault.sql" > "$evidence/fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='RecordUpdateDelivery' AND column_name='mode'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fai_record_update_email_source_guard'")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
historical="$RUNNER_TEMP/record-update-email-schema55"
mkdir -p "$historical"
git archive 1e463b01dd22f09aab73a35fac7203598dc7c044 prisma | tar -x -C "$historical"
npx prisma migrate deploy --schema "$historical/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 55
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261018060000_record_update_email_drafts_v1' ORDER BY migration_name" > "$evidence/prefix54-after.txt"
cmp "$evidence/prefix54-before.txt" "$evidence/prefix54-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "RecordUpdateRule" WHERE mode<>'CRM' OR "emailAuthorityRevision" IS NOT NULL)
 OR EXISTS(SELECT 1 FROM "RecordUpdateCommand" WHERE mode<>'CRM' OR "emailAuthorityRevision" IS NOT NULL)
 OR EXISTS(SELECT 1 FROM "RecordUpdateDelivery" WHERE mode<>'CRM')
 OR EXISTS(SELECT 1 FROM "ApprovedCommunication" WHERE "updateDeliveryId" IS NOT NULL)
 OR EXISTS(SELECT 1 FROM "CommunicationVersion" WHERE "updateSource" IS NOT NULL OR "updateSourceHash" IS NOT NULL)
 THEN RAISE EXCEPTION 'UPDATE_EMAIL_MIGRATION_MUST_NOT_ACTIVATE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='"ApprovedCommunication"'::regclass
 AND confrelid='"RecordUpdateDelivery"'::regclass AND contype='f' AND confdeltype='r' AND confupdtype='r')
 THEN RAISE EXCEPTION 'UPDATE_EMAIL_RESTRICTIVE_ORIGIN_REQUIRED'; END IF;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq RECORD_UPDATE_EMAIL_SCHEMA54_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$historical/prisma/schema.prisma" --script > "$evidence/datamodel-diff.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/datamodel-diff.sql"
node --input-type=module - "$evidence/datamodel-diff.sql" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
assert.doesNotMatch(readFileSync(process.argv[2],'utf8'),/ALTER TABLE "(?:RecordUpdate|ApprovedCommunication|CommunicationVersion)|CREATE (?:TABLE|UNIQUE INDEX) "(?:RecordUpdate|ApprovedCommunication|CommunicationVersion)/);
JS
printf '{"synthetic":true,"before":54,"after":55,"prefix54Unchanged":true,"allLegacyRowsPreserved":true,"oldModesRemainCRM":true,"noOriginSeeded":true,"atomicFailureRolledBack":true,"replayDenied":true,"restrictiveOrigin":true,"productionContact":false}\n' > "$evidence/migration55-proof.json"
cat "$evidence/migration55-proof.json"
