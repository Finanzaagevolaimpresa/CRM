#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$RUNNER_TEMP/selective-lead-edit-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261022110000_selective_lead_edit_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 62
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE uid text:=gen_random_uuid()::text; lid text:=gen_random_uuid()::text; BEGIN
 INSERT INTO "User"(id,email,name,role,"passwordHash","updatedAt") VALUES
 (uid,uid||'@invalid.test','Synthetic schema62 preserved user','admin','synthetic-unusable',now());
 INSERT INTO "Lead"(id,"firstName","lastName",notes,"assignedToId",interest,priority,"updatedAt")
 VALUES(lid,'Synthetic schema62','Preserved','Private history preserved',uid,'Preserved interest','media',now());
END $$;
SQL
git show d6a5a3d14a9b3a1ade0d33e6b156ad71da5d9b0f:prisma/schema.prisma > "$evidence/schema62.prisma"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema62.prisma" --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix62-before.txt"
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
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'SelectiveLeadEdit%'")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fai_selective_lead_edit_%'")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
npx prisma migrate deploy
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 63
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261022110000_selective_lead_edit_v1' ORDER BY migration_name" > "$evidence/prefix62-after.txt"
cmp "$evidence/prefix62-before.txt" "$evidence/prefix62-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE name text; total bigint; BEGIN
 IF (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'SelectiveLeadEdit%')<>5
 THEN RAISE EXCEPTION 'LEAD_EDIT_TABLE_SET'; END IF;
 FOR name IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'SelectiveLeadEdit%' LOOP
  EXECUTE format('SELECT count(*) FROM %I',name) INTO total;
  IF total<>0 THEN RAISE EXCEPTION 'LEAD_EDIT_MIGRATION_MUST_NOT_ENROLL'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
  WHERE t.relname LIKE 'SelectiveLeadEdit%' AND c.contype='f' AND c.confdeltype='r' AND c.confupdtype='r')<>12
 THEN RAISE EXCEPTION 'LEAD_EDIT_RESTRICTIVE_FOREIGN_KEYS'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('selective_lead_edit_grant_atomic','selective_lead_edit_revision_atomic','selective_lead_edit_decision_atomic','selective_lead_edit_command_atomic')
  AND tgdeferrable AND tginitdeferred AND tgenabled='O')<>4 THEN RAISE EXCEPTION 'LEAD_EDIT_ATOMIC_TRIGGERS'; END IF;
 BEGIN
  TRUNCATE "SelectiveLeadEditAuthority","SelectiveLeadEditGrant","SelectiveLeadEditDecision","SelectiveLeadEditRevision","SelectiveLeadEditCommand";
  RAISE EXCEPTION 'LEAD_EDIT_TRUNCATE_UNEXPECTEDLY_ALLOWED';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'SELECTIVE_LEAD_EDIT_HISTORY_RETAINED' THEN RAISE; END IF;
 END;
END $$;
SQL
psql "$db" -v ON_ERROR_STOP=1 -At -f scripts/selective-lead-edit/structure.sql > "$evidence/structure63.json"
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq SELECTIVE_LEAD_EDIT_SCHEMA62_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
printf '{"synthetic":true,"before":62,"after":63,"prefix62Unchanged":true,"allPriorRowsPreserved":true,"newTablesEmpty":true,"personalAuthorityEnrolled":false,"restrictiveForeignKeys":12,"atomicTriggers":4,"historyTruncateDenied":true,"atomicFailureRolledBackAllObjects":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/migration63-proof.json"
cat "$evidence/migration63-proof.json"
