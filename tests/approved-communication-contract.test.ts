import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { approvedMessageHash, approvedMessageSnapshotSchema, assertExactMessageApproval, mailboxQualification,
  assertCanBeginManualMessage, nextManualMessageState, manualMessageEvidenceSchema } from '../src/lib/approved-communication-contract';

function fixture() {
  const snapshot = approvedMessageSnapshotSchema.parse({ schema: 'fai.approved-email.v1', messageId: randomUUID(), revision: 1,
    context: { kind: 'TECHNICAL', id: 'synthetic-practice' }, clientId: 'synthetic-client', channel: 'EMAIL_MANUAL',
    mailboxId: randomUUID(), mailboxRevision: 1, from: 'assistenza@finanzaagevolaimpresa.it', replyTo: 'assistenza@finanzaagevolaimpresa.it',
    to: ['client@invalid.test'], cc: [], bcc: [], subject: 'Synthetic exact message', body: 'Only the approved message.',
    attachments: [{ documentId: 'doc-1', versionId: 'version-1', sha256: '1'.repeat(64), filename: 'synthetic.pdf', mimeType: 'application/pdf', bytes: 100 }], classification: 'ORDINARY' });
  const mailbox = { id: snapshot.mailboxId, address: snapshot.from, revision: 1, configuredRevision: 1,
    configurationReference: 'synthetic-configuration', testedRevision: 1, testReference: 'synthetic-test', testedAt: '2026-09-27T00:00:00Z',
    enabled: true, method: 'MANUAL_EXTERNAL', responsibleUserId: 'synthetic-admin', restricted: false };
  const approval = { approvalId: randomUUID(), messageId: snapshot.messageId, revision: 1, snapshotHash: approvedMessageHash(snapshot),
    mailboxId: snapshot.mailboxId, mailboxRevision: 1, approverUserId: 'synthetic-admin', approverSessionId: randomUUID(), approvedAt: '2026-09-27T00:00:00Z' };
  return { snapshot, mailbox, approval };
}

test('M4 exact approval invalidates for every message, recipient and attachment change', () => {
  const { snapshot, approval, mailbox } = fixture();
  assert.doesNotThrow(() => assertExactMessageApproval(snapshot, approval, mailbox));
  for (const change of [
    { revision: 2 }, { context: { kind: 'TECHNICAL', id: 'different-practice' } }, { clientId: 'different-client' },
    { from: 'info@finanzaagevolaimpresa.it' }, { replyTo: 'other@invalid.test' }, { to: ['other@invalid.test'] },
    { cc: ['other@invalid.test'] }, { bcc: ['other@invalid.test'] }, { subject: 'Edited' }, { body: 'Edited' },
    { attachments: [] }, { attachments: [{ ...snapshot.attachments[0], versionId: 'version-2' }] },
    { attachments: [{ ...snapshot.attachments[0], sha256: '2'.repeat(64) }] }, { classification: 'COMPLAINT' },
  ]) assert.throws(() => assertExactMessageApproval({ ...snapshot, ...change }, approval, mailbox), /CONFLICT/);
});

test('M4 sender registration does not imply configuration, test or enablement', () => {
  const { mailbox, snapshot, approval } = fixture();
  assert.deepEqual(mailboxQualification({ ...mailbox, configuredRevision: null, testedRevision: null }), {
    registered: true, configured: false, tested: false, enabled: false,
  });
  for (const change of [{ enabled: false }, { testedRevision: null }, { testReference: null }, { responsibleUserId: null }, { revision: 2 }])
    assert.throws(() => assertExactMessageApproval(snapshot, approval, { ...mailbox, ...change }), /SENDER_NOT_READY/);
  assert.equal(mailboxQualification({ ...mailbox, address: 'unregistered@invalid.test' }).registered, false);
});

test('M4 strict message snapshots reject header injection, duplicates, unsafe names and excess bytes', () => {
  const { snapshot } = fixture();
  for (const change of [
    { subject: 'Subject\r\nBcc: injected@invalid.test' }, { to: ['client@invalid.test'], bcc: ['client@invalid.test'] },
    { attachments: [{ ...snapshot.attachments[0], filename: '../private.pem' }] },
    { attachments: [{ ...snapshot.attachments[0], bytes: 20 * 1024 * 1024 + 1 }] },
    { providerEnabled: true }, { channel: 'EMAIL_NATIVE' }, { body: 'hidden\0data' },
  ]) assert.equal(approvedMessageSnapshotSchema.safeParse({ ...snapshot, ...change }).success, false);
  assert.equal(approvedMessageSnapshotSchema.parse({ ...snapshot, body: 'first\r\nsecond' }).body, 'first\nsecond');
});

test('M4 in-progress or uncertain manual outcomes require reconciliation before another attempt', () => {
  assert.doesNotThrow(() => assertCanBeginManualMessage('APPROVED'));
  assert.doesNotThrow(() => assertCanBeginManualMessage('ERROR'));
  for (const state of ['SENDING', 'UNCERTAIN'] as const) assert.throws(() => assertCanBeginManualMessage(state), /RECONCILIATION_REQUIRED/);
  assert.throws(() => assertCanBeginManualMessage('SENT'), /CONFLICT/);
  assert.equal(nextManualMessageState('SENDING', 'UNCERTAIN', false), 'UNCERTAIN');
  assert.throws(() => nextManualMessageState('UNCERTAIN', 'SENT', false), /RECONCILIATION_REQUIRED/);
  assert.equal(nextManualMessageState('UNCERTAIN', 'NOT_SENT', true), 'ERROR');
  assert.equal(nextManualMessageState('UNCERTAIN', 'SENT', true), 'SENT');
  assert.equal(manualMessageEvidenceSchema.safeParse({ method: 'PROVIDER_DELIVERED', outcome: 'SENT', occurredAt: '2026-09-27T00:00:00Z', reference: 'synthetic' }).success, false);
});
