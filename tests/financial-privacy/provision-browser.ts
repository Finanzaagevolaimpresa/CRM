import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { savePrivateDocumentFile } from '../../src/lib/storage';
import { financialPermissions } from '../../src/lib/financial-privacy-policy';
import { updatePermissionOverridesWithAudit } from '../../src/lib/user-privilege-service';

const db = new PrismaClient();
export const roles: RoleCode[] = ['admin', 'amministrazione', 'direzione', 'commerciale', 'consulente', 'revisore', 'backoffice', 'collaboratore_limitato'];
async function main() {
  assert.equal(process.env.FINANCIAL_PRIVACY_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.FINANCIAL_PRIVACY_BROWSER_PASSWORD!, evidence = process.env.FINANCIAL_PRIVACY_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  const passwordHash = await bcrypt.hash(password, 10);
  const catalog = await db.serviceCatalog.create({ data: { code: 'PRIVACY_SYNTHETIC', name: 'Servizio tecnico sintetico', category: 'altro' } });
  const fixtures = [];
  let adminId = '';
  for (const role of roles) {
    const user = await db.user.create({ data: { name: `Synthetic ${role}`, email: `privacy-${role}@example.test`, passwordHash, role, active: true } });
    if (role === 'admin') adminId = user.id;
    // Deliberately reproduce legacy explicit allows. The role ceiling must win.
    await db.userPermissionOverride.createMany({ data: [...financialPermissions, 'document.download', 'document.upload', 'document.sensitive.read', 'client.read', 'service.read', 'project.read', 'technical.read'].map(permission => ({ userId: user.id, permission, allowed: true })) });
    const client = await db.client.create({ data: { type: 'societa', displayName: `Synthetic privacy ${role}`, consultantId: user.id, salesOwnerId: user.id } });
    await db.clientReadGrant.create({ data: { userId: user.id, clientId: client.id, active: true, createdById: adminId, updatedById: adminId } });
    const project = await db.project.create({ data: { clientId: client.id, title: 'Synthetic technical project', consultantId: user.id } });
    const service = await db.clientService.create({ data: { clientId: client.id, projectId: project.id, serviceCatalogId: catalog.id, assignedToId: user.id, status: 'pagato', paymentStatus: 'incassato', internalNotes: `PRIVATE_NOTE_${role}` } });
    const docs = [];
    for (const kind of ['ordinary', 'signed', 'paid', 'labelled', 'archive']) {
      const zip = kind === 'archive';
      const content = zip ? Buffer.from('504b0506000000000000000000000000000000000000', 'hex') : Buffer.from(`%PDF-1.4\nSynthetic ${kind} ${role}\n%%EOF`);
      const fileName = `${kind}-${role}.${zip ? 'zip' : 'pdf'}`;
      const file = new File([content], fileName, { type: zip ? 'application/zip' : 'application/pdf' });
      const saved = await savePrivateDocumentFile({ file, clientId: client.id, clientServiceId: service.id, fileName });
      const doc = await db.document.create({ data: { ...saved, clientId: client.id, projectId: project.id, clientServiceId: service.id, type: file.type, mimeType: file.type, title: kind === 'labelled' ? `Contratto riservato ${role}` : `Evidence ${kind} ${role}`, fileName, uploadedById: user.id } });
      const version = await db.documentVersion.create({ data: { documentId: doc.id, version: 1, storagePath: saved.storagePath, checksum: saved.checksum } });
      docs.push({ kind, id: doc.id, versionId: version.id, title: doc.title });
    }
    const contract = await db.contract.create({ data: { clientId: client.id, projectId: project.id, contractNumber: `FINANCIAL-${role}`, serviceName: 'Synthetic engagement', taxableAmount: '5000', vatAmount: '1100', totalAmount: '6100', status: 'firmato', signedAt: new Date(), signedDocumentId: docs.find(x => x.kind === 'signed')!.id, notes: `CONTRACT_SECRET_${role}` } });
    const payment = await db.payment.create({ data: { clientId: client.id, contractId: contract.id, taxableAmount: '5000', vatAmount: '1100', totalAmount: '6100', status: 'incassato', accountingDocumentId: docs.find(x => x.kind === 'paid')!.id, notes: `PAYMENT_SECRET_${role}` } });
    await db.clientService.update({ where: { id: service.id }, data: { contractId: contract.id, paymentId: payment.id } });
    fixtures.push({ role, userId: user.id, clientId: client.id, projectId: project.id, serviceId: service.id, contractId: contract.id, paymentId: payment.id, docs });
  }
  const excluded = fixtures.find(x => x.role === 'consulente')!;
  const denied = await db.$transaction(tx => updatePermissionOverridesWithAudit(tx, { userId: adminId }, excluded.userId, [{ permission: 'payment.read', allowed: true }]));
  assert.equal(denied.ok, false, 'Even admin cannot delegate reserved access to an excluded role');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, fixtures, overrideDelegationDenied: true }));
}
main().finally(() => db.$disconnect()).catch(error => { console.error('SYNTHETIC_PRIVACY_FIXTURE_FAILED', error); process.exitCode = 1; });
