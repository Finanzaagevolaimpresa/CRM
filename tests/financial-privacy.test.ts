import assert from 'node:assert/strict';
import test from 'node:test';
import { canEditDocument, canViewChecklistItem, canViewDocument } from '../src/lib/access-control';
import { financialPermissions, hasFinancialRole, isFinancialDocument, operationalServiceStatus } from '../src/lib/financial-privacy-policy';
import { filterFinancialDocuments } from '../src/lib/financial-document-access';
import { hasPermission } from '../src/lib/permission-evaluator';
import { roleHasPermission } from '../src/lib/permissions';
import { canViewPaymentListRecord } from '../src/lib/business-list-access';

const allowed = ['admin', 'amministrazione', 'direzione'] as const;
const excluded = ['commerciale', 'consulente', 'revisore', 'backoffice', 'collaboratore_limitato'] as const;
const client = { id: 'c', salesOwnerId: 'owner', consultantId: 'owner' };
const document = { id: 'doc', clientId: 'c', projectId: null, clientServiceId: null, client, uploadedById: 'owner', containsSensitiveData: false, documentCategory: 'altro', type: 'application/pdf', title: 'Documento tecnico', fileName: 'tecnico.pdf' };

for (const role of excluded) test(`${role}: financial access denied despite explicit allow, ownership, sharing and sensitive access`, () => {
  const actor = { role, active: true, userId: 'owner', clientReadScope: ['c'], permissionOverrides: financialPermissions.map(permission => ({ permission, allowed: true })) };
  for (const permission of financialPermissions) {
    assert.equal(hasPermission(actor, permission), false);
    assert.equal(roleHasPermission(role, permission), false);
  }
  for (const metadata of [{ serviceArea: 'contratti' }, { documentCategory: 'pagamenti' }, { title: 'Contratto firmato' }, { fileName: 'ricevuta-bonifico.pdf' }, { type: 'contabile' }, { fileName: 'generico.ZIP' }, { mimeType: 'application/zip' }]) {
    assert.equal(canViewDocument(actor, { ...document, ...metadata }, true), false);
    assert.equal(canEditDocument(actor, { ...document, ...metadata }, true), false);
  }
  assert.equal(canViewChecklistItem(actor, { clientId: 'c', client, title: 'Contratto firmato', createdById: 'owner', updatedById: 'owner' }), false);
  assert.equal(canViewPaymentListRecord(actor, { payment: { clientId: 'c', contractId: 'k' }, contract: { id: 'k', clientId: 'c', projectId: null }, client, project: null }), false);
  assert.equal(operationalServiceStatus(actor, 'pagato'), 'disponibile');
  assert.equal(operationalServiceStatus(actor, 'in_lavorazione'), 'in_lavorazione');
});

for (const role of allowed) test(`${role}: financial read remains available, inactive accounts remain denied`, () => {
  const actor = { role, active: true, userId: 'owner', permissionOverrides: [] };
  assert.equal(hasPermission(actor, 'contract.read'), true);
  assert.equal(hasPermission(actor, 'payment.read'), true);
  assert.equal(canViewDocument(actor, { ...document, serviceArea: 'contratti' }, true), true);
  assert.equal(hasFinancialRole({ ...actor, active: false }), false);
  assert.equal(hasPermission({ ...actor, active: false }, 'payment.read'), false);
  assert.equal(operationalServiceStatus(actor, 'pagato'), 'pagato');
});

test('classification preserves ordinary technical accounting records; restrictions cannot be removed with accents or case', () => {
  assert.equal(isFinancialDocument({ title: 'Situazione contabile aggiornata', documentCategory: 'bancabilita' }), false);
  assert.equal(isFinancialDocument({ title: 'CONTRÀTTO FIRMATO' }), true);
  assert.equal(isFinancialDocument({ title: 'Fattura consulenza' }), true);
  assert.equal(isFinancialDocument({ title: 'Visura aggiornata' }), false);
  assert.equal(hasPermission({ role: 'direzione', active: true, permissionOverrides: [{ permission: 'contract.read', allowed: false }] }, 'contract.read'), false);
});

test('canonical bindings hide generic files, including historical formalizations; ordinary files remain visible', async () => {
  const calls: string[][] = [];
  const db = {
    contract: { findMany: async (input: { where: { signedDocumentId: { in: string[] } } }) => { calls.push(input.where.signedDocumentId.in); return [{ signedDocumentId: 'signed' }]; } },
    payment: { findMany: async () => [{ accountingDocumentId: 'paid' }] },
    practiceFormalization: { findMany: async () => [{ signedDocumentId: 'historic' }] },
  } as unknown as Parameters<typeof filterFinancialDocuments>[0];
  const files = ['signed', 'paid', 'historic', 'ordinary'].map(id => ({ ...document, id }));
  assert.deepEqual((await filterFinancialDocuments(db, { role: 'consulente' }, files)).map(x => x.id), ['ordinary']);
  assert.deepEqual(await filterFinancialDocuments(db, { role: 'admin' }, files), files);
  assert.equal(calls.length, 1);
  await filterFinancialDocuments(db, { role: 'consulente' }, Array.from({ length: 403 }, (_, index) => ({ ...document, id: `d${index}` })));
  assert.deepEqual(calls.slice(1).map(x => x.length), [200, 200, 3]);
});

test('binding lookup failure denies the entire read instead of returning unfiltered records', async () => {
  const fail = async () => { throw new Error('DB unavailable'); };
  const db = { contract: { findMany: fail }, payment: { findMany: fail }, practiceFormalization: { findMany: fail } } as unknown as Parameters<typeof filterFinancialDocuments>[0];
  await assert.rejects(filterFinancialDocuments(db, { role: 'consulente' }, [document]), /DB unavailable/);
});
