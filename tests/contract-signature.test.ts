import test from 'node:test';
import assert from 'node:assert/strict';
import type { Client, Contract, Document, DocumentVersion, Project } from '@prisma/client';
import type { AuthSession } from '../src/lib/auth';
import { canRecordContractSignature, contractCanRecordSignature, contractSignatureSchema, isSignatureDocument, signatureCalendarDay } from '../src/lib/contract-signature-policy';
const actor = (role: AuthSession['role'], overrides: AuthSession['permissionOverrides'] = []): AuthSession => ({ userId: 'owner', role, active: true, expiresAt: 9999999999, permissionOverrides: overrides });
const client = { id: 'client', salesOwnerId: 'owner', consultantId: 'owner', deletedAt: null } as Client;
const project = { id: 'project', clientId: 'client', consultantId: 'owner', deletedAt: null } as Project;
const contract = { id: 'contract', clientId: 'client', projectId: null } as Contract;
const document = { id: 'document', clientId: 'client', projectId: null, clientServiceId: null, serviceArea: 'contratti', deletedAt: null,
  status: 'caricato', storagePath: 'private-synthetic-path', checksum: 'a'.repeat(64), containsSensitiveData: true, type: 'contratti', documentCategory: 'contratti', uploadedById: 'owner' } as Document;
const version = { id: 'version', documentId: 'document', storagePath: document.storagePath, checksum: document.checksum, version: 1 } as DocumentVersion;
const command = { contractId: 'contract', expectedVersion: '2026-09-01T12:00:00.000Z', signedDocumentVersionId: 'version', signedOn: '2026-09-01', confirmed: true };

test('signature command requires actual calendar date, explicit attestation and rejects financial overposting', () => {
  assert.equal(contractSignatureSchema.safeParse(command).success, true);
  for (const change of [{ confirmed: false }, { signedOn: '2026-02-30' }, { signedOn: '' }, { expectedVersion: '' }, { status: 'firmato' }, { paymentStatus: 'incassato' }, { clientId: 'other' }]) {
    assert.equal(contractSignatureSchema.safeParse({ ...command, ...change }).success, false);
  }
});
test('signature dates use the Italian calendar, including the UTC day boundary', () => {
  assert.equal(signatureCalendarDay(new Date('2026-09-30T22:30:00Z')), '2026-10-01');
  assert.equal(signatureCalendarDay(new Date('2026-01-31T23:30:00Z')), '2026-02-01');
});
test('cancelled, archived and already signed contracts cannot be signed again', () => {
  for (const status of ['da_preparare', 'preparato', 'inviato_manualmente', 'non_firmato'] as const) assert.equal(contractCanRecordSignature(status), true);
  for (const status of ['firmato', 'annullato', 'archiviato'] as const) assert.equal(contractCanRecordSignature(status), false);
});
test('administration retains contract authority; read-only direction and client grants do not gain write access', () => {
  assert.equal(canRecordContractSignature(actor('admin'), client, null), true);
  assert.equal(canRecordContractSignature(actor('amministrazione'), client, project), true);
  assert.equal(canRecordContractSignature(actor('direzione'), client, null), false);
  assert.equal(canRecordContractSignature(actor('amministrazione', [{ permission: 'contract.write', allowed: false }]), client, null), false);
  const limited = { ...actor('commerciale', [{ permission: 'contract.write', allowed: true }, { permission: 'document.sensitive.read', allowed: true }]), userId: 'outsider', clientReadScope: ['client'] };
  assert.equal(canRecordContractSignature(limited, client, null), false);
  assert.equal(canRecordContractSignature(actor('admin'), client, { ...project, clientId: 'other' }), false);
});
test('signed evidence must be a current contract document in the exact client/project context', () => {
  assert.equal(isSignatureDocument(actor('admin'), contract, client, null, document, version), true);
  for (const change of [{ clientId: 'other' }, { projectId: 'other' }, { clientServiceId: 'other' }, { serviceArea: 'altro' as const },
    { checksum: null }, { checksum: 'wrong' }, { deletedAt: new Date() }, { status: 'respinto' as const }, { status: 'scaduto' as const }, { status: 'archiviato' as const }]) {
    assert.equal(isSignatureDocument(actor('admin'), contract, client, null, { ...document, ...change }, version), false);
  }
  for (const change of [{ documentId: 'other' }, { checksum: 'b'.repeat(64) }, { storagePath: 'changed-path' }]) {
    assert.equal(isSignatureDocument(actor('admin'), contract, client, null, document, { ...version, ...change }), false);
  }
});

test('integrated privacy ceiling also denies signature recording to assigned excluded roles with legacy allows', () => {
  for (const role of ['commerciale', 'consulente', 'revisore', 'backoffice', 'collaboratore_limitato'] as const) {
    const allowed = actor(role, [
      { permission: 'contract.write', allowed: true }, { permission: 'document.download', allowed: true },
      { permission: 'document.sensitive.read', allowed: true },
    ]);
    assert.equal(canRecordContractSignature(allowed, client, project), false, role);
    assert.equal(isSignatureDocument(allowed, contract, client, null, document, version), false, role);
  }
});
