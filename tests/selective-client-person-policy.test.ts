import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClientPersonChoices, projectSelectedClientPeople, selectiveClientPersonFields } from '../src/lib/selective-client-person-policy';

const choice = { membershipId: 'membership-synthetic', companyId: 'company-synthetic', personId: 'person-synthetic', fields: ['email'] };
const record = { ...choice, clientId: 'client-synthetic', companyDeletedAt: null, personDeletedAt: null,
  firstName: 'Nome sintetico', lastName: 'Cognome sintetico', email: 'referente@example.invalid', phone: null,
  taxCode: 'SYNTHETIC', role: 'Referente', ownershipPercent: '12.345678901234567890', notes: 'private-person-note', companyName: 'private-company-name' };
const project = (records: Record<string, unknown>[] = [record], choices: unknown = [choice]) => projectSelectedClientPeople('client-synthetic', records, choices);

test('person projection returns only selected fields, without implicit names, company or private notes', () => {
  assert.deepEqual(project(), [{ membershipId: choice.membershipId, fields: [{ key: 'email', label: 'Email', value: record.email }] }]);
  for (const excluded of [record.firstName, record.lastName, record.companyName, record.notes, record.taxCode]) assert.ok(!JSON.stringify(project()).includes(excluded));
});
test('a person choice requires the exact membership, person, company and current client', () => {
  for (const patch of [{ membershipId: 'other' }, { companyId: 'other' }, { personId: 'other' }, { clientId: 'other' },
    { companyDeletedAt: new Date() }, { personDeletedAt: new Date() }, { companyDeletedAt: undefined }, { personDeletedAt: undefined }]) {
    assert.throws(() => project([{ ...record, ...patch }]));
  }
  assert.throws(() => project([])); assert.throws(() => project([record, record]));
});
test('another relationship of the same person cannot be substituted or implicitly projected', () => {
  const other = { ...record, membershipId: 'other-membership', companyId: 'other-company', role: 'Other company role' };
  assert.deepEqual(project([record, other]), project());
  assert.throws(() => project([other]));
});
test('closed person catalogue rejects private fields, extras, duplicate fields and duplicate memberships', () => {
  for (const input of [[{ ...choice, fields: ['notes'] }], [{ ...choice, fields: ['email', 'email'] }],
    [{ ...choice, fields: [] }], [choice, choice], [{ ...choice, includeFutureRelationships: true }], [{ ...choice, personId: '' }]]) {
    assert.throws(() => parseClientPersonChoices(input));
  }
});
test('at most 20 explicit memberships; field ordering is canonical and input is not mutated', () => {
  const max = Array.from({ length: 20 }, (_, i) => ({ ...choice, membershipId: `membership-${i}` }));
  assert.equal(parseClientPersonChoices(max).length, 20);
  assert.throws(() => parseClientPersonChoices([...max, { ...choice, membershipId: 'extra' }]));
  const input = [{ ...choice, fields: ['role', 'email', 'firstName'] }], before = JSON.stringify(input);
  assert.deepEqual(parseClientPersonChoices(input)[0].fields, ['firstName', 'email', 'role']);
  assert.equal(JSON.stringify(input), before);
});
test('null values are explicit; missing values, arrays and arbitrary objects cannot be coerced into data', () => {
  assert.equal(project([{ ...record, email: null }])[0].fields[0].value, '—');
  for (const email of [undefined, 12, ['a'], { toString: () => 'bad' }]) assert.throws(() => project([{ ...record, email }]));
  const missing: Record<string, unknown> = { ...record }; delete missing.email; assert.throws(() => project([missing]));
});
test('ownership retains decimal precision and rejects numbers, malformed percentages and out-of-range amounts', () => {
  const choices = [{ ...choice, fields: ['ownershipPercent'] }];
  assert.equal(project([record], choices)[0].fields[0].value, '12,345678901234567890 %');
  for (const ownershipPercent of ['-1', '101', '100.000001', '1e2', '01', 12.1, {}, undefined]) assert.throws(() => project([{ ...record, ownershipPercent }], choices));
  for (const ownershipPercent of ['0', '100.000', null]) assert.doesNotThrow(() => project([{ ...record, ownershipPercent }], choices));
});
test('all seven approved fields have labels; no other personal source fields can leave the projection', () => {
  const fields = Object.keys(selectiveClientPersonFields);
  assert.equal(fields.length, 7); assert.equal(project([record], [{ ...choice, fields }])[0].fields.length, 7);
});
