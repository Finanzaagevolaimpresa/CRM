import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { assertRegistryActivationReady, assertRegistryStartupReady, REGISTRY_ACTIVATION_RECEIPT, REGISTRY_ACTIVATION_ENTITY } from '../src/lib/internal-session-registry';

function receipt(after: unknown = { enabled: true, version: 1, mode: 'registry' }) {
  return { event: REGISTRY_ACTIVATION_RECEIPT, actorId: 'synthetic-admin', after, createdAt: new Date('2026-10-05T10:00:00Z') };
}

function fixture(receipts: ReturnType<typeof receipt>[], live: bigint, unavailable = false) {
  let reads = 0;
  const db = {
    auditLog: { findMany: async (input: unknown) => {
      assert.deepEqual(input, {
        where: { entityType: REGISTRY_ACTIVATION_ENTITY, entityId: 'registry' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2,
        select: { event: true, actorId: true, after: true, createdAt: true },
      });
      return receipts;
    } },
    $queryRaw: async () => { reads++; if (unavailable) throw new Error('STORE_UNAVAILABLE'); return [{ count: live }]; },
  } as unknown as PrismaClient;
  return { db, reads: () => reads };
}

test('first activation still denies live sessions and admits an empty registry', async () => {
  await assert.rejects(assertRegistryStartupReady(fixture([], 1n).db), /ACTIVATION_BLOCKED/);
  await assert.doesNotReject(assertRegistryStartupReady(fixture([], 0n).db));
});
test('proven activation permits repeated read-only restart while the activation guard still denies', async () => {
  const f = fixture([receipt()], 3n);
  await assert.doesNotReject(assertRegistryStartupReady(f.db));
  await assert.doesNotReject(assertRegistryStartupReady(f.db));
  await assert.rejects(assertRegistryActivationReady(f.db), /ACTIVATION_BLOCKED/);
  assert.equal(f.reads(), 3);
});
test('disabled, malformed and ambiguous audit receipts cannot become a permissive restart', async () => {
  for (const after of [null, [], true, { enabled: false, version: 1, mode: 'registry' }, { enabled: true, version: 2, mode: 'registry' }, { enabled: true, version: 1, mode: 'legacy' }]) {
    await assert.rejects(assertRegistryStartupReady(fixture([receipt(after)], 0n).db), /RECEIPT_INVALID/);
  }
  for (const invalid of [{ ...receipt(), actorId: '' }, { ...receipt(), event: 'unrecognized_event' }]) {
    await assert.rejects(assertRegistryStartupReady(fixture([invalid], 0n).db), /RECEIPT_INVALID/);
  }
  await assert.rejects(assertRegistryStartupReady(fixture([receipt(), receipt()], 0n).db), /RECEIPT_INVALID/);
  const disabled = receipt({ enabled: false, version: 1, mode: 'registry' });
  disabled.createdAt = new Date('2026-10-05T10:01:00Z');
  await assert.rejects(assertRegistryStartupReady(fixture([disabled, receipt()], 0n).db), /RECEIPT_INVALID/);
});
test('unavailable audit and session stores fail closed', async () => {
  await assert.rejects(assertRegistryStartupReady(fixture([receipt()], 0n, true).db), /STORE_UNAVAILABLE/);
  const db = { auditLog: { findMany: async () => { throw new Error('AUDIT_UNAVAILABLE'); } } } as unknown as PrismaClient;
  await assert.rejects(assertRegistryStartupReady(db), /AUDIT_UNAVAILABLE/);
});
