import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareRecordUpdateEmailProposal, revalidateRecordUpdateEmailProposal } from '../src/lib/record-update-email-contract';
import { resolveCommunicationRecipients } from '../src/lib/communication-recipient-policy';

const fixture = () => ({
  source: { deliveryId: '11111111-1111-4111-8111-111111111111', eventId: '22222222-2222-4222-8222-222222222222',
    kind: 'LEAD', recordId: 'synthetic-lead', recipientId: 'synthetic-recipient', recipientEpoch: 7,
    authorId: 'synthetic-admin', authorEpoch: 3, ruleId: null as string | null, ruleVersion: null as number | null,
    commandId: '33333333-3333-4333-8333-333333333333' as string | null,
    scopeHash: 'a'.repeat(64), directoryHash: 'b'.repeat(64), occurredAt: '2026-10-18T00:00:00Z',
    recordVersion: '2026-10-18T00:00:01Z', authorityRevision: 1 },
  mode: 'EMAIL_DRAFT', label: 'Contesto sintetico', recipient: { id: 'synthetic-recipient', email: 'Tecnico@EXAMPLE.INVALID' },
  summary: { event: 'NEXT_ACTION', changed: ['nextActionDate', 'nextAction'] },
});

test('proposal contains only labels, one named recipient and no inherited sending decision', () => {
  const result = prepareRecordUpdateEmailProposal(fixture());
  assert.equal(result.subject, 'Prossima azione: Contesto sintetico');
  assert.match(result.body, /Prossima azione, Data della prossima azione/);
  assert.deepEqual(result.recipientSelection.to, { userIds: ['synthetic-recipient'], groups: [] });
  assert.equal(result.source.recipientAddress, 'Tecnico@example.invalid');
  assert.deepEqual(result.externalRecipients, { to: [], cc: [], bcc: [] });
  assert.deepEqual(result.attachments, []);
  assert.equal(result.state, 'DRAFT');
  assert.equal(result.requiresPersonalApproval, true);
  assert.equal(result.sendApproved, false);
  assert.ok(!('mailboxId' in result) && !('approval' in result));
  assert.ok(!result.body.includes('synthetic-admin') && !result.body.includes('example.invalid'));
  const resolved = resolveCommunicationRecipients(result.recipientSelection, [{ id: 'synthetic-recipient',
    name: 'Tecnico sintetico', email: 'Tecnico@example.invalid', role: 'tecnico', active: true, deletedAt: null }], result.externalRecipients);
  assert.deepEqual(resolved.recipients, { to: ['Tecnico@example.invalid'], cc: [], bcc: [] });
});

test('extra notes, financial values, attachments and approval flags are rejected', () => {
  for (const field of ['privateNote', 'margin', 'attachments', 'approval', 'sendApproved']) {
    assert.throws(() => prepareRecordUpdateEmailProposal({ ...fixture(), [field]: 'private-value' }));
  }
  assert.throws(() => prepareRecordUpdateEmailProposal({ ...fixture(), summary: { event: 'NEXT_ACTION', changed: ['privateNote'] } }));
  assert.throws(() => prepareRecordUpdateEmailProposal({ ...fixture(), summary: { event: 'NEXT_ACTION', changed: ['nextAction'], value: 'private-value' } }));
});

test('CRM-only choices and recipient substitution cannot produce an email proposal', () => {
  assert.throws(() => prepareRecordUpdateEmailProposal({ ...fixture(), mode: 'CRM' }));
  assert.throws(() => prepareRecordUpdateEmailProposal({ ...fixture(), recipient: { id: 'another-person', email: 'other@example.invalid' } }), /UPDATE_EMAIL_RECIPIENT_MISMATCH/);
  assert.throws(() => prepareRecordUpdateEmailProposal({ ...fixture(), recipient: { ...fixture().recipient, email: 'a@example.invalid\r\nBcc:other@example.invalid' } }));
  assert.throws(() => prepareRecordUpdateEmailProposal({ ...fixture(), label: 'Contesto\r\nBcc:other@example.invalid' }));
});

test('provenance is bound to event, record, recipient, epochs, scope and channel', () => {
  const input = fixture(), initial = prepareRecordUpdateEmailProposal(input).sourceHash;
  for (const change of [
    { eventId: '44444444-4444-4444-8444-444444444444' }, { recordId: 'another-record' },
    { recipientEpoch: 8 }, { authorEpoch: 4 }, { authorityRevision: 2 }, { scopeHash: 'c'.repeat(64) }, { directoryHash: 'd'.repeat(64) },
  ]) assert.notEqual(prepareRecordUpdateEmailProposal({ ...input, source: { ...input.source, ...change } }).sourceHash, initial);
  assert.notEqual(prepareRecordUpdateEmailProposal({ ...input, mode: 'CRM_AND_EMAIL_DRAFT' }).sourceHash, initial);
  assert.notEqual(prepareRecordUpdateEmailProposal({ ...input, recipient: { ...input.recipient, email: 'changed@example.invalid' } }).sourceHash, initial);
});

test('one source policy is required and a rule revision changes provenance', () => {
  const input = fixture();
  assert.throws(() => prepareRecordUpdateEmailProposal({ ...input, source: { ...input.source, commandId: null } }));
  assert.throws(() => prepareRecordUpdateEmailProposal({ ...input, source: { ...input.source, ruleId: '55555555-5555-4555-8555-555555555555', ruleVersion: 1 } }));
  input.source.commandId = null;
  input.source.ruleId = '55555555-5555-4555-8555-555555555555';
  input.source.ruleVersion = 1;
  const first = prepareRecordUpdateEmailProposal(input);
  input.source.ruleVersion = 2;
  assert.notEqual(prepareRecordUpdateEmailProposal(input).sourceHash, first.sourceHash);
  input.source.ruleVersion = null;
  assert.throws(() => prepareRecordUpdateEmailProposal(input));
});

test('equivalent summary ordering and address domain case produce stable provenance', () => {
  const input = fixture(), result = prepareRecordUpdateEmailProposal(input);
  input.summary.changed.reverse();
  input.recipient.email = 'Tecnico@example.invalid';
  assert.equal(prepareRecordUpdateEmailProposal(input).sourceHash, result.sourceHash);
});

test('a stale preview cannot survive a renamed record, new version or changed recipient generation', () => {
  const input = fixture(), digest = prepareRecordUpdateEmailProposal(input).sourceHash;
  assert.equal(revalidateRecordUpdateEmailProposal(input, digest).sendApproved, false);
  for (const current of [
    { ...input, label: 'Contesto rinominato' },
    { ...input, source: { ...input.source, recordVersion: '2026-10-18T00:01:00Z' } },
    { ...input, source: { ...input.source, recipientEpoch: input.source.recipientEpoch + 1 } },
  ]) assert.throws(() => revalidateRecordUpdateEmailProposal(current, digest), /UPDATE_EMAIL_SOURCE_CHANGED/);
  assert.throws(() => revalidateRecordUpdateEmailProposal(input, ''), /UPDATE_EMAIL_SOURCE_CHANGED/);
  assert.throws(() => prepareRecordUpdateEmailProposal({ ...input, source: { ...input.source, recordVersion: undefined } }));
});
