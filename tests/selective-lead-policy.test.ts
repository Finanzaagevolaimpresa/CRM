import assert from 'node:assert/strict';
import test from 'node:test';
import { isSelectiveLead, leadFieldProjection, leadOutsideSelection, selectiveLeadSelectionSchema } from '../src/lib/selective-lead-policy';

const input = { leadId: 'lead-a', recipientId: 'recipient-a', revision: 0,
  commandId: '6ed53ce8-b306-46da-9b97-a9d2230d9ee9', fields: ['companyName', 'status'], expiresAt: null };

test('a two-field projection never returns contacts, internal notes, financial values or linked contexts', () => {
  const projected = leadFieldProjection({ companyName: 'Impresa sintetica', status: 'da_contattare',
    email: 'hidden@example.invalid', notes: 'PRIVATE', requestedAmount: '9000', clientId: 'private-client',
    approvedCommunications: [{ text: 'PRIVATE_MESSAGE' }] }, ['companyName', 'status']);
  assert.deepEqual(projected, [
    { key: 'companyName', label: 'Azienda', value: 'Impresa sintetica' },
    { key: 'status', label: 'Stato', value: 'da_contattare' },
  ]);
  assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
});

test('unlisted fields and new write/file capabilities are rejected rather than silently accepted', () => {
  for (const fields of [['notes'], ['requestedAmount'], ['clientId'], ['futureField']]) {
    assert.equal(selectiveLeadSelectionSchema.safeParse({ ...input, fields }).success, false);
  }
  for (const key of ['write', 'upload', 'download', 'documents', 'role']) {
    assert.equal(selectiveLeadSelectionSchema.safeParse({ ...input, [key]: true }).success, false);
  }
  assert.equal(selectiveLeadSelectionSchema.safeParse(input).success, true);
});

test('empty, repeated, malformed and unversioned commands cannot become a selection', () => {
  for (const change of [{ fields: [] }, { fields: ['status', 'status'] }, { leadId: '../lead' },
    { revision: -1 }, { revision: 1.5 }, { commandId: 'replay-without-id' }, { expiresAt: 'tomorrow' }]) {
    assert.equal(selectiveLeadSelectionSchema.safeParse({ ...input, ...change }).success, false);
  }
});

test('historical restrictions exclude an Admin-like actor and fail closed on missing record identity', () => {
  const scope = { role: 'admin', selectiveLeadIds: ['restricted', 'restricted'] };
  assert.equal(isSelectiveLead(scope, 'restricted'), true);
  assert.equal(isSelectiveLead(scope, 'other'), false);
  assert.equal(isSelectiveLead(scope), true);
  assert.equal(isSelectiveLead(scope, null), true);
  assert.deepEqual(leadOutsideSelection(scope), { id: { notIn: ['restricted'] } });
  assert.equal(isSelectiveLead({}, 'other'), false);
});

test('projection rejects nested data or an invalid runtime field even after a forged type cast', () => {
  assert.throws(() => leadFieldProjection({ companyName: { private: true } }, ['companyName']));
  assert.throws(() => leadFieldProjection({ notes: 'secret' }, ['notes' as 'status']));
  assert.throws(() => leadFieldProjection({ status: 'nuovo' }, ['status', 'status']));
  assert.deepEqual(leadFieldProjection({ companyName: null }, ['companyName']),
    [{ key: 'companyName', label: 'Azienda', value: '—' }]);
});
