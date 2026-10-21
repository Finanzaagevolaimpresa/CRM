import assert from 'node:assert/strict';
import test from 'node:test';
import { currentClientCompanySnapshotsMatch as matches, snapshotSelectedClientCompanies as snapshot } from '../src/lib/selective-client-company-snapshot';

const row = { id: 'company-a', clientId: 'client-a', deletedAt: null, companyEpoch: 4,
  name: 'Not selected', pec: 'synthetic@example.invalid', notes: 'private' };
const choice = [{ companyId: row.id, fields: ['pec'] }];
const approved = () => snapshot('client-a', [row], choice);

test('the exact selected identity, generation and scalar are retained without content in the snapshot', () => {
  const proof = approved();
  assert.equal(matches('client-a', [row], choice, proof), true);
  assert.deepEqual(Object.keys(proof[0]).sort(), ['companyEpoch', 'companyId', 'stateHash']);
  assert.equal(JSON.stringify(proof).includes(row.pec), false);
  assert.equal(JSON.stringify(proof).includes(row.notes), false);
});
test('new companies and unselected values have no inherited access or representation', () => {
  const current = [{ ...row, notes: 'different private note' }, { ...row, id: 'company-b' }];
  assert.equal(matches('client-a', current, choice, approved()), true);
  assert.equal(snapshot('client-a', current, choice).length, 1);
});
test('a selected value change is rejected even before a generation mismatch is considered', () => {
  assert.equal(matches('client-a', [{ ...row, pec: 'changed@example.invalid' }], choice, approved()), false);
});
test('restoring the same content after a generation increment never revives the old snapshot', () => {
  assert.equal(matches('client-a', [{ ...row, companyEpoch: 6 }], choice, approved()), false);
});
test('reparenting, deletion and incomplete records deny an already approved selection', () => {
  for (const change of [{ clientId: 'other-client' }, { deletedAt: new Date() }, { deletedAt: undefined }]) {
    assert.equal(matches('client-a', [{ ...row, ...change }], choice, approved()), false);
  }
  assert.equal(matches('client-a', [], choice, approved()), false);
  assert.equal(matches('client-a', [row, row], choice, approved()), false);
});
test('no default generation is accepted for missing, invalid or unsafe witnesses', () => {
  for (const companyEpoch of [undefined, null, 0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.throws(() => snapshot('client-a', [{ ...row, companyEpoch }], choice), /GENERATION_DENIED/);
  }
});
test('changing selected fields invalidates the exact decision even on the same company', () => {
  for (const fields of [['name'], ['name', 'pec']]) {
    assert.equal(matches('client-a', [row], [{ companyId: row.id, fields }], approved()), false);
  }
});
test('null is distinct from a real em dash in the signed content', () => {
  const empty = snapshot('client-a', [{ ...row, pec: null }], choice);
  assert.equal(matches('client-a', [{ ...row, pec: '—' }], choice, empty), false);
});
test('duplicate, extra, missing or altered snapshot values are denied', () => {
  const [proof] = approved();
  for (const value of [undefined, null, {}, [], [proof, proof], [{ ...proof, allCompanies: true }],
    [{ ...proof, companyId: 'company-b' }], [{ ...proof, stateHash: '0'.repeat(64) }],
    [{ companyId: proof.companyId, stateHash: proof.stateHash }]]) {
    assert.equal(matches('client-a', [row], choice, value), false);
  }
});
test('snapshot order is irrelevant but each selected company must appear exactly once', () => {
  const second = { ...row, id: 'company-b', pec: 'second@example.invalid' };
  const choices = [...choice, { companyId: second.id, fields: ['pec'] }];
  const proof = snapshot('client-a', [row, second], choices);
  assert.equal(matches('client-a', [row, second], choices, [...proof].reverse()), true);
  assert.equal(matches('client-a', [row, second], choices, [proof[0], proof[0]]), false);
});
test('an explicit empty company selection grants no companies; an absent proof is not inferred', () => {
  assert.equal(matches('client-a', [row], [], []), true);
  assert.equal(matches('client-a', [row], [], undefined), false);
  assert.equal(matches('client-a', [row], choice, []), false);
});
