import test from 'node:test';
import assert from 'node:assert/strict';
import { currentClientPersonSnapshotsMatch, snapshotSelectedClientPeople } from '../src/lib/selective-client-person-snapshot';

const choice = { membershipId: 'membership', companyId: 'company', personId: 'person', fields: ['email'] };
const record = { ...choice, clientId: 'client', companyDeletedAt: null, personDeletedAt: null,
  email: 'synthetic@example.invalid', companyEpoch: 1, membershipEpoch: 1, personEpoch: 1 };
const snapshots = () => snapshotSelectedClientPeople('client', [record], [choice]);
test('snapshot binds all three identities and current persistent generations', () => {
  const approved = snapshots(); assert.equal(currentClientPersonSnapshotsMatch('client', [record], [choice], approved), true);
  assert.deepEqual(Object.keys(approved[0]).sort(), ['membershipId', 'companyId', 'personId', 'companyEpoch', 'membershipEpoch', 'personEpoch', 'stateHash'].sort());
});
test('a restored person, membership or company value cannot revive old approval when generation advances', () => {
  for (const key of ['personEpoch', 'membershipEpoch', 'companyEpoch']) {
    assert.equal(currentClientPersonSnapshotsMatch('client', [{ ...record, [key]: 2 }], [choice], snapshots()), false);
  }
});
test('persistent generations are mandatory positive int32 values, not hashes of current content', () => {
  for (const key of ['personEpoch', 'membershipEpoch', 'companyEpoch']) for (const value of [undefined, null, 0, -1, 1.5, '1', 2147483648]) {
    assert.throws(() => snapshotSelectedClientPeople('client', [{ ...record, [key]: value }], [choice]));
  }
});
test('missing, duplicate, tampered or foreign snapshots fail closed', () => {
  const approved = snapshots();
  for (const value of [undefined, [], [approved[0], approved[0]], [{ ...approved[0], stateHash: 'b'.repeat(64) }],
    [{ ...approved[0], personId: 'other' }], [{ ...approved[0], companyId: 'other' }], [{ ...approved[0], membershipId: 'other' }]]) {
    assert.equal(currentClientPersonSnapshotsMatch('client', [record], [choice], value), false);
  }
  assert.equal(currentClientPersonSnapshotsMatch('client', [{ ...record, email: 'changed@example.invalid' }], [choice], approved), false);
});
