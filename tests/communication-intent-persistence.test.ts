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
  const sources = ['src/app', 'scripts'].flatMap((directory) => {
    return execFileSync('find', [directory, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n');
  }).filter(Boolean);
  for (const source of sources) {
    assert.doesNotMatch(readFileSync(source, 'utf8'), /recordCommunicationIntentHeldV1/u, source);
  }
});
