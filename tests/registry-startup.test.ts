import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { assertRegistryActivationReady, assertRegistryStartupReady, REGISTRY_ACTIVATION_RECEIPT } from '../src/lib/internal-session-registry';

function fixture(receipt: { enabled: boolean; version: number } | null, live: bigint, unavailable = false) {
  let reads = 0;
  const db = {
    applicationFeatureGate: { findUnique: async (input: unknown) => {
      assert.deepEqual(input, { where: { code: REGISTRY_ACTIVATION_RECEIPT }, select: { enabled: true, version: true } });
      return receipt;
    } },
    $queryRaw: async () => { reads++; if (unavailable) throw new Error('STORE_UNAVAILABLE'); return [{ count: live }]; },
  } as unknown as PrismaClient;
  return { db, reads: () => reads };
}

test('first activation still denies live sessions and admits an empty registry', async () => {
  await assert.rejects(assertRegistryStartupReady(fixture(null, 1n).db), /ACTIVATION_BLOCKED/);
  await assert.doesNotReject(assertRegistryStartupReady(fixture(null, 0n).db));
});
test('proven activation permits repeated read-only restart while the activation guard still denies', async () => {
  const f = fixture({ enabled: true, version: 1 }, 3n);
  await assert.doesNotReject(assertRegistryStartupReady(f.db));
  await assert.doesNotReject(assertRegistryStartupReady(f.db));
  await assert.rejects(assertRegistryActivationReady(f.db), /ACTIVATION_BLOCKED/);
  assert.equal(f.reads(), 3);
});
test('disabled, unknown-version and unavailable registry cannot become a permissive restart', async () => {
  for (const receipt of [{ enabled: false, version: 1 }, { enabled: true, version: 2 }]) {
    await assert.rejects(assertRegistryStartupReady(fixture(receipt, 0n).db), /RECEIPT_INVALID/);
  }
  await assert.rejects(assertRegistryStartupReady(fixture({ enabled: true, version: 1 }, 0n, true).db), /STORE_UNAVAILABLE/);
});
