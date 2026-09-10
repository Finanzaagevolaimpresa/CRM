import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { createDisabledCommunicationGateSnapshotV1 } from '../src/lib/communication-backbone-contract';
import {
  CommunicationPersistenceError,
  createCommunicationPersistenceAuthorityV1,
} from '../src/lib/communication-intent-persistence';
import { isN15SyntheticSelfClaimAdmitted } from '../src/lib/n15-synthetic-self-claim-admission';

test('N15 migration 44 is one additive transaction with three dedicated dormant records', () => {
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort();
  assert.equal(names.length, 44);
  assert.equal(names.at(-1), '20260909120000_n15_dedicated_communication_persistence_v1');
  const sql = readFileSync(`prisma/migrations/${names.at(-1)}/migration.sql`, 'utf8');
  assert.match(sql, /^--[^\n]*\nBEGIN;/u);
  assert.match(sql, /CREATE TABLE "CommunicationIntentRecord"/u);
  assert.match(sql, /CREATE TABLE "CommunicationHeldDecision"/u);
  assert.match(sql, /CREATE TABLE "CommunicationIntentAudit"/u);
  assert.match(sql, /COMMIT;\s*$/u);
  assert.doesNotMatch(sql, /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/imu);
  assert.doesNotMatch(sql, /BusinessInboxEvent|BusinessOutboxEvent|BusinessQueueAttempt|PracticeCommunication|AuditLog/u);
  assert.doesNotMatch(sql, /tenantId|recipientEndpoint|messageBody|provider|dispatch/iu);
});

test('N15 producer and clock require an explicit internal authority object', () => {
  const authority = createCommunicationPersistenceAuthorityV1({
    producerCode: 'N15_SYNTHETIC_FIXTURE',
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  });
  assert.equal(authority.producerCode, 'N15_SYNTHETIC_FIXTURE');
  assert.equal(Object.isFrozen(authority), true);
  assert.throws(
    () => createCommunicationPersistenceAuthorityV1({ producerCode: 'caller supplied', now: () => new Date() }),
    (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_AUTHORITY_INVALID',
  );
  assert.equal(createDisabledCommunicationGateSnapshotV1().decision, 'HELD');
});

test('N15 contract stays pure and persistence has only the synthetic self-claim call-site', () => {
  const contract = readFileSync('src/lib/communication-backbone-contract.ts', 'utf8');
  assert.doesNotMatch(contract, /@prisma\/client|communication-intent-persistence/u);
  const sources = ['src', 'scripts', 'prisma'].flatMap((directory) => {
    return execFileSync('find', [directory, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n');
  }).filter((source) => source && /\.(?:c|m)?(?:j|t)sx?$/u.test(source)
    && source !== 'src/lib/communication-intent-persistence.ts'
    && source !== 'src/lib/communication-backbone-contract.ts');
  const allowed = new Set([
    'src/lib/n15-synthetic-self-claim.ts',
    'src/lib/commercial-lead-inbox.ts',
  ]);
  for (const source of sources) {
    if (allowed.has(source)) continue;
    assert.doesNotMatch(
      readFileSync(source, 'utf8'),
      /recordCommunicationIntentHeldV1|communication-intent-persistence/u,
      source,
    );
  }
  assert.match(readFileSync('src/lib/commercial-lead-inbox.ts', 'utf8'),
    /input\.activityType === 'CLAIMED'[\s\S]*recordN15SyntheticSelfClaim/u);
});

test('N15 synthetic self-claim admission is explicit and fail-closed', () => {
  const admitted = {
    APP_ENV: 'test', NODE_ENV: 'test', RUN_DB_TESTS: '1',
    AI_ORCHESTRATOR_DB_TESTS_CONFIRMED: '1',
    AI_ORCHESTRATOR_DB_TEST_SENTINEL: 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1',
    N15_SYNTHETIC_SELF_CLAIM_OPT_IN: 'N15_SYNTHETIC_SELF_CLAIM_V1',
    DATABASE_URL: 'postgresql://postgres:synthetic@127.0.0.1:5432/fai_crm_test?schema=n14_test',
  };
  assert.equal(isN15SyntheticSelfClaimAdmitted(admitted), true);
  assert.equal(isN15SyntheticSelfClaimAdmitted({}), false);
  for (const patch of [
    { APP_ENV: 'production' }, { APP_ENV: 'staging' }, { APP_ENV: 'unknown' },
    { NODE_ENV: 'production' }, { N15_SYNTHETIC_SELF_CLAIM_OPT_IN: 'true' },
  ]) assert.equal(isN15SyntheticSelfClaimAdmitted({ ...admitted, ...patch }), false);
  for (const patch of [
    { AI_ORCHESTRATOR_DB_TEST_SENTINEL: 'wrong' },
    { DATABASE_URL: 'postgresql://remote.invalid/fai_crm_test' },
    { DATABASE_URL: 'postgresql://127.0.0.1/another_database?schema=fai_crm_test' },
    { DATABASE_URL: undefined },
  ]) assert.throws(() => isN15SyntheticSelfClaimAdmitted({ ...admitted, ...patch }),
    /N15_SYNTHETIC_DATABASE_CONFIGURATION_INVALID/u);
});

test('N15 CI qualifies migration 44 without weakening historical 43 boundaries', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const restore = readFileSync('scripts/n05/restore-drill.sh', 'utf8');
  const vnx03Guard = readFileSync('scripts/vnx03/verify-protected-scope.sh', 'utf8');
  assert.match(ci, /VNX-05 scoped consumer[\s\S]*?= "44"/u);
  assert.match(ci, /N05 same-image persistent key mounts[\s\S]*?= "44"/u);
  assert.match(ci, /VNX-03 authentic WPForms[\s\S]*?verify-protected-scope\.sh/u);
  assert.match(vnx03Guard, /== '44'/u);
  assert.match(vnx03Guard, /n15_migration='prisma\/migrations\/20260909120000_n15_dedicated_communication_persistence_v1\/migration\.sql'/u);
  assert.match(vnx03Guard, /git diff --diff-filter=A/u);
  assert.match(vnx03Guard, /--diff-filter=DMRTUXB/u);
  assert.match(ci, /EXPECTED_MIGRATION_COUNT=44[\s\S]*?EXPECTED_ROLLBACK_MIGRATION_COUNT="\$rollback_migration_count"/u);
  assert.match(restore, /EXPECTED_MIGRATION_COUNT" == "43" \|\| "\$EXPECTED_MIGRATION_COUNT" == "44"/u);
  assert.match(restore, /ROLLBACK_SOURCE_MIGRATION_COUNT_MISMATCH/u);
  assert.match(restore, /HISTORICAL_MIGRATION_CHANGED/u);
  assert.match(restore, /N15_NOT_DORMANT_BEFORE_ROLLBACK/u);
  assert.match(restore, /N15_NOT_DORMANT_AFTER_ROLLBACK/u);
  assert.match(restore, /database_reachable=true/u);
});
