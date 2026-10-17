import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { updateCommandSchema, updatePatchSchema } from '../src/lib/record-update-input';
import { projectRecordChange } from '../src/lib/record-update-projection';
import { resolveUpdateSelection, type UpdateDirectoryPerson } from '../src/lib/record-update-contract';

test('native full timestamp survives an untouched patch; profile fields cannot be smuggled into an update', () => {
  const patch = { kind: 'LEAD' as const, nextActionDate: '2026-10-17T18:02:03.456Z', nextActionNote: 'Synthetic next action' };
  assert.deepEqual(updatePatchSchema.parse(patch), patch);
  for (const extra of ['assignedToId', 'clientId', 'deletedAt', 'firstResponseAt', 'status'])
    assert.equal(updatePatchSchema.safeParse({ ...patch, [extra]: 'anything' }).success, false);
  assert.equal(updatePatchSchema.safeParse({ ...patch, nextActionDate: '2026-10-17' }).success, false);
  assert.equal(projectRecordChange('LEAD', patch, { ...patch }).summaries.length, 0);
});
test('record and operation must match the exact patch; archived states use their separate lifecycle', () => {
  const command = { commandId: randomUUID(), kind: 'PROJECT', recordId: 'synthetic', operation: 'UPDATE',
    expectedVersion: '2026-10-17T18:02:03.456Z', ruleVersion: 0, selection: { people: ['admin'], groups: [] },
    events: ['STATE_CHANGED'], persistent: false, expiresAt: null, patch: { kind: 'PROJECT', title: 'Synthetic', status: 'idea' } };
  assert.equal(updateCommandSchema.safeParse(command).success, true);
  for (const patch of [{ ...command.patch, status: 'archiviato' }, { kind: 'LEAD', nextActionDate: '', nextActionNote: '' }])
    assert.equal(updateCommandSchema.safeParse({ ...command, patch }).success, false);
  for (const operation of ['RULE', 'REVOKE'])
    assert.equal(updateCommandSchema.safeParse({ ...command, operation }).success, false);
  assert.equal(updateCommandSchema.safeParse({ ...command, grantAccess: true }).success, false);
});
test('a temporary group membership or revoked access cannot restore an old selection; unrelated users do not affect direct selection', () => {
  const original: UpdateDirectoryPerson[] = [
    { id: 'sales', name: 'Sales', email: 'sales@invalid.test', role: 'commerciale', active: true, deleted: false, revision: '1' },
    { id: 'other', name: 'Other', email: 'other@invalid.test', role: 'consulente', active: true, deleted: false, revision: '1' },
  ];
  const afterReturn = original.map(p => p.id === 'other' ? { ...p, revision: '3' } : p);
  const group = { people: [], groups: ['commerciali'] }, direct = { people: ['sales'], groups: [] };
  assert.notEqual(resolveUpdateSelection(group, original).directoryBinding, resolveUpdateSelection(group, afterReturn).directoryBinding);
  assert.equal(resolveUpdateSelection(direct, original).directoryBinding, resolveUpdateSelection(direct, afterReturn).directoryBinding);
});
test('suspension and restoration suppress events and invalidate the old context', () => {
  for (const [before, after] of [['attivo', 'sospeso'], ['sospeso', 'attivo']]) {
    assert.deepEqual(projectRecordChange('CLIENT', { status: before }, { status: after }), { invalidate: true, summaries: [] });
  }
});
