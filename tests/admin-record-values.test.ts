import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { adminRecordCatalogue, adminRecordPolicy } from '../src/lib/admin-record-catalogue';
import { parseAdminRecordValues } from '../src/lib/admin-records';

function values(model: string, patch: Record<string, string>) {
  return { ...Object.fromEntries(adminRecordPolicy(model).fields.map(field => [field, ''])), ...patch };
}
test('the Admin catalogue excludes security, provenance and protocol mutations', () => {
  for (const model of ['User', 'InternalSession', 'ApplicationKeyVersion', 'OrdinaryEmailAttempt', 'AuditLog', 'TechnicalAssignmentDecision', 'AdminRecordRevision'])
    assert.throws(() => adminRecordPolicy(model));
  const protectedFields = new Set(['id', 'createdAt', 'createdById', 'approvedById', 'approvedAt', 'signedAt', 'signedDocumentId',
    'collectedAt', 'accountingDocumentId', 'checksum', 'storagePath', 'uploadedById', 'acceptedAt', 'acceptedById', 'passwordHash',
    'provider', 'futureModel', 'systemPrompt', 'inputSchema', 'outputSchema', 'configVersion', 'promptVersion']);
  for (const policy of adminRecordCatalogue) {
    if (policy.historyOnly) {
      assert(['PrivacyEvidenceReceipt', 'ControlledIntake'].includes(policy.model));
      assert.equal(policy.create, false); assert.equal(policy.trash, null);
      for (const creating of [true, false]) assert.throws(() => parseAdminRecordValues(policy, values(policy.model, {}), creating), /HISTORY/);
    }
    for (const name of policy.fields) {
      assert(policy.historyOnly || !protectedFields.has(name), policy.model + '.' + name);
      const field = Prisma.dmmf.datamodel.models.find(row => row.name === policy.model)?.fields.find(row => row.name === name);
      assert(field && field.kind !== 'object' && !field.isId && !field.isList, policy.model + '.' + name);
    }
  }
});

test('ordinary corrections reject hidden fields, missing fields and non-finite or inaccurate money', () => {
  const p = adminRecordPolicy('Payment'), valid = values('Payment', { clientId: 'client', contractId: 'contract', taxableAmount: '100.10', vatAmount: '22.02', totalAmount: '122.12' });
  assert.equal(parseAdminRecordValues(p, valid, true).totalAmount, '122.12');
  for (const patch of [{ totalAmount: '122.11' }, { taxableAmount: '-10' }, { taxableAmount: '1e9' }, { vatAmount: '0.001' }, { collectedAt: '2026-01-01' }] as Record<string, string>[])
    assert.throws(() => parseAdminRecordValues(p, { ...valid, ...patch }, true));
  const missing = { ...valid }; delete missing.notes;
  assert.throws(() => parseAdminRecordValues(p, missing, true));
});
test('share percentages, IDs and typed dates are validated before persistence', () => {
  const p = adminRecordPolicy('CompanyPerson'), valid = values('CompanyPerson', { companyId: 'company', personId: 'person', role: 'socio', ownershipPercent: '25.50' });
  assert.equal(parseAdminRecordValues(p, valid, true).ownershipPercent, '25.5');
  for (const patch of [{ ownershipPercent: '100.01' }, { ownershipPercent: '-1' }, { personId: '../another' }] as Record<string, string>[]) assert.throws(() => parseAdminRecordValues(p, { ...valid, ...patch }, true));
  const d = values('Deadline', { title: 'Data sintetica', entityType: 'Project', entityId: 'project', dueAt: '2027-01-03T12:30:00+01:00', status: 'aperta' });
  assert.equal((parseAdminRecordValues(adminRecordPolicy('Deadline'), d, true).dueAt as Date).toISOString(), '2027-01-03T11:30:00.000Z');
  assert.throws(() => parseAdminRecordValues(adminRecordPolicy('Deadline'), { ...d, dueAt: '03/01/2027' }, true));
});
test('negative business results are allowed without allowing negative requested finance', () => {
  const p = adminRecordPolicy('BankabilityAssessment');
  const input = values(p.model, { clientId: 'client', netProfit: '-1200.50', equity: '-500', estimatedCashflow: '-100', ebitda: '-10' });
  const parsed = parseAdminRecordValues(p, input, true);
  assert.equal(parsed.netProfit, '-1200.5');
  assert.throws(() => parseAdminRecordValues(p, { ...input, revenue: '-100' }, true));
});
