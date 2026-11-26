#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?}" "${FLOW_EVIDENCE:?}"
test "${APP_ENV:-}" = test
case "$DATABASE_URL" in postgresql://*@127.0.0.1:15479/fai_crm_test\?schema=public) ;; *) exit 2 ;; esac
connection="${DATABASE_URL%%\?*}"
query() { psql "$connection" -XAtq -v ON_ERROR_STOP=1 -c "$1"; }
test "$(query "SELECT current_database(),shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")" = 'fai_crm_test|FAI_CRM_EPHEMERAL_TEST_ONLY_V1'
test "$(query "SELECT to_regclass('public._prisma_migrations') IS NULL")" = t
mkdir -p "$FLOW_EVIDENCE"
baseline=c9c0b8d830f05d9f62e975be2b760214e879ee8c
migration=20261126120000_operational_flow_v1
scratch="$(mktemp -d)"
git archive "$baseline" prisma | tar -x -C "$scratch"
node node_modules/prisma/build/index.js migrate deploy --schema "$scratch/prisma/schema.prisma" > "$FLOW_EVIDENCE/prefix.log"
ledger() { query 'SELECT migration_name,checksum,finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL ORDER BY migration_name'; }
ledger > "$FLOW_EVIDENCE/prefix-ledger"
test "$(wc -l < "$FLOW_EVIDENCE/prefix-ledger")" -eq 77
query "INSERT INTO \"Lead\" (id,\"firstName\",\"lastName\",\"updatedAt\") VALUES ('flow-schema-fixture','Sintetico','Preesistente',CURRENT_TIMESTAMP)"
legacy() { query "SELECT to_jsonb(l) FROM \"Lead\" l WHERE id='flow-schema-fixture'"; }
legacy > "$FLOW_EVIDENCE/legacy-before.json"
sql="prisma/migrations/$migration/migration.sql"
test "$(head -1 "$sql")" = 'BEGIN;'
test "$(tail -1 "$sql")" = 'COMMIT;'
sed '/^COMMIT;$/i SELECT 1/0;' "$sql" > "$scratch/injected.sql"
if psql "$connection" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f "$scratch/injected.sql" > "$FLOW_EVIDENCE/rollback.log" 2>&1; then exit 1; else test "$?" -eq 3; fi
grep -q '22012' "$FLOW_EVIDENCE/rollback.log"
test "$(query "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('InternalNotificationRead','PersonalCalendar','LeadAppointment','GoogleCalendarOAuthState','GoogleCalendarCredential','OperationalDocument','OperationalDocumentDecision','WorkflowEmailTemplate','WorkflowAutomation','WorkflowAutomationTest','WorkflowEnrollment','WorkflowExecution','WorkflowNewsletterRun','WorkflowNewsletterRecipient','LeadAssignmentProposal','MarketingPreferenceEpoch','MarketingPreferenceSubject','MarketingPreferenceEvent')")" = 0
ledger | cmp - "$FLOW_EVIDENCE/prefix-ledger"
legacy | cmp - "$FLOW_EVIDENCE/legacy-before.json"
node node_modules/prisma/build/index.js migrate deploy > "$FLOW_EVIDENCE/migrate.log"
ledger > "$FLOW_EVIDENCE/ledger"
test "$(wc -l < "$FLOW_EVIDENCE/ledger")" -eq 78
head -n 77 "$FLOW_EVIDENCE/ledger" | cmp - "$FLOW_EVIDENCE/prefix-ledger"
legacy | cmp - "$FLOW_EVIDENCE/legacy-before.json"
test "$(query 'SELECT count(*) FROM "MarketingPreferenceEpoch"')" = 0
test "$(query 'SELECT count(*) FROM "WorkflowEnrollment"')" = 0
printf '{"synthetic":true,"prefix":77,"candidate":78,"injectedFailureRolledBack":true,"legacyLeadPreserved":true,"emptyMarketingEpoch":true,"providersActivated":false}\n' > "$FLOW_EVIDENCE/schema.json"
