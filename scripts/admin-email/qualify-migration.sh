#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${APP_ENV:-}" == test && "${ORDINARY_EMAIL_STORE_CONFIRMED:-}" == 1 ]]
node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);if(u.hostname!=="127.0.0.1"||u.port!=="5432"||u.pathname!=="/fai_crm_test")process.exit(1)'
db="${DATABASE_URL%%\?*}"
evidence="$RUNNER_TEMP/ordinary-email"
ddl=prisma/migrations/20261017160000_admin_email_contexts_v1/migration.sql
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 51
if psql "$db" -v ON_ERROR_STOP=1 -f prisma/migrations/20261017200000_record_update_notifications_v1/migration.sql > "$evidence/update-wrong-base.log" 2>&1; then exit 1; fi
grep -Fq RECORD_UPDATE_MIGRATION53_BASE_REQUIRED "$evidence/update-wrong-base.log"
psql "$db" -Atc 'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$evidence/prefix51-before.txt"
# Genuine v1 rows exist before the schema change; no new-context code seeds them.
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('migration52-owner','Synthetic migration owner','migration52@invalid.test','unusable-synthetic','admin',now());
INSERT INTO "Client" ("id","type","displayName","updatedAt") VALUES ('migration52-client','societa','Synthetic historical client',now());
INSERT INTO "TechnicalPractice" ("id","clientId","title","practiceType","targetEntity","createdById","updatedAt") VALUES ('migration52-practice','migration52-client','Synthetic historical practice','test','synthetic','migration52-owner',now());
INSERT INTO "ApprovedCommunication" ("id","clientId","technicalPracticeId","mailboxId","createdById","updatedAt")
  SELECT '22222222-5252-4252-8252-222222222222','migration52-client','migration52-practice',"id",'migration52-owner',now()
  FROM "CommunicationMailbox" WHERE "address"='comunicazioni@finanzaagevolaimpresa.it';
SQL
node --import tsx scripts/admin-email/seed-legacy-migration-fixture.ts
footprint() {
  psql "$db" -Atc "SELECT jsonb_build_object('messages',(SELECT jsonb_agg(to_jsonb(t)-'contextKind'-'leadId'-'internalThreadId' ORDER BY id) FROM \"ApprovedCommunication\" t),'versions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM \"CommunicationVersion\" t),'mailboxes',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM \"CommunicationMailbox\" t),'sessions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM \"InternalSession\" t))" > "$1"
}
footprint "$evidence/context-legacy-before.json"
sed 's/^COMMIT;$/SELECT 1\/0;\nCOMMIT;/' "$ddl" > "$evidence/context-fault.sql"
if psql "$db" -v ON_ERROR_STOP=1 -f "$evidence/context-fault.sql" > "$evidence/context-fault.log" 2>&1; then exit 1; fi
grep -Fq 'division by zero' "$evidence/context-fault.log"
test "$(psql "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('InternalCommunicationThread','InternalCommunicationParticipant','CommunicationContextFile')")" = 0
test "$(psql "$db" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ApprovedCommunication' AND column_name IN ('contextKind','leadId','internalThreadId')")" = 0
test "$(psql "$db" -Atc "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='ApprovedCommunication' AND column_name='clientId'")" = NO
footprint "$evidence/context-legacy-after-fault.json"
cmp "$evidence/context-legacy-before.json" "$evidence/context-legacy-after-fault.json"
schema52="$RUNNER_TEMP/admin-email-schema52"
mkdir -p "$schema52"
git archive 76f1a1530310f40a760e3cfe27bb335f92451569 prisma | tar -x -C "$schema52"
npx prisma migrate deploy --schema "$schema52/prisma/schema.prisma"
test "$(psql "$db" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 52
psql "$db" -Atc "SELECT migration_name,checksum FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name<'20261017160000_admin_email_contexts_v1' ORDER BY migration_name" > "$evidence/prefix51-after.txt"
cmp "$evidence/prefix51-before.txt" "$evidence/prefix51-after.txt"
footprint "$evidence/context-legacy-after.json"
cmp "$evidence/context-legacy-before.json" "$evidence/context-legacy-after.json"
psql "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "InternalCommunicationThread") OR EXISTS (SELECT 1 FROM "InternalCommunicationParticipant")
    OR EXISTS (SELECT 1 FROM "CommunicationContextFile") THEN RAISE EXCEPTION 'CONTEXT_MIGRATION_MUST_NOT_BOOTSTRAP'; END IF;
  IF (SELECT "contextKind" FROM "ApprovedCommunication" WHERE "id"='22222222-5252-4252-8252-222222222222') <> 'LEGACY' THEN RAISE EXCEPTION 'LEGACY_CONTEXT_NOT_PRESERVED'; END IF;
END $$;
SQL
if psql "$db" -v ON_ERROR_STOP=1 -f "$ddl" > "$evidence/context-replay.log" 2>&1; then exit 1; fi
grep -Fq ADMIN_EMAIL_MIGRATION52_BASE_REQUIRED "$evidence/context-replay.log"
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$schema52/prisma/schema.prisma" --script > "$evidence/schema52-datamodel-diff.sql"
node scripts/verify-dossier-foreign-keys.mjs "$evidence/schema52-datamodel-diff.sql"
printf '{"synthetic":true,"before":51,"after":52,"tablesAdded":3,"newTablesEmpty":true,"prefix51Unchanged":true,"legacyRowsPreserved":true,"wrongBaseDenied":true,"atomicFailureRolledBackAllObjects":true,"replayDenied":true,"productionContact":false}\n' > "$evidence/migration52-proof.json"
cat "$evidence/migration52-proof.json"
