import assert from 'node:assert/strict';
import test from 'node:test';
import { maxClientCompanyChoices, parseClientCompanyChoices, projectSelectedClientCompanies } from '../src/lib/selective-client-company-policy';

const company = { id: 'company-a', clientId: 'client-a', deletedAt: null,
  name: 'Unselected business name', pec: 'synthetic@example.invalid', vatNumber: 'SYNTHETIC',
  notes: 'private notes', annualRevenue: '900000', unknownFutureField: 'hidden' };
const chosen = [{ companyId: company.id, fields: ['pec'] }];

test('only chosen scalar fields leave the projection, including no implicit company name', () => {
  const result = projectSelectedClientCompanies('client-a', [company], chosen);
  assert.deepEqual(result, [{ companyId: 'company-a', fields: [{ key: 'pec', label: 'PEC', value: 'synthetic@example.invalid' }] }]);
  assert.equal(JSON.stringify(result).includes('Unselected'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('900000'), false);
});
test('new companies in the same client receive no inherited visibility', () => {
  const records = [company, { ...company, id: 'company-new', pec: 'new@example.invalid' }];
  assert.equal(projectSelectedClientCompanies('client-a', records, chosen).length, 1);
  assert.deepEqual(projectSelectedClientCompanies('client-a', records, []), []);
});
test('a selected company from another client is denied', () => {
  assert.throws(() => projectSelectedClientCompanies('other-client', [company], chosen), /CONTEXT_DENIED/);
});
test('a deleted or incompletely loaded company is denied', () => {
  for (const deletedAt of [new Date(), undefined]) {
    assert.throws(() => projectSelectedClientCompanies('client-a', [{ ...company, deletedAt }], chosen), /CONTEXT_DENIED/);
  }
});
test('missing and ambiguous selected identities are denied', () => {
  for (const records of [[], [company, company]]) assert.throws(() => projectSelectedClientCompanies('client-a', records, chosen), /CONTEXT_DENIED/);
});
test('unknown or private fields and extra selection properties are rejected', () => {
  for (const field of ['notes', 'annualRevenue', 'ownershipPercent', '__proto__', 'unknownFutureField']) {
    assert.throws(() => parseClientCompanyChoices([{ companyId: company.id, fields: [field] }]), /INVALID/);
  }
  assert.throws(() => parseClientCompanyChoices([{ ...chosen[0], allCompanies: true }]), /INVALID/);
});
test('empty or duplicated selections cannot silently broaden a choice', () => {
  for (const fields of [[], ['name', 'name']]) assert.throws(() => parseClientCompanyChoices([{ companyId: company.id, fields }]), /INVALID/);
  assert.throws(() => parseClientCompanyChoices([chosen[0], chosen[0]]), /INVALID/);
});
test('the number of explicit companies is bounded', () => {
  const choices = Array.from({ length: maxClientCompanyChoices + 1 }, (_, i) => ({ companyId: `company-${i}`, fields: ['name'] }));
  assert.throws(() => parseClientCompanyChoices(choices), /INVALID/);
});
test('fields are canonicalized without mutating the personal choice', () => {
  const input = [{ companyId: company.id, fields: ['pec', 'name'] }];
  const before = structuredClone(input);
  assert.deepEqual(parseClientCompanyChoices(input)[0].fields, ['name', 'pec']);
  assert.deepEqual(input, before);
});
test('null is visible as missing; objects and absent properties cannot leak through coercion', () => {
  assert.equal(projectSelectedClientCompanies('client-a', [{ ...company, pec: null }], chosen)[0].fields[0].value, '—');
  for (const pec of [{ secret: 'hidden' }, 12, undefined]) {
    assert.throws(() => projectSelectedClientCompanies('client-a', [{ ...company, pec }], chosen), /VALUE_DENIED/);
  }
});
