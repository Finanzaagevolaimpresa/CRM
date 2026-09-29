import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { companyProfileSchema, leadProfileSchema, personProfileSchema, personProfileVersion } from '../src/lib/record-profile-contract';
const company = { name: 'Synthetic company', vatNumber: '', taxCode: '', rea: '', pec: '', legalAddress: '', operatingAddress: '', region: '', province: '', city: '',
  legalForm: '', atecoCode: '', atecoDescription: '', incorporationDate: '', activityStartDate: '', activityStatus: '', employees: '', annualRevenue: '', durcStatus: '', taxRegime: '', notes: '' };

test('optional profile fields clear to null and explicit numeric zero is preserved', () => {
  const result = companyProfileSchema.parse({ ...company, employees: '0', annualRevenue: '0.00' });
  assert.equal(result.pec, null); assert.equal(result.incorporationDate, null);
  assert.equal(result.employees, 0); assert.equal(result.annualRevenue, '0.00');
});
test('company validation rejects malformed email, impossible dates, negative values and invalid numeric precision', () => {
  for (const invalid of [{ pec: 'invalid' }, { incorporationDate: '2026-02-30' }, { employees: '-1' }, { employees: '1.5' },
    { employees: '2147483648' }, { annualRevenue: '-1' }, { annualRevenue: '12.123' }]) {
    assert.equal(companyProfileSchema.safeParse({ ...company, ...invalid }).success, false);
  }
  assert.equal(companyProfileSchema.parse({ ...company, incorporationDate: '2024-02-29' }).incorporationDate?.toISOString(), '2024-02-29T00:00:00.000Z');
});
test('profile edits cannot overpost lead status, ownership or target-client linkage', () => {
  const lead = { firstName: 'Synthetic', lastName: 'Lead', companyName: '', contactPerson: '', email: '', phone: '', region: '', province: '', city: '' };
  for (const injected of [{ status: 'vinto' }, { assignedToId: 'other' }, { clientId: 'other' }]) assert.equal(leadProfileSchema.safeParse({ ...lead, ...injected }).success, false);
  assert.equal(companyProfileSchema.safeParse({ ...company, clientId: 'other' }).success, false);
});
test('acquired leads may retain missing names while updating company and contacts', () => {
  const lead = { firstName: ' ', lastName: '', companyName: 'Synthetic company', contactPerson: '', email: 'contact@example.test', phone: '', region: '', province: '', city: '' };
  const result = leadProfileSchema.parse(lead);
  assert.equal(result.firstName, ''); assert.equal(result.lastName, '');
  assert.equal(result.companyName, lead.companyName); assert.equal(result.email, lead.email);
  assert.equal(personProfileSchema.safeParse({ firstName: '', lastName: '', email: '', phone: '', taxCode: '', notes: '', role: 'Referente', ownershipPercent: '' }).success, false);
});
test('person share is bounded and optimistic fingerprint covers both person and company membership', () => {
  const person = { firstName: 'Synthetic', lastName: 'Person', email: '', phone: '', taxCode: '', notes: '', role: 'Socio', ownershipPercent: '100' };
  assert.equal(personProfileSchema.safeParse(person).success, true);
  assert.equal(personProfileSchema.safeParse({ ...person, ownershipPercent: '100.01' }).success, false);
  const membership = { id: 'link', companyId: 'company', personId: 'person', role: 'Socio', ownershipPercent: new Prisma.Decimal('10.5') };
  const hash = personProfileVersion(person, membership);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, personProfileVersion({ ...person, phone: 'changed' }, membership));
  assert.notEqual(hash, personProfileVersion(person, { ...membership, role: 'Referente' }));
});
