import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, type RoleCode, type Document, type DocumentVersion } from '@prisma/client';
import { createInternalSession } from '../../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';
import type { AuthSession } from '../../src/lib/auth';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { saveApprovedMessageDraft } from '../../src/lib/approved-communications';
import { canonicalSha256 } from '../../src/lib/canonical-json';
import { handoffReceipt } from '../../src/lib/purchased-service-handoff';

export async function syntheticPerson(db: PrismaClient, name: string, role: RoleCode = 'admin', passwordHash = 'synthetic-not-for-login') {
  const user = await db.user.create({ data: { name, role, passwordHash, email: `${randomUUID()}@selective.invalid.test` } });
  return { user, ...await syntheticSession(db, user) };
}
export async function syntheticSession(db: PrismaClient, user: { id: string; role: RoleCode }) {
  const token = createRegistrySessionToken(), digest = await digestRegistrySessionToken(token.bytes);
  const row = await db.$transaction(tx => createInternalSession(tx, { userId: user.id, tokenDigest: digest }));
  const session: AuthSession = { userId: user.id, sessionId: row.id, expiresAt: Math.floor(row.expiresAt.getTime() / 1000), role: user.role, active: true, permissionOverrides: [] };
  return { session, token: token.token };
}
export async function syntheticAuthority(db: PrismaClient, passwordHash?: string) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const admin = await syntheticPerson(db, 'Autorità sintetica', 'admin', passwordHash);
  await db.selectiveAccessAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  await db.applicationKeyVersion.create({ data: { purpose: 'PRIVILEGED_STEP_UP', version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION),
    keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!), status: 'ACTIVE', activatedAt: new Date() } });
  return admin;
}
export async function syntheticSharingCase(db: PrismaClient, admin: Awaited<ReturnType<typeof syntheticPerson>>, passwordHash?: string) {
  const reader = await syntheticPerson(db, 'Destinatario sintetico', 'admin', passwordHash);
  const otherAdmin = await syntheticPerson(db, 'Altro amministratore sintetico', 'admin', passwordHash);
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente sintetico condiviso', consultantId: reader.user.id, salesOwnerId: reader.user.id } });
  const project = await db.project.create({ data: { clientId: client.id, consultantId: reader.user.id, title: 'Progetto sintetico selettivo', description: 'DESCRIZIONE_ESCLUSA_SINTETICA', scenarioA: 'NOTA_PRIVATA_ESCLUSA_SINTETICA', totalInvestment: 180000, requestedAmount: 90000 } });
  const otherProject = await db.project.create({ data: { clientId: client.id, title: 'Altro fascicolo invariato', scenarioA: 'ALTRO_FASCICOLO' } });
  const documents: { doc: Document; version: DocumentVersion; bytes: Buffer }[] = [];
  for (let index = 1; index <= 3; index++) {
    const bytes = Buffer.from(`CONTENUTO_SINTETICO_DOCUMENTO_${index}`), checksum = createHash('sha256').update(bytes).digest('hex');
    const doc = await db.document.create({ data: { clientId: client.id, projectId: project.id, title: `Documento sintetico ${index}`, fileName: `sintetico-${index}.txt`,
      type: 'text/plain', mimeType: 'text/plain', documentCategory: 'altro', serviceArea: 'progetto_investimento', sizeBytes: bytes.length, storagePath: `selective/${randomUUID()}.txt`, checksum, uploadedById: admin.user.id } });
    const version = await db.documentVersion.create({ data: { documentId: doc.id, version: 1, storagePath: doc.storagePath, checksum } });
    documents.push({ doc, version, bytes });
  }
  // A financial record can be linked through a service even when its own
  // projectId is null. Its misleadingly classified document stays private.
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: `CONTRATTO_ESCLUSO_${randomUUID()}`,
    serviceName: 'COMPENSO_FAI_ESCLUSO', serviceDescription: 'PERIMETRO_CONTRATTO_ESCLUSO', taxableAmount: 7777, vatAmount: 1710.94, totalAmount: 9487.94,
    notes: 'MARGINE_PRIVATO_ESCLUSO', signedDocumentId: documents[2].doc.id } });
  const payment = await db.payment.create({ data: { contractId: contract.id, clientId: client.id, taxableAmount: 7777,
    vatAmount: 1710.94, totalAmount: 9487.94, method: 'PAGAMENTO_ESCLUSO', notes: 'NOTA_PAGAMENTO_ESCLUSA' } });
  const catalog = await db.serviceCatalog.findFirstOrThrow({ where: { active: true } });
  const catalogRevision = await db.serviceCatalogRevision.findFirstOrThrow({ where: { serviceCatalogId: catalog.id, status: 'PUBLISHED' }, orderBy: { version: 'desc' } });
  const lead = await db.lead.create({ data: { firstName: 'Lead', lastName: 'Sintetico', clientId: client.id, assignedToId: reader.user.id } });
  const intake = await db.controlledIntake.create({ data: { channel: 'EMAIL', sourceId: randomUUID(), sourceOccurredAt: new Date(),
    acquisitionMode: 'MANUAL_CONTROLLED', mappingVersion: 'selective-synthetic-v1', payloadHash: createHash('sha256').update(randomUUID()).digest('hex'),
    leadId: lead.id, subjectType: 'PERSONA', firstName: 'Lead', lastName: 'Sintetico', classificationState: 'VERIFIED',
    effectiveCategory: 'consulenza', need: 'Synthetic offer scope', operatorId: admin.user.id } });
  const offer = await db.commercialOffer.create({ data: { leadId: lead.id, clientId: client.id, title: 'OFFERTA_FAI_ESCLUSA',
    taxableAmount: 100, vatAmount: 22, totalAmount: 122, status: 'inviata', sentAt: new Date(), followUpAt: new Date(),
    validUntil: new Date(Date.now() + 86_400_000), createdById: admin.user.id } });
  await db.practiceOfferRevision.create({ data: { controlledIntakeId: intake.id, commercialOfferId: offer.id, projectId: project.id,
    revision: 1, serviceRevisionId: catalogRevision.id, clientId: client.id, scope: 'Synthetic selected project offer',
    inclusions: [], exclusions: [], deliverables: [], taxableAmount: 100, vatAmount: 22, totalAmount: 122, requiredInitialAmount: 50,
    currency: 'EUR', validUntil: offer.validUntil!, startupConditions: 'Synthetic conditions',
    payloadHash: createHash('sha256').update(randomUUID()).digest('hex'), proposedById: admin.user.id } });
  const service = await db.clientService.create({ data: { clientId: client.id, projectId: project.id, serviceCatalogId: catalog.id,
    contractId: contract.id, paymentId: payment.id, assignedToId: reader.user.id,
    operationalNotes: 'NOTA_SERVIZIO_ESCLUSA', internalNotes: 'MARGINE_SERVIZIO_ESCLUSO' } });
  const task = await db.task.create({ data: { clientId: client.id, projectId: project.id, clientServiceId: service.id,
    title: 'TASK_PROGETTO_ESCLUSO', assignedToId: reader.user.id, createdById: admin.user.id, dueAt: new Date() } });
  const otherService = await db.clientService.create({ data: { clientId: client.id, projectId: otherProject.id, serviceCatalogId: catalog.id,
    contractId: contract.id, assignedToId: reader.user.id, operationalNotes: 'SERVIZIO_B_CONTRATTO_COMUNE' } });
  const otherTask = await db.task.create({ data: { clientId: client.id, projectId: otherProject.id, clientServiceId: otherService.id,
    title: 'TASK_B_CONTRATTO_COMUNE', assignedToId: reader.user.id, createdById: admin.user.id } });
  const otherBytes = Buffer.from('DOCUMENTO_B_CONTRATTO_COMUNE'), otherChecksum = createHash('sha256').update(otherBytes).digest('hex');
  const otherDoc = await db.document.create({ data: { clientId: client.id, projectId: otherProject.id, clientServiceId: otherService.id,
    title: 'Documento tecnico B', fileName: 'progetto-b.txt', type: 'text/plain', mimeType: 'text/plain', documentCategory: 'altro',
    serviceArea: 'progetto_investimento', sizeBytes: otherBytes.length, storagePath: `selective/${randomUUID()}.txt`, checksum: otherChecksum, uploadedById: admin.user.id } });
  const otherVersion = await db.documentVersion.create({ data: { documentId: otherDoc.id, version: 1, storagePath: otherDoc.storagePath, checksum: otherChecksum } });
  const otherDocument = { doc: otherDoc, version: otherVersion, bytes: otherBytes };
  const technicalPractice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id, clientServiceId: service.id,
    title: 'Pratica tecnica A', practiceType: 'synthetic', targetEntity: 'synthetic', technicalOwnerId: reader.user.id, createdById: admin.user.id } });
  const otherPractice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: otherProject.id, clientServiceId: otherService.id,
    title: 'Pratica tecnica B', practiceType: 'synthetic', targetEntity: 'synthetic', technicalOwnerId: reader.user.id, createdById: admin.user.id } });
  // Historical receipt remains after a contract has become shared. Its
  // financial context must not be exposed through B's still-authorized work.
  const historicalReceipt = handoffReceipt.parse({ type: 'R05_PURCHASED_SERVICE_HANDOFF_V1', version: 1,
    clientId: client.id, projectId: otherProject.id, clientServiceId: otherService.id, technicalPracticeId: otherPractice.id,
    serviceCatalogId: catalog.id, variantCode: 'SYNTHETIC', contractId: contract.id, contractHash: 'a'.repeat(64),
    paymentId: payment.id, paymentHash: 'b'.repeat(64), scopeHash: canonicalSha256(contract.serviceDescription),
    sourceFingerprint: 'c'.repeat(64), fingerprint: 'd'.repeat(64), technicalOwnerId: reader.user.id, departmentCode: 'SYNTHETIC',
    decisionId: 'synthetic-historical-decision', source: ['contract', 'payment'].map(kind => ({ id: documents[2].doc.id,
      documentVersionId: documents[2].version.id, version: 1, checksumHash: documents[2].version.checksum, kind })),
    paths: [otherTask.id], dueAt: new Date().toISOString(), confirmed: true, reason: 'Synthetic historical receipt' });
  await db.auditLog.create({ data: { event: 'purchased_service_handoff', entityType: 'TechnicalPractice', entityId: otherPractice.id,
    actorId: admin.user.id, after: historicalReceipt } });
  const mailbox = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'assistenza@finanzaagevolaimpresa.it' } });
  const messages = [];
  for (const practice of [technicalPractice, otherPractice]) {
    // Real M4 service generates audits with only operation/hash, no project ID.
    messages.push(await saveApprovedMessageDraft(db, admin.session, { messageId: randomUUID(), expectedRevision: 0,
      context: { kind: 'TECHNICAL', id: practice.id }, mailboxId: mailbox.id, replyTo: mailbox.address,
      to: ['recipient@invalid.test'], cc: [], bcc: [], subject: 'Synthetic M4 draft', body: 'Synthetic only, no sending.',
      attachmentVersionIds: [], classification: 'ORDINARY' }));
  }
  // Persisted synthetic incoming reply: exercise the canonical message link,
  // without enabling a mailbox/provider or acquiring any real correspondence.
  const reply = await db.communicationReply.create({ data: { canonicalMailboxId: mailbox.id, externalMessageId: randomUUID(),
    contentHash: createHash('sha256').update('synthetic reply').digest('hex'), sender: 'sender@invalid.test', subject: 'Synthetic',
    body: 'Synthetic only', receivedAt: new Date(), evidenceReference: 'synthetic', messageId: messages[0].id, acquiredById: admin.user.id } });
  await db.auditLog.create({ data: { actorId: admin.user.id, event: 'm4_reply_needs_reconciliation', entityType: 'ApprovedCommunication',
    entityId: reply.id, after: { operation: 'REPLY_NEEDS_RECONCILIATION', evidenceHash: reply.contentHash } } });
  const input = { projectId: project.id, recipientId: reader.user.id, revision: 0, fields: ['title', 'totalInvestment'], documents: documents.slice(0, 2).map((doc, index) => ({ versionId: doc.version.id, download: index === 1 })), expiresAt: null };
  return { admin, reader, otherAdmin, client, project, otherProject, documents, contract, payment, service, task, lead, offer, input,
    otherService, otherTask, otherDocument, technicalPractice, otherPractice, messages, reply };
}
