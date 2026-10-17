import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectRecordChange, mayExposeRecordUpdate, recordUpdateDeliveryState,
  type UpdateDeliveryEvidence, type CurrentUpdateDeliveryAdmission } from '../src/lib/record-update-projection';

const receipt: UpdateDeliveryEvidence = { recipientId: 'technician', eventId: 'event-1', scopeEpoch: 'scope-1',
  directoryBinding: 'directory-1', ruleId: 'rule-1', ruleRevision: 1,
  availableAt: new Date('2026-10-17T10:00:00Z'), readAt: null, emailDraftId: null };
const current: CurrentUpdateDeliveryAdmission = { userId: 'technician', active: true, hasCurrentAccess: true,
  operational: true, scopeEpoch: 'scope-1', directoryBinding: 'directory-1', now: new Date('2026-10-17T10:01:00Z'),
  rule: { id: 'rule-1', revision: 1, active: true, expiresAt: new Date('2026-10-17T11:00:00Z') } };

test('practice change contains field labels only and excludes private and financial values', () => {
  const before = { status: 'in_progettazione', internalNotes: 'old', dueDate: null, margin: 20 };
  const after = { ...before, status: 'in_istruttoria', internalNotes: 'PRIVATE_SECRET', margin: 99,
    dueDate: new Date('2026-12-01T00:00:00Z') };
  assert.deepEqual(projectRecordChange('PRACTICE', before, after), { invalidate: false, summaries: [
    { event: 'STATE_CHANGED', changed: ['status'] }, { event: 'DEADLINE', changed: ['dueDate'] },
  ] });
  assert.deepEqual(projectRecordChange('PRACTICE', before, { ...before, internalNotes: 'PRIVATE_SECRET', margin: 99 }).summaries, []);
});
test('owner changes and archive/restore invalidate even when original values return later', () => {
  for (const [kind, field] of [['LEAD', 'assignedToId'], ['CLIENT', 'salesOwnerId'],
    ['PRACTICE', 'clientId'], ['PROJECT', 'consultantId']] as const) {
    assert.deepEqual(projectRecordChange(kind, { [field]: 'a' }, { [field]: 'b' }), { invalidate: true, summaries: [] });
  }
  assert.deepEqual(projectRecordChange('PROJECT', { status: 'idea' }, { status: 'archiviato' }), { invalidate: true, summaries: [] });
  assert.deepEqual(projectRecordChange('PROJECT', { status: 'archiviato' }, { status: 'idea' }), { invalidate: true, summaries: [] });
  assert.deepEqual(projectRecordChange('LEAD', { deletedAt: '2026-10-17' }, { deletedAt: null }), { invalidate: true, summaries: [] });
});
test('equivalent dates and private-only changes do not generate notices', () => {
  assert.deepEqual(projectRecordChange('LEAD', { nextActionDate: new Date('2026-10-17T10:00:00Z') },
    { nextActionDate: '2026-10-17T10:00:00.000Z', notes: 'private' }).summaries, []);
  assert.deepEqual(projectRecordChange('LEAD', { firstName: 'A', lastName: 'B' },
    { firstName: 'C', lastName: 'D' }).summaries, [{ event: 'RECORD_CHANGED', changed: ['displayName'] }]);
});
test('selected current recipient is admitted, unrelated user and absent current rights are denied', () => {
  assert.equal(mayExposeRecordUpdate(receipt, current), true);
  for (const patch of [{ userId: 'other-admin' }, { active: false }, { hasCurrentAccess: false }, { operational: false }]) {
    assert.equal(mayExposeRecordUpdate(receipt, { ...current, ...patch }), false);
  }
});
test('revoked, expired or replaced rules and changed directory/scope cannot revive old notices', () => {
  for (const rule of [null, { ...current.rule!, active: false }, { ...current.rule!, revision: 2 },
    { ...current.rule!, expiresAt: current.now }, { ...current.rule!, expiresAt: new Date('invalid') }]) {
    assert.equal(mayExposeRecordUpdate(receipt, { ...current, rule }), false);
  }
  for (const patch of [{ scopeEpoch: 'scope-2' }, { directoryBinding: 'directory-2' }]) {
    assert.equal(mayExposeRecordUpdate(receipt, { ...current, ...patch }), false);
  }
});
test('one-shot choice does not acquire persistent authority or invent email send status', () => {
  const oneShot = { ...receipt, ruleId: null, ruleRevision: null };
  assert.equal(mayExposeRecordUpdate(oneShot, { ...current, rule: null }), true);
  assert.equal(mayExposeRecordUpdate({ ...oneShot, ruleRevision: 1 }, current), false);
  assert.deepEqual(recordUpdateDeliveryState(oneShot), { crm: 'DISPONIBILE', email: 'NON_PREPARATA' });
  assert.deepEqual(recordUpdateDeliveryState({ ...oneShot, readAt: current.now, emailDraftId: 'draft-1' }),
    { crm: 'LETTO', email: 'BOZZA_DA_APPROVARE' });
});
test('future or invalid delivery time and forged kind fail closed', () => {
  assert.equal(mayExposeRecordUpdate({ ...receipt, availableAt: new Date('2026-11-01') }, current), false);
  assert.equal(mayExposeRecordUpdate(receipt, { ...current, now: new Date('invalid') }), false);
  assert.throws(() => projectRecordChange('constructor' as never, {}, {}));
});
