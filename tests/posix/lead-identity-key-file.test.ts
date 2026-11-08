import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { assertLeadIdentityKeyConsensus, calculateLeadIdentityKeyDigest, LeadIdentityError, readLeadIdentityKeyFile } from '../../src/lib/lead-identity';
import { N13_SYNTHETIC_KEY_SECRET, N13_SYNTHETIC_KEY_VERSION } from '../fixtures/n13-lead-projection-v1';

test('identity key file is exact, private, file-only and consensus-bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n13-identity-key-'));
  const path = join(root, 'lead-identity.json');
  try {
    writeFileSync(path, JSON.stringify({
      version: N13_SYNTHETIC_KEY_VERSION,
      secretBase64: N13_SYNTHETIC_KEY_SECRET.toString('base64'),
    }), { mode: 0o600 });
    const key = await readLeadIdentityKeyFile(path, { allowedRoot: root });
    assert.equal(key.version, N13_SYNTHETIC_KEY_VERSION);
    assert.equal(key.keyDigest, calculateLeadIdentityKeyDigest(N13_SYNTHETIC_KEY_SECRET));
    assert.equal(key.secret.equals(N13_SYNTHETIC_KEY_SECRET), true);

    const consensusTx = {
      $queryRaw: async () => [{
        id: '00000000-0000-4000-8000-000000000017',
        version: key.version,
        keyDigest: key.keyDigest,
      }],
    } as unknown as Prisma.TransactionClient;
    const active = await assertLeadIdentityKeyConsensus(consensusTx, key);
    assert.equal(active.version, key.version);

    const mismatchTx = {
      $queryRaw: async () => [{
        id: '00000000-0000-4000-8000-000000000017',
        version: key.version + 1,
        keyDigest: key.keyDigest,
      }],
    } as unknown as Prisma.TransactionClient;
    await assert.rejects(
      assertLeadIdentityKeyConsensus(mismatchTx, key),
      (error: unknown) => error instanceof LeadIdentityError
        && error.code === 'N13_IDENTITY_KEY_CONSENSUS_FAILURE',
    );

    chmodSync(path, 0o644);
    await assert.rejects(
      readLeadIdentityKeyFile(path, { allowedRoot: root }),
      (error: unknown) => error instanceof LeadIdentityError
        && error.code === 'N13_IDENTITY_KEY_UNAVAILABLE',
    );
    chmodSync(path, 0o600);
    writeFileSync(path, '{"version":7,"secretBase64":"invalid","extra":true}', { mode: 0o600 });
    await assert.rejects(
      readLeadIdentityKeyFile(path, { allowedRoot: root }),
      (error: unknown) => error instanceof LeadIdentityError
        && error.code === 'N13_IDENTITY_KEY_UNAVAILABLE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  await assert.rejects(
    readLeadIdentityKeyFile(''),
    (error: unknown) => error instanceof LeadIdentityError
      && error.code === 'N13_IDENTITY_KEY_UNAVAILABLE',
  );
});
