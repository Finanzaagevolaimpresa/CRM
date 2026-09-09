import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { createDisabledCommunicationGateSnapshotV1 } from '../src/lib/communication-backbone-contract';
import {
  CommunicationPersistenceError,
  createCommunicationPersistenceAuthorityV1,
} from '../src/lib/communication-intent-persistence';

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

test('N15 contract stays pure and persistence has no runtime producer or activation call-site', () => {
  const contract = readFileSync('src/lib/communication-backbone-contract.ts', 'utf8');
  assert.doesNotMatch(contract, /@prisma\/client|communication-intent-persistence/u);
  const sources = ['src', 'scripts', 'prisma'].flatMap((directory) => {
    return execFileSync('find', [directory, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n');
  }).filter((source) => source && /\.(?:c|m)?(?:j|t)sx?$/u.test(source)
    && source !== 'src/lib/communication-intent-persistence.ts'
    && source !== 'src/lib/communication-backbone-contract.ts');
  for (const source of sources) {
    assert.doesNotMatch(
      readFileSync(source, 'utf8'),
      /recordCommunicationIntentHeldV1|communication-intent-persistence/u,
      source,
    );
  }
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
  assert.match(ci, /EXPECTED_MIGRATION_COUNT=44[\s\S]*?EXPECTED_ROLLBACK_MIGRATION_COUNT=43/u);
  assert.match(restore, /EXPECTED_MIGRATION_COUNT" == "43" \|\| "\$EXPECTED_MIGRATION_COUNT" == "44"/u);
  assert.match(restore, /ROLLBACK_SOURCE_MIGRATION_COUNT_MISMATCH/u);
  assert.match(restore, /HISTORICAL_MIGRATION_CHANGED/u);
  assert.match(restore, /N15_NOT_DORMANT_BEFORE_ROLLBACK/u);
  assert.match(restore, /N15_NOT_DORMANT_AFTER_ROLLBACK/u);
  assert.match(restore, /database_reachable=true/u);
});
