import { randomUUID } from 'node:crypto';
import { type PrismaClient, type RoleCode } from '@prisma/client';
import { createInternalSession } from '../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../src/lib/session';
import { savePrivateDocumentFile } from '../src/lib/storage';
import { previewPurchasedServiceHandoff, type HandoffInput } from '../src/lib/purchased-service-handoff';

// Call only after the shared ephemeral database identity guard has succeeded.
export async function purchasedFixture(db: PrismaClient, passwordHash = 'synthetic-no-login') {
  const tag = `Purchased-${randomUUID()}`;
  async function actor(role: RoleCode, name: string) {
    const user = await db.user.create({ data: { name: `${tag}-${name}`, email: `${tag}-${name}@example.test`, role, passwordHash } });
    const token = createRegistrySessionToken(), tokenDigest = await digestRegistrySessionToken(token.bytes);
    const session = await db.$transaction(tx => createInternalSession(tx, { userId: user.id, tokenDigest }));
    return { ...user, userId: user.id, sessionId: session.id };
  }
  const admin = await actor('admin', 'admin'), tech = await actor('consulente', 'tech'), other = await actor('consulente', 'other');
  const client = await db.client.create({ data: { type: 'societa', displayName: `${tag}-client` } });
  const catalog = await db.serviceCatalog.create({ data: { code: tag, name: `${tag}-service`, category: 'sintetico', active: false } });
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: tag, serviceName: catalog.name,
    serviceDescription: 'Analisi manuale dei materiali e preparazione di un elaborato sintetico revisionabile.', taxableAmount: 100, vatAmount: 22,
    totalAmount: 122, status: 'firmato', signedAt: new Date(Date.now() - 1000) } });
  const payment = await db.payment.create({ data: { clientId: client.id, contractId: contract.id, taxableAmount: 50, vatAmount: 11, totalAmount: 61,
    status: 'incassato', collectedAt: new Date(Date.now() - 1000) } });
  const service = await db.clientService.create({ data: { clientId: client.id, serviceCatalogId: catalog.id, contractId: contract.id,
    paymentId: payment.id, status: 'pagato', paymentStatus: 'parziale' } });
  const documents = [];
  for (const kind of ['contract', 'payment', 'material']) {
    const file = new File([`Synthetic ${kind} ${tag}`], `${kind}.txt`, { type: 'text/plain' });
    const stored = await savePrivateDocumentFile({ file, clientId: client.id, clientServiceId: service.id, fileName: file.name });
    const document = await db.document.create({ data: { ...stored, clientId: client.id, clientServiceId: service.id, type: 'altro',
      title: `${tag}-${kind}`, fileName: file.name, mimeType: file.type, uploadedById: admin.id, status: 'verificato', containsSensitiveData: kind !== 'material' } });
    const version = await db.documentVersion.create({ data: { documentId: document.id, version: 1, storagePath: stored.storagePath, checksum: stored.checksum } });
    documents.push({ ...document, version });
  }
  await db.contract.update({ where: { id: contract.id }, data: { signedDocumentId: documents[0].id } });
  await db.payment.update({ where: { id: payment.id }, data: { accountingDocumentId: documents[1].id } });
  const preview = await previewPurchasedServiceHandoff(db, service.id);
  const input: HandoffInput = { serviceId: service.id, expectedHash: preview.expectedHash, technicalOwnerId: tech.id,
    departmentCode: 'Tecnico sintetico', variantCode: 'Analisi manuale base', dueDate: '2027-01-15T12:00:00.000Z',
    activities: ['Verificare i materiali sintetici', 'Preparare elaborato per revisione'], confirmed: true,
    reason: 'Incarico verificato e prima rata sufficiente secondo le condizioni firmate' };
  return { tag, admin, tech, other, client, catalog, contract, payment, service, documents, input };
}
export type PurchasedFixture = Awaited<ReturnType<typeof purchasedFixture>>;

export async function cleanupPurchasedFixtures(db: PrismaClient, fixtures: PurchasedFixture[]) {
  const clients = fixtures.map(f => f.client.id), users = fixtures.flatMap(f => [f.admin.id, f.tech.id, f.other.id]);
  const practices = await db.technicalPractice.findMany({ where: { clientId: { in: clients } }, select: { id: true } });
  await db.auditLog.deleteMany({ where: { entityType: 'TechnicalPractice', entityId: { in: practices.map(p => p.id) } } });
  await db.task.deleteMany({ where: { clientId: { in: clients } } });
  await db.technicalPractice.deleteMany({ where: { id: { in: practices.map(p => p.id) } } });
  await db.documentVersion.deleteMany({ where: { documentId: { in: fixtures.flatMap(f => f.documents.map(d => d.id)) } } });
  await db.document.deleteMany({ where: { clientId: { in: clients } } });
  await db.clientService.deleteMany({ where: { clientId: { in: clients } } });
  await db.payment.deleteMany({ where: { clientId: { in: clients } } });
  await db.contract.deleteMany({ where: { clientId: { in: clients } } });
  await db.serviceCatalog.deleteMany({ where: { id: { in: fixtures.map(f => f.catalog.id) } } });
  await db.client.deleteMany({ where: { id: { in: clients } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
}
