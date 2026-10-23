#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
test "$(psql "$db" -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = FAI_CRM_EPHEMERAL_TEST_ONLY_V1
evidence="$RUNNER_TEMP/technical-assignment-migration"
mkdir -p "$evidence"
ddl=prisma/migrations/20261022200000_technical_assignments_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 63
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE uid text:=gen_random_uuid()::text; lid text:=gen_random_uuid()::text; BEGIN
 INSERT INTO "User"(id,email,name,role,"passwordHash","updatedAt") VALUES
 (uid,uid||'@invalid.test','Synthetic schema63 preserved user','admin','synthetic-unusable',now());
 INSERT INTO "Lead"(id,"firstName","lastName",notes,"assignedToId",interest,priority,"updatedAt")
 VALUES(lid,'Synthetic schema63','Preserved','Private history preserved',uid,'Preserved interest','media',now());
END $$;
SQL
git show 3a43977b585a9af43e4ef0c489841ce9a699a2c3:prisma/schema.prisma > "$evidence/schema63.prisma"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$evidence/schema63.prisma" --script > "$evidence/drift-before.sql"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix63-before.txt"
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
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('TechnicalAssignmentAuthority','TechnicalAssignment','TechnicalAssignmentDecision','TechnicalAssignmentRevision','TechnicalWorkCommand')")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'fai_technical_assignment_%' OR proname='fai_technical_work_atomic')")" = 0
footprint "$evidence/after-fault.txt"
cmp "$evidence/before.txt" "$evidence/after-fault.txt"
historical="$RUNNER_TEMP/admin-requests-historical64"
mkdir -p "$historical"
git archive 4c2fe838e9c557d59802a71aa4f42fbae5c74327 prisma | tar -x -C "$historical"
npx prisma migrate deploy --schema "$historical/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 64
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261022200000_technical_assignments_v1' ORDER BY migration_name" > "$evidence/prefix63-after.txt"
cmp "$evidence/prefix63-before.txt" "$evidence/prefix63-after.txt"
footprint "$evidence/after.txt"
cmp "$evidence/before.txt" "$evidence/after.txt"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE name text; total bigint; BEGIN
 IF (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('TechnicalAssignmentAuthority','TechnicalAssignment','TechnicalAssignmentDecision','TechnicalAssignmentRevision','TechnicalWorkCommand'))<>5
 THEN RAISE EXCEPTION 'TECHNICAL_TABLE_SET'; END IF;
 FOR name IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('TechnicalAssignmentAuthority','TechnicalAssignment','TechnicalAssignmentDecision','TechnicalAssignmentRevision','TechnicalWorkCommand') LOOP
  EXECUTE format('SELECT count(*) FROM %I',name) INTO total;
  IF total<>0 THEN RAISE EXCEPTION 'TECHNICAL_MIGRATION_MUST_NOT_ENROLL'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
  WHERE t.relname IN ('TechnicalAssignmentAuthority','TechnicalAssignment','TechnicalAssignmentDecision','TechnicalAssignmentRevision','TechnicalWorkCommand') AND c.contype='f' AND c.confdeltype='r' AND c.confupdtype='r')<>10
 THEN RAISE EXCEPTION 'TECHNICAL_RESTRICTIVE_FOREIGN_KEYS'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('technical_assignment_atomic','technical_assignment_revision_atomic','technical_assignment_decision_atomic','technical_work_command_atomic')
  AND tgdeferrable AND tginitdeferred AND tgenabled='O')<>4 THEN RAISE EXCEPTION 'TECHNICAL_ATOMIC_TRIGGERS'; END IF;
 BEGIN
  TRUNCATE "TechnicalAssignmentAuthority","TechnicalAssignment","TechnicalAssignmentDecision","TechnicalAssignmentRevision","TechnicalWorkCommand";
  RAISE EXCEPTION 'TECHNICAL_TRUNCATE_UNEXPECTEDLY_ALLOWED';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'TECHNICAL_ASSIGNMENT_HISTORY_RETAINED' THEN RAISE; END IF;
 END;
END $$;
SQL
psql "$db" -v ON_ERROR_STOP=1 -At -f scripts/technical-assignments/structure.sql > "$evidence/structure64.json"
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/replay.log" 2>&1; then exit 1; fi
grep -Fq TECHNICAL_ASSIGNMENT_SCHEMA63_REQUIRED "$evidence/replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$historical/prisma/schema.prisma" --script > "$evidence/drift-after.sql"
cmp "$evidence/drift-before.sql" "$evidence/drift-after.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/drift-after.sql"
printf '{"synthetic":true,"before":63,"after":64,"prefix63Unchanged":true,"allPriorRowsPreserved":true,"newTablesEmpty":true,"personalAuthorityEnrolled":false,"restrictiveForeignKeys":10,"atomicTriggers":4,"historyTruncateDenied":true,"atomicFailureRolledBackAllObjects":true,"replayDenied":true,"datamodelDriftUnchanged":true,"productionContact":false}\n' > "$evidence/migration64-proof.json"
cat "$evidence/migration64-proof.json"
