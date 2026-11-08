import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSecureLeadGatewayKeyring, SecureLeadGatewayError } from '../../src/lib/secure-lead-gateway';
import { N12_SYNTHETIC_KEY_ID, N12_SYNTHETIC_SECRET } from '../fixtures/n12-secure-lead-gateway-v2';

test('N12 reads only a protected, bounded and exact synthetic keyring file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n12-keyring-'));
  const path = join(root, 'synthetic-keyring.json');
  const secretBase64 = N12_SYNTHETIC_SECRET.toString('base64');
  const validKeyring = JSON.stringify({
    version: 1,
    keys: [{ keyId: N12_SYNTHETIC_KEY_ID, secretBase64 }],
  });
  try {
    writeFileSync(path, validKeyring, { mode: 0o600 });
    const keyring = await readSecureLeadGatewayKeyring(path, { allowedRoot: root });
    assert.equal(keyring.size, 1);
    assert.deepEqual(keyring.get(N12_SYNTHETIC_KEY_ID), N12_SYNTHETIC_SECRET);
    const copy = keyring.get(N12_SYNTHETIC_KEY_ID);
    copy?.fill(0);
    assert.deepEqual(keyring.get(N12_SYNTHETIC_KEY_ID), N12_SYNTHETIC_SECRET);

    for (const duplicate of [
      `{"version":1,"version":1,"keys":[{"keyId":"${N12_SYNTHETIC_KEY_ID}","secretBase64":"${secretBase64}"}]}`,
      `{"version":1,"keys":[{"keyId":"${N12_SYNTHETIC_KEY_ID}","key\\u0049d":"${N12_SYNTHETIC_KEY_ID}","secretBase64":"${secretBase64}"}]}`,
      `{"version":1,"keys":[{"keyId":"${N12_SYNTHETIC_KEY_ID}","secretBase64":"${secretBase64}","secretBase64":"${secretBase64}"}]}`,
    ]) {
      writeFileSync(path, duplicate, { mode: 0o600 });
      await assert.rejects(
        () => readSecureLeadGatewayKeyring(path, { allowedRoot: root }),
        (error: unknown) => error instanceof SecureLeadGatewayError
          && error.code === 'TEMPORARILY_UNAVAILABLE',
      );
    }

    writeFileSync(path, validKeyring, { mode: 0o600 });
    chmodSync(path, 0o644);
    await assert.rejects(
      () => readSecureLeadGatewayKeyring(path, { allowedRoot: root }),
      (error: unknown) => error instanceof SecureLeadGatewayError
        && error.code === 'TEMPORARILY_UNAVAILABLE',
    );
    chmodSync(path, 0o600);
    const link = join(root, 'synthetic-link.json');
    symlinkSync(path, link);
    await assert.rejects(
      () => readSecureLeadGatewayKeyring(link, { allowedRoot: root }),
      (error: unknown) => error instanceof SecureLeadGatewayError
        && error.code === 'TEMPORARILY_UNAVAILABLE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
