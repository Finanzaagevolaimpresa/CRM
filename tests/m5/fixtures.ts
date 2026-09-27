import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Prisma, type PrismaClient, type RoleCode } from '@prisma/client';
import { localPathFromStoragePath } from '../../src/lib/storage';
import type { AuthSession } from '../../src/lib/auth';
import { prepareServiceCatalogV2 } from '../../src/lib/service-catalog-v2-persistence';
import { proposePracticeOfferRevision, createPracticeReadiness, formalizePractice, recordPracticeFunding, confirmPracticeFunding,
  linkPracticeClientService, decidePracticeMaterial, attestPracticeMaterialsComplete, startPractice } from '../../src/lib/practice-readiness';
import { buildInitialServiceTemplate, INITIAL_SERVICES, type InitialServiceCode } from '../../src/lib/initial-service-contract';
import { createEngagementDossier } from '../../src/lib/engagement-dossier';

export async function syntheticUser(db: PrismaClient, role: RoleCode, name: string, passwordHash = 'unusable-synthetic-hash'): Promise<AuthSession> {
  const row = await db.user.create({ data: { name, email: 'm5-' + randomUUID() + '@invalid.test', role, passwordHash } });
  const session = await db.internalSession.create({ data: { userId: row.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 3600_000) } });
  return { userId: row.id, sessionId: session.id, expiresAt: Math.floor(session.expiresAt.getTime()/1000), role, active: true, permissionOverrides: [] };
}
export function syntheticTemplate(code: InitialServiceCode, revision = 1) {
  return { clientName: 'Cliente sintetico M5', date: '2026-09-27', revision,
    sections: Object.fromEntries(INITIAL_SERVICES[code].sections.map(section => [section, 'Risultato sintetico completo del solo servizio acquistato. Nessuna attività reale o consulenza finanziaria.'])),
    sources: [{ title: 'Fonte sintetica del collaudo', reference: 'SYNTHETIC_SOURCE', verifiedAt: '2026-09-27', limitation: 'Nessun requisito di una misura reale è attestato.' }],
    limits: 'Caso sintetico per verificare il percorso; non è un elaborato per un cliente reale.',
    nextStep: 'Il risultato è autonomo. Eventuali servizi successivi sono opzionali.' };
}
export async function syntheticCase(db: PrismaClient, code: InitialServiceCode, actors: { operator: AuthSession; admin: AuthSession; human1: AuthSession; human2: AuthSession }) {
  await prepareServiceCatalogV2(db);
  const catalogRevision = await db.serviceCatalogRevision.findFirstOrThrow({ where: { serviceCatalog: { code }, status: 'PUBLISHED' }, orderBy: { version: 'desc' } });
  const taxable = catalogRevision.netPrice ?? new Prisma.Decimal(100), vat = taxable.mul(catalogRevision.vatRateBps).div(10000).toDecimalPlaces(2), total = taxable.add(vat);
  const client = await db.client.create({ data: { type: 'persona_fisica', displayName: 'Cliente sintetico M5', consultantId: actors.operator.userId } });
  for (const userId of [actors.human1.userId, actors.human2.userId]) await db.clientReadGrant.create({ data: { userId, clientId: client.id, active: true, createdById: actors.admin.userId, updatedById: actors.admin.userId } });
  const project = await db.project.create({ data: { clientId: client.id, title: 'Caso sintetico ' + code, consultantId: actors.operator.userId } });
  const lead = await db.lead.create({ data: { firstName: 'Test', lastName: 'M5', clientId: client.id, assignedToId: actors.operator.userId } });
  const intake = await db.controlledIntake.create({ data: { channel: 'EMAIL', sourceId: randomUUID(), sourceOccurredAt: new Date(),
    acquisitionMode: 'MANUAL_CONTROLLED', mappingVersion: 'm5-synthetic-v1', payloadHash: randomBytes(32).toString('hex'), leadId: lead.id,
    subjectType: 'PERSONA', firstName: 'Test', lastName: 'M5', classificationState: 'VERIFIED', effectiveCategory: 'consulenza',
    need: 'Verifica sintetica del servizio iniziale', operatorId: actors.operator.userId } });
  const offer = await db.commercialOffer.create({ data: { leadId: lead.id, clientId: client.id, title: 'Offerta sintetica M5',
    taxableAmount: taxable, vatAmount: vat, totalAmount: total, status: 'accettata', acceptedAt: new Date(),
    validUntil: new Date(Date.now()+86400_000), createdById: actors.operator.userId } });
  const bytes = Buffer.from('Synthetic M5 evidence ' + code), checksum = createHash('sha256').update(bytes).digest('hex'), storagePath = 'synthetic/m5/' + randomUUID() + '.txt';
  const path = localPathFromStoragePath(storagePath); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  const document = await db.document.create({ data: { clientId: client.id, projectId: project.id, type: 'documento_operativo', title: 'Evidenza sintetica M5',
    fileName: 'synthetic-m5.txt', mimeType: 'text/plain', sizeBytes: bytes.length, storagePath, checksum, uploadedById: actors.operator.userId, status: 'verificato' } });
  const documentVersion = await db.documentVersion.create({ data: { documentId: document.id, version: 1, checksum, storagePath } });
  const contract = await db.contract.create({ data: { clientId: client.id, projectId: project.id, contractNumber: 'M5-' + randomUUID(),
    serviceName: code, taxableAmount: taxable, vatAmount: vat, totalAmount: total, status: 'firmato', signedAt: new Date(), signedDocumentId: document.id } });
  const checklist = await db.documentChecklistItem.create({ data: { clientId: client.id, projectId: project.id, documentId: document.id, title: 'Materiale iniziale M5', createdById: actors.operator.userId } });
  const service = await db.clientService.create({ data: { clientId: client.id, projectId: project.id, serviceCatalogId: catalogRevision.serviceCatalogId,
    contractId: contract.id, assignedToId: actors.operator.userId, status: 'richiesto', operationalStatus: 'nuova' } });
  const offerRevision = await proposePracticeOfferRevision(db, actors.operator, { controlledIntakeId: intake.id, commercialOfferId: offer.id,
    serviceRevisionId: catalogRevision.id, clientId: client.id, projectId: project.id, scope: 'Servizio sintetico con risultato autonomo',
    startupConditions: 'Incarico, pagamento e materiale documentati', requiredInitialAmount: total.toFixed(2), expectedOfferUpdatedAt: offer.updatedAt });
  const practice = await createPracticeReadiness(db, actors.operator, { offerRevisionId: offerRevision.id });
  const version = async () => (await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } })).version;
  const funding = await recordPracticeFunding(db, actors.operator, { practiceId: practice.id, expectedVersion: await version(), reference: 'SYNTHETIC_M5_PAYMENT', amount: total.toFixed(2), currency: 'EUR' });
  await confirmPracticeFunding(db, actors.operator, { practiceId: practice.id, expectedVersion: await version(), evidenceId: funding.id });
  await decidePracticeMaterial(db, actors.operator, { practiceId: practice.id, expectedVersion: await version(), checklistItemId: checklist.id,
    documentId: document.id, documentVersionId: documentVersion.id, status: 'VALIDATED' });
  await formalizePractice(db, actors.operator, { practiceId: practice.id, expectedVersion: await version(), contractId: contract.id,
    signedDocumentId: document.id, signedDocumentVersionId: documentVersion.id });
  await linkPracticeClientService(db, actors.operator, { practiceId: practice.id, expectedVersion: await version(), clientServiceId: service.id });
  await attestPracticeMaterialsComplete(db, actors.operator, { practiceId: practice.id, expectedVersion: await version(), emptyChecklistReason: '' });
  await startPractice(db, actors.operator, { practiceId: practice.id, expectedVersion: await version() });
  const preAnalysis = await db.preAnalysis.create({ data: { clientId: client.id, projectId: project.id, internalSummary: 'Preanalisi sintetica M5' } });
  const dossier = await createEngagementDossier(db, actors.operator, { practiceReadinessId: practice.id, preAnalysisId: preAnalysis.id,
    title: INITIAL_SERVICES[code].title, content: buildInitialServiceTemplate(code, syntheticTemplate(code)) });
  return { code, actors, client, project, service, practice, document, documentVersion, bytes, ...dossier };
}
