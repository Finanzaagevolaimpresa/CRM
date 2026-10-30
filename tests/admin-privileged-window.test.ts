import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivilegedStepUpToken, verifyPrivilegedStepUpToken, verifiedPrivilegedStepUpExpiry } from '../src/lib/privileged-step-up-token';
import { privilegedStepUpTtlSeconds } from '../src/lib/privileged-step-up-policy';

const key = { version: 1, secret: 'synthetic-admin-window-key-00000000000000000000' };
const common = { key, userId: 'synthetic-admin', sessionToken: 'synthetic-session', nowSeconds: 10_000 };
const verify = (token: string, nowSeconds: number, role?: string) => verifyPrivilegedStepUpToken({
  ...common, token, expectedUserId: common.userId, nowSeconds, role });

test('Admin confirmation survives five minutes and expires exactly at thirty minutes', () => {
  const token = createPrivilegedStepUpToken({ ...common, role: 'admin' });
  for (const elapsed of [0, 299, 300, 301, 1799]) assert.equal(verify(token, 10_000 + elapsed, 'admin'), true);
  for (const elapsed of [1800, 1801, 3600]) assert.equal(verify(token, 10_000 + elapsed, 'admin'), false);
  assert.equal(verifiedPrivilegedStepUpExpiry({ ...common, token, expectedUserId: common.userId, role: 'admin' }), 11_800_000);
});

test('other roles, missing role context and a demoted Admin never inherit the longer window', () => {
  for (const role of [undefined, 'commerciale', 'consulente', 'backoffice', 'amministrazione', 'ADMIN']) {
    assert.equal(privilegedStepUpTtlSeconds(role), 300);
    const token = createPrivilegedStepUpToken({ ...common, role });
    assert.equal(verify(token, 10_299, role), true);
    assert.equal(verify(token, 10_300, role), false);
    assert.throws(() => createPrivilegedStepUpToken({ ...common, role, ttlSeconds: 1800 }));
    const admin = createPrivilegedStepUpToken({ ...common, role: 'admin' });
    assert.equal(verify(admin, 10_001, role), false);
  }
});

test('legacy five-minute cookies are accepted without retroactively extending their deadline', () => {
  const old = createPrivilegedStepUpToken(common);
  assert.equal(verify(old, 10_299, 'admin'), true);
  assert.equal(verify(old, 10_300, 'admin'), false);
});

test('Admin proof remains bound to subject, login session and active signing key', () => {
  const token = createPrivilegedStepUpToken({ ...common, role: 'admin' });
  const input = { ...common, token, role: 'admin', expectedUserId: common.userId, nowSeconds: 11_000 };
  assert.equal(verifyPrivilegedStepUpToken(input), true);
  assert.equal(verifyPrivilegedStepUpToken({ ...input, expectedUserId: 'other-admin' }), false);
  assert.equal(verifyPrivilegedStepUpToken({ ...input, sessionToken: 'new-login-session' }), false);
  assert.equal(verifyPrivilegedStepUpToken({ ...input, key: { ...key, version: 2 } }), false);
  assert.equal(verifyPrivilegedStepUpToken({ ...input, key: { ...key, secret: 'different-synthetic-key-00000000000000' } }), false);
  assert.equal(verifyPrivilegedStepUpToken({ ...input, token: undefined }), false);
});

test('issuance can shorten the window to the login expiry and rejects malformed durations', () => {
  const token = createPrivilegedStepUpToken({ ...common, role: 'admin', ttlSeconds: 17 });
  assert.equal(verify(token, 10_016, 'admin'), true);
  assert.equal(verify(token, 10_017, 'admin'), false);
  for (const ttlSeconds of [0, -1, 1801, Infinity, NaN, 1.5])
    assert.throws(() => createPrivilegedStepUpToken({ ...common, role: 'admin', ttlSeconds }));
});
