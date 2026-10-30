import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { savePrivateDocumentFile } from '../../src/lib/storage';

export async function paymentCorrectionFixture(db: PrismaClient, actorId: string) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert(process.env.LOCAL_DOCUMENT_STORAGE_ROOT);
  const tag = randomUUID(), client = await db.client.create({ data: { displayName: `Rettifica sintetica ${tag}`, type: 'societa' } });
  const file = new File(['Prova amministrativa esclusivamente sintetica ' + tag], 'synthetic.txt', { type: 'text/plain' });
  const stored = await savePrivateDocumentFile({ file, fileName: file.name, clientId: client.id });
  const document = await db.document.create({ data: { clientId: client.id, title: `Prova rettifica ${tag}`, type: 'altro', status: 'verificato',
    fileName: file.name, mimeType: file.type, uploadedById: actorId, ...stored } });
  const version = await db.documentVersion.create({ data: { documentId: document.id, version: 1, storagePath: stored.storagePath, checksum: stored.checksum } });
  const original = await db.document.create({ data: { clientId: client.id, title: `Incasso sintetico originario ${tag}`, type: 'altro', status: 'verificato',
    fileName: file.name, mimeType: file.type, uploadedById: actorId, ...stored } });
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: tag, serviceName: 'Servizio sintetico',
    taxableAmount: 200, vatAmount: 44, totalAmount: 244, status: 'firmato', signedAt: new Date(Date.now() - 600_000), signedDocumentId: original.id } });
  const payment = await db.payment.create({ data: { clientId: client.id, contractId: contract.id, taxableAmount: 100, vatAmount: 22, totalAmount: 122,
    status: 'incassato', collectedAt: new Date(Date.now() - 300_000), accountingDocumentId: original.id } });
  const catalog = await db.serviceCatalog.create({ data: { code: tag, name: 'Catalogo sintetico', category: 'test', basePrice: 200 } });
  const service = await db.clientService.create({ data: { clientId: client.id, contractId: contract.id, paymentId: payment.id, serviceCatalogId: catalog.id,
    paymentStatus: 'parziale' } });
  return { client, contract, payment, service, document, version, effectiveAt: new Date(Date.now() - 120_000).toISOString() };
}
