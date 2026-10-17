import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { assertOrdinaryEmailRequestOrigin, ordinaryEmailPreviewInput, ordinaryEmailConfirmationInput, ordinaryEmailRejectionInput } from '../src/lib/ordinary-email-request-contract';

const env = { INTERNAL_SESSION_MODE: 'registry', PRIVILEGED_ACCESS_MODE: 'enforced', APP_ORIGIN: 'https://crm.invalid.test' };
const request = { origin: env.APP_ORIGIN, secFetchSite: 'same-origin' };
test('ordinary request rejects missing, cross-site and mismatched origins', () => {
  assert.doesNotThrow(() => assertOrdinaryEmailRequestOrigin(request, env));
  for (const changed of [{ origin: null }, { origin: 'https://outside.invalid.test' }, { secFetchSite: 'cross-site' },
    { secFetchSite: 'same-site' }, { origin: env.APP_ORIGIN+'/elsewhere' }]) {
    assert.throws(() => assertOrdinaryEmailRequestOrigin({ ...request, ...changed }, env));
  }
});
test('ordinary request requires native registry and enforced privileged access', () => {
  for (const changed of [{ INTERNAL_SESSION_MODE: 'legacy' }, { INTERNAL_SESSION_MODE: undefined },
    { PRIVILEGED_ACCESS_MODE: 'disabled' }, { PRIVILEGED_ACCESS_MODE: undefined }, { APP_ORIGIN: undefined }]) {
    assert.throws(() => assertOrdinaryEmailRequestOrigin(request, { ...env, ...changed }));
  }
});
test('missing supplied modes never inherit an enabled ambient process configuration', () => {
  const before = { INTERNAL_SESSION_MODE: process.env.INTERNAL_SESSION_MODE, PRIVILEGED_ACCESS_MODE: process.env.PRIVILEGED_ACCESS_MODE };
  try {
    process.env.INTERNAL_SESSION_MODE = 'registry'; process.env.PRIVILEGED_ACCESS_MODE = 'enforced';
    assert.throws(() => assertOrdinaryEmailRequestOrigin(request, { ...env, INTERNAL_SESSION_MODE: undefined }));
    assert.throws(() => assertOrdinaryEmailRequestOrigin(request, { ...env, PRIVILEGED_ACCESS_MODE: undefined }));
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
test('ordinary form cannot inject actor, authority, cookie, key or transport', () => {
  const preview = { messageId: randomUUID() }, confirmation = { ...preview, requestId: randomUUID(), previewToken: 'signed-preview',
    personalConfirmation: 'APPROVO_E_INVIO_IL_MESSAGGIO_ESATTO' };
  assert.deepEqual(ordinaryEmailConfirmationInput.parse(confirmation), confirmation);
  for (const name of ['session','sessionId','userId','authority','key','sessionToken','stepUpToken','transport','deadline']) {
    assert.equal(ordinaryEmailConfirmationInput.safeParse({ ...confirmation, [name]: 'forged' }).success, false);
    assert.equal(ordinaryEmailPreviewInput.safeParse({ ...preview, [name]: 'forged' }).success, false);
  }
});
test('ordinary confirmation requires an explicit exact-message decision and bounded tokens', () => {
  const input = { messageId: randomUUID(), requestId: randomUUID(), previewToken: 'signed-preview' };
  for (const personalConfirmation of [undefined, '', 'on', true, 'APPROVO_IL_MESSAGGIO_ESATTO']) {
    assert.equal(ordinaryEmailConfirmationInput.safeParse({ ...input, personalConfirmation }).success, false);
  }
  assert.equal(ordinaryEmailConfirmationInput.safeParse({ ...input, personalConfirmation: 'APPROVO_E_INVIO_IL_MESSAGGIO_ESATTO', previewToken: 'x'.repeat(4097) }).success, false);
});

test('personal refusal requires exact version/hash and cannot carry an approval or injected authority', () => {
  const input = { messageId: randomUUID(), expectedRevision: 2, snapshotHash: 'a'.repeat(64), personalConfirmation: 'RIFIUTO_QUESTA_VERSIONE' };
  assert.deepEqual(ordinaryEmailRejectionInput.parse(input), input);
  for (const changed of [{ expectedRevision: 0 }, { expectedRevision: 2_147_483_647 }, { snapshotHash: '' },
    { personalConfirmation: undefined }, { personalConfirmation: 'APPROVO_E_INVIO_IL_MESSAGGIO_ESATTO' },
    { userId: 'other-admin' }, { sessionToken: 'forged' }, { state: 'REJECTED' }, { previewToken: 'forged' }]) {
    assert.equal(ordinaryEmailRejectionInput.safeParse({ ...input, ...changed }).success, false);
  }
});
