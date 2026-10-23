import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAdminRequestToAuthor } from '../src/lib/admin-request-projection';
import type { CurrentAdminRequestAdmission } from '../src/lib/admin-request-contract';

const now = new Date('2026-10-23T10:00:00Z');
const row = {
  requestId: '4d3b72c3-f4a0-4574-8352-0019235b1f18', authorUserId: 'sales-one', revision: 2,
  status: 'DRAFT_PREPARED', createdAt: '2026-10-23T09:00:00Z', requesterReply: 'Richiesta presa in esame.',
  submitted: { commandId: '5d3b72c3-f4a0-4574-8352-0019235b1f18',
    subject: { kind: 'Client', targetId: 'client-one' }, expectedContextSha256: 'a'.repeat(64),
    expectedRecipientEpoch: 4, expectedAccessRevision: 3, kind: 'DOCUMENT',
    title: 'Documento tecnico richiesto', details: 'Dettaglio fornito dal richiedente.',
  },
};
const admission: CurrentAdminRequestAdmission = { kind: 'COMMERCIAL_OWNER', current: {
  role: 'commerciale', userId: 'sales-one', active: true, sessionLive: true, registryCurrent: true,
  recordWorkable: true, selectiveCeilingAllows: true, subject: { kind: 'Client', targetId: 'client-one' },
  commercialOwnerId: 'sales-one', contextSha256: 'a'.repeat(64), recipientEpoch: 4, accessRevision: 3,
} };

test('the author sees the exact request and explicit reply without private email or Admin fields', () => {
  const result = projectAdminRequestToAuthor({ ...row, privateNote: 'PRIVATE_NOTE_SENTINEL',
    draftId: 'PRIVATE_DRAFT_SENTINEL', emailBody: 'PRIVATE_EMAIL_SENTINEL', recipients: ['private@example.invalid'],
    financialAmount: 12345, attachments: ['PRIVATE_ATTACHMENT_SENTINEL'], readAt: 'invented', providerAccepted: true,
  }, admission, now);
  assert(result);
  assert.deepEqual(Object.keys(result).sort(), ['requestId', 'subject', 'kind', 'title', 'details', 'revision',
    'status', 'statusLabel', 'createdAt', 'requesterReply'].sort());
  assert.equal(result.requesterReply, row.requesterReply);
  assert(!JSON.stringify(result).includes('PRIVATE_'));
  assert(!JSON.stringify(result).includes('private@example.invalid'));
  assert.equal(result.statusLabel, 'Bozza preparata, invio da decidere');
});

test('current ownership alone does not reveal another requester history', () => {
  assert.equal(projectAdminRequestToAuthor({ ...row, authorUserId: 'sales-two' }, admission, now), null);
  assert.equal(projectAdminRequestToAuthor(row, { ...admission,
    current: { ...admission.current, userId: 'sales-two', commercialOwnerId: 'sales-two' },
  }, now), null);
});

test('an open requester page is denied after revocation, context change, expiry-equivalent or trash', () => {
  for (const patch of [{ sessionLive: false }, { registryCurrent: false }, { recordWorkable: false },
    { selectiveCeilingAllows: false }, { contextSha256: 'b'.repeat(64) }, { recipientEpoch: 6 }]) {
    assert.equal(projectAdminRequestToAuthor(row, { ...admission, current: { ...admission.current, ...patch } }, now), null);
  }
});

test('an Admin or an invalid retained row cannot borrow the author projection', () => {
  assert.equal(projectAdminRequestToAuthor(row, { ...admission, current: { ...admission.current, role: 'admin' } }, now), null);
  for (const patch of [{ status: 'SENT' }, { revision: -1 }, { createdAt: 'yesterday' }, { requesterReply: 'x'.repeat(2001) }]) {
    assert.equal(projectAdminRequestToAuthor({ ...row, ...patch }, admission, now), null);
  }
});

test('plain request content stays plain data and does not become a navigation or delivery command', () => {
  const details = '<a href="https://example.invalid">Richiesta</a>';
  const result = projectAdminRequestToAuthor({ ...row, submitted: { ...row.submitted, details } }, admission, now);
  assert.equal(result?.details, details);
  assert.equal(result?.status, 'DRAFT_PREPARED');
  assert.equal(projectAdminRequestToAuthor(row, admission, new Date('invalid')), null);
});
