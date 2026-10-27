import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { createPrivilegedStepUpToken, verifiedPrivilegedStepUpExpiry } from '../src/lib/privileged-step-up-token';
import { prepareTechnicalPrivateItemRecord, readTechnicalPrivateItemRecord } from '../src/lib/technical-private-item-journal';
import { previewTechnicalPrivateItemCreation, signTechnicalPrivateItemOrigin, signTechnicalPrivateItemReceipt } from '../src/lib/technical-private-item-proof';
import type { TechnicalPrivateItemAdmission, TechnicalPrivateItemCommand } from '../src/lib/technical-private-item-contract';

const now = new Date('2026-10-27T01:00:00.000Z'), key = { version: 1, secret: 'synthetic-private-journal-only-00000000' };
const command: TechnicalPrivateItemCommand = { commandId: randomUUID(), itemId: randomUUID(),
  kind: 'Task', target: { kind: 'Project', targetId: 'synthetic-project' }, expectedContextSha256: 'a'.repeat(64),
  values: { title: 'Attività privata sintetica', description: 'CONTENUTO_NON_SELEZIONATO', priority: 'media', dueAt: null } };
const admission: TechnicalPrivateItemAdmission = { authorityId: 'technical-assignment', authorityUserId: 'synthetic-admin',
  authorityRevision: 1, authorityEnabled: true, actorId: 'synthetic-admin', actorEpoch: 2, role: 'admin',
  managerAllowed: true, serviceWriteAllowed: true, sessionId: randomUUID(), sessionExpiresAt: now.getTime() + 3600000,
  personalProofExpiresAt: now.getTime() + 300000, keyVersion: 1, target: command.target,
  contextSha256: command.expectedContextSha256, targetOperational: true,
  parent: { clientId: 'synthetic-client', projectId: 'synthetic-project', serviceId: null, companyId: null } };
function record() {
  const preview = previewTechnicalPrivateItemCreation(key, command, admission, now.getTime());
  const saved = prepareTechnicalPrivateItemRecord(key, command, admission, preview.token, true, new Date(now.getTime() + 1));
  assert(saved); return saved;
}

test('retained receipt remains verifiable after the original proof expires without extending authority', () => {
  const saved = record();
  assert.deepEqual(readTechnicalPrivateItemRecord(key, saved, new Date(now.getTime() + 3600000)), saved);
  assert.equal(saved.receipt.grantCreated, false); assert.equal(saved.receipt.notificationCreated, false);
  assert.equal(JSON.stringify(saved.receipt).includes(command.values.title), false);
  assert.equal(JSON.stringify(saved.receipt).includes(command.values.description!), false);
});
test('retained record rejects substituted origin, admission, command and signature independently', () => {
  const saved = record(), at = new Date(now.getTime() + 10);
  const changes = [
    { command: { ...saved.command, values: { ...saved.command.values, title: 'Altro contenuto' } } },
    { admission: { ...saved.admission, actorEpoch: 3 } },
    { origin: { ...saved.origin, target: { ...saved.origin.target, targetId: 'other' } } },
    { originProof: '0'.repeat(64) }, { receiptProof: '0'.repeat(64) },
    { receipt: { ...saved.receipt, notificationCreated: true } },
  ];
  for (const delta of changes) assert.equal(readTechnicalPrivateItemRecord(key, { ...saved, ...delta }, at), null);
  assert.equal(readTechnicalPrivateItemRecord(key, { ...saved, extra: true }, at), null);
  assert.equal(readTechnicalPrivateItemRecord({ ...key, version: 2 }, saved, at), null);
  assert.equal(readTechnicalPrivateItemRecord(key, saved, now), null);
});
test('individually valid signatures cannot splice an unrelated origin or admission into a receipt', () => {
  const saved = record(), at = new Date(now.getTime() + 10);
  const origin = { ...saved.origin, projectId: 'other-project' };
  assert.equal(readTechnicalPrivateItemRecord(key, { ...saved, origin, originProof: signTechnicalPrivateItemOrigin(key, origin) }, at), null);
  const receipt = { ...saved.receipt, admissionSha256: canonicalSha256({ ...admission, actorEpoch: 3 }) };
  assert.equal(readTechnicalPrivateItemRecord(key, { ...saved, receipt, receiptProof: signTechnicalPrivateItemReceipt(key, receipt) }, at), null);
});
test('signed receipt with an admission already expired when recorded is rejected', () => {
  const saved = record(), expired = { ...admission, personalProofExpiresAt: now.getTime() };
  const receipt = { ...saved.receipt, admissionSha256: canonicalSha256(expired) };
  assert.equal(readTechnicalPrivateItemRecord(key, { ...saved, admission: expired, receipt,
    receiptProof: signTechnicalPrivateItemReceipt(key, receipt) }, new Date(now.getTime() + 10)), null);
});
test('only a verified subject/session token can provide the personal expiry used by creation', () => {
  const seconds = now.getTime() / 1000, token = createPrivilegedStepUpToken({ key, userId: 'admin',
    sessionToken: 'synthetic-session', nowSeconds: seconds, ttlSeconds: 60 });
  const input = { token, key, expectedUserId: 'admin', sessionToken: 'synthetic-session', nowSeconds: seconds };
  assert.equal(verifiedPrivilegedStepUpExpiry(input), now.getTime() + 60000);
  for (const delta of [{ expectedUserId: 'other' }, { sessionToken: 'other' }, { nowSeconds: seconds + 60 },
    { token: token + 'x' }, { token: undefined }, { key: { ...key, version: 2 } }])
    assert.equal(verifiedPrivilegedStepUpExpiry({ ...input, ...delta }), null);
});
