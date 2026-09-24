import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type Prisma, type PrismaClient } from '@prisma/client';
import { UserFacingActionError } from './action-errors';
import { authorizeManualAssignment, type AssignmentActor } from './manual-assignment-guard';
import { appendResponsibilityDecision, technicalRoles } from './responsibility';
import { canonicalSha256 } from './canonical-json';
import { readPrivateDocument } from './storage';

type Db = Prisma.TransactionClient | PrismaClient;
const id = z.string().min(1).max(128), hash = z.string().regex(/^[a-f0-9]{64}$/);
const deny = (message: string): never => { throw new UserFacingActionError(message); };
export const handoffInput = z.object({
  serviceId: id, expectedHash: hash, technicalOwnerId: id,
  departmentCode: z.string().trim().min(2).max(80), variantCode: z.string().trim().min(2).max(120),
  dueDate: z.string().datetime(), activities: z.array(z.string().trim().min(3).max(180)).min(1).max(20),
  confirmed: z.literal(true), reason: z.string().trim().min(10).max(500),
}).strict();
export type HandoffInput = z.infer<typeof handoffInput>;
export const handoffReceipt = z.object({
  type: z.literal('R05_PURCHASED_SERVICE_HANDOFF_V1'), version: z.literal(1),
  clientId: id, projectId: id.nullable(), clientServiceId: id, technicalPracticeId: id,
  serviceCatalogId: id, variantCode: z.string().min(2).max(120), contractId: id, contractHash: hash,
  paymentId: id, paymentHash: hash, scopeHash: hash, sourceFingerprint: hash, fingerprint: hash,
  technicalOwnerId: id, departmentCode: z.string().min(2).max(80), decisionId: id,
  source: z.array(z.object({ id, documentVersionId: id, version: z.number().int().positive(), checksumHash: hash, kind: z.enum(['contract', 'payment']) }).strict()).length(2),
  paths: z.array(id).min(1).max(20), dueAt: z.string().datetime(), confirmed: z.literal(true), reason: z.string().min(3).max(500),
}).strict();

export async function purchasedServiceContext(db: Db, serviceId: string) {
  const service = await db.clientService.findFirst({ where: { id: serviceId, deletedAt: null } });
  const client = service && await db.client.findFirst({ where: { id: service.clientId, deletedAt: null } });
  const project = service?.projectId ? await db.project.findFirst({ where: { id: service.projectId, clientId: service.clientId, deletedAt: null } }) : null;
  const company = service?.companyId ? await db.company.findFirst({ where: { id: service.companyId, clientId: service.clientId, deletedAt: null } }) : null;
  if (!service || !client || (service.projectId && !project) || (service.companyId && !company)) return deny('Servizio o anagrafica non disponibili.');
  return { service, client, project };
}

export async function getHandoffReceipt(db: Db, serviceId: string) {
  const entries = await db.auditLog.findMany({ where: { event: 'purchased_service_handoff', entityType: 'TechnicalPractice',
    after: { path: ['clientServiceId'], equals: serviceId } }, take: 2 });
  if (entries.length > 1) return deny('Passaggi multipli da verificare con l’amministratore.');
  if (!entries[0]) return null;
  const parsed = handoffReceipt.safeParse(entries[0].after);
  if (!parsed.success || parsed.data.technicalPracticeId !== entries[0].entityId || !entries[0].actorId) return deny('Ricevuta di passaggio non valida.');
  return { ...entries[0], receipt: parsed.data };
}

async function evidence(db: Db, documentId: string | null, context: Awaited<ReturnType<typeof purchasedServiceContext>>, kind: 'contract' | 'payment') {
  const document = documentId && await db.document.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!document || document.clientId !== context.client.id || (document.projectId && document.projectId !== context.service.projectId)
    || (document.clientServiceId && document.clientServiceId !== context.service.id) || document.status !== 'verificato'
    || document.sizeBytes <= 0 || (document.validUntil && document.validUntil.getTime() <= Date.now()) || !document.checksum?.match(/^[a-f0-9]{64}$/)) {
    return deny(kind === 'contract' ? 'Manca un incarico firmato con documento verificato e coerente con il servizio.' : 'Manca una prova di pagamento verificata e coerente con il servizio.');
  }
  const version = await db.documentVersion.findFirst({ where: { documentId: document.id }, orderBy: [{ version: 'desc' }, { id: 'desc' }] });
  if (!version || version.storagePath !== document.storagePath || version.checksum !== document.checksum) return deny('Versione del documento da verificare prima del passaggio.');
  return { document, version, binding: { id: document.id, documentVersionId: version.id, version: version.version, checksumHash: document.checksum, kind } };
}

// This is a handoff of an existing purchase. It never creates an offer, contract, payment, client or readiness authorization.
export async function previewPurchasedServiceHandoff(db: Db, serviceId: string) {
  const context = await purchasedServiceContext(db, serviceId), { service } = context;
  if (['sospeso', 'chiuso', 'archiviato', 'consegnato'].includes(service.status)) return deny('Il servizio non è aperto per un nuovo passaggio.');
  const contract = service.contractId ? await db.contract.findUnique({ where: { id: service.contractId } }) : null;
  const payment = service.paymentId ? await db.payment.findUnique({ where: { id: service.paymentId } }) : null;
  const catalog = await db.serviceCatalog.findUnique({ where: { id: service.serviceCatalogId } });
  if (!catalog || !contract || contract.clientId !== service.clientId || contract.projectId !== service.projectId || contract.status !== 'firmato'
    || !contract.signedAt || contract.signedAt.getTime() > Date.now() || !contract.serviceDescription?.trim()) return deny('Collega l’incarico firmato, con perimetro del servizio descritto.');
  if (!payment || payment.clientId !== service.clientId || payment.contractId !== contract.id || payment.status !== 'incassato'
    || !payment.collectedAt || payment.collectedAt.getTime() > Date.now() || !payment.totalAmount.gt(0) || !contract.totalAmount.gte(payment.totalAmount)
    || !['incassato', 'parziale'].includes(service.paymentStatus)) return deny('Collega una rata incassata con prova: lo stato del solo servizio non dimostra il pagamento.');
  const documents = [await evidence(db, contract.signedDocumentId, context, 'contract'), await evidence(db, payment.accountingDocumentId, context, 'payment')];
  if (documents[0].document.id === documents[1].document.id) return deny('Incarico firmato e prova di pagamento devono essere documenti distinti.');
  const practices = await db.technicalPractice.findMany({ where: { clientServiceId: serviceId, deletedAt: null }, take: 2 });
  if (practices.length > 1) return deny('Esistono più pratiche per il servizio: l’amministratore deve riconciliare i collegamenti prima del passaggio.');
  const practice = practices[0] ?? null;
  if (practice && (practice.clientId !== service.clientId || practice.projectId !== service.projectId || ['archiviata', 'approvata', 'respinta'].includes(practice.status))) return deny('La pratica già collegata non è disponibile per il passaggio.');
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  const contractHash = canonicalSha256(plain(contract)), paymentHash = canonicalSha256(plain(payment));
  const expectedHash = canonicalSha256({ service: plain(service), practice: plain(practice), contractHash, paymentHash,
    documents: documents.map(item => ({ binding: item.binding, updatedAt: item.document.updatedAt.toISOString() })) });
  return { ...context, catalog, contract, payment, documents, practice, contractHash, paymentHash, expectedHash };
}

export async function handoffPurchasedService(tx: Prisma.TransactionClient, actor: AssignmentActor, raw: HandoffInput, admitted: boolean) {
  const input = handoffInput.parse(raw);
  if (!admitted) return deny('Conferma amministrativa richiesta.');
  await authorizeManualAssignment(tx, actor, [{ userId: input.technicalOwnerId, roles: technicalRoles }]);
  await tx.$queryRaw`SELECT "id" FROM "ClientService" WHERE "id"=${input.serviceId} FOR UPDATE`;
  const fingerprint = canonicalSha256(input), existing = await getHandoffReceipt(tx, input.serviceId);
  if (existing) {
    if (existing.receipt.fingerprint !== fingerprint) return deny('Passaggio già registrato. Usa la scheda responsabilità per una riassegnazione.');
    return existing; // An HTTP retry never reapplies assignments, recreates tasks or overwrites subsequent work.
  }
  const preview = await previewPurchasedServiceHandoff(tx, input.serviceId);
  if (preview.expectedHash !== input.expectedHash) return deny('Incarico, pagamento o servizio cambiati. Riapri e verifica il riepilogo.');
  if (new Set(input.activities).size !== input.activities.length) return deny('Elimina le attività duplicate prima del passaggio.');
  for (const item of preview.documents) {
    let bytes: Buffer;
    try { bytes = await readPrivateDocument(item.document.storagePath); } catch { return deny('Un file di prova non è disponibile nello storage privato.'); }
    if (bytes.length !== item.document.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== item.binding.checksumHash) return deny('Il file di prova non corrisponde alla versione verificata.');
  }
  const practice = preview.practice
    ? await tx.technicalPractice.update({ where: { id: preview.practice.id }, data: { technicalOwnerId: input.technicalOwnerId } })
    : await tx.technicalPractice.create({ data: { clientId: preview.client.id, projectId: preview.service.projectId, clientServiceId: input.serviceId,
      title: preview.catalog.name, practiceType: input.variantCode, targetEntity: 'Lavorazione interna FAI', dueDate: new Date(input.dueDate),
      technicalOwnerId: input.technicalOwnerId, createdById: actor.userId } });
  await tx.clientService.update({ where: { id: input.serviceId }, data: { assignedToId: input.technicalOwnerId } });
  const decision = await appendResponsibilityDecision(tx, { kind: 'TechnicalPractice', id: practice.id, actorId: actor.userId, allowed: true,
    state: { clientId: practice.clientId, projectId: practice.projectId, clientServiceId: practice.clientServiceId,
      commercialOwnerId: practice.commercialOwnerId, technicalOwnerId: practice.technicalOwnerId }, departmentCode: input.departmentCode, reason: input.reason });
  const taskIds: string[] = [];
  for (const title of input.activities) {
    const task = await tx.task.create({ data: { title, type: 'M1_SERVICE_HANDOFF', clientId: preview.client.id, companyId: preview.service.companyId,
      projectId: preview.service.projectId, clientServiceId: input.serviceId, dueAt: new Date(input.dueDate), createdById: actor.userId } });
    taskIds.push(task.id); // Service-scoped work: no second assignee survives a future technical reassignment.
  }
  const after = handoffReceipt.parse({ type: 'R05_PURCHASED_SERVICE_HANDOFF_V1', version: 1, clientId: preview.client.id,
    projectId: preview.service.projectId, clientServiceId: input.serviceId, technicalPracticeId: practice.id, serviceCatalogId: preview.catalog.id,
    variantCode: input.variantCode, contractId: preview.contract.id, contractHash: preview.contractHash, paymentId: preview.payment.id,
    paymentHash: preview.paymentHash, scopeHash: canonicalSha256(preview.contract.serviceDescription), sourceFingerprint: input.expectedHash,
    fingerprint, technicalOwnerId: input.technicalOwnerId, departmentCode: input.departmentCode, decisionId: decision.id,
    source: preview.documents.map(item => item.binding), paths: taskIds, dueAt: input.dueDate, confirmed: true, reason: input.reason });
  const entry = await tx.auditLog.create({ data: { event: 'purchased_service_handoff', entityType: 'TechnicalPractice', entityId: practice.id, actorId: actor.userId, after } });
  const receipt = handoffReceipt.parse(entry.after); // Fail the whole transaction if the shared DB sanitizer drops structural evidence.
  if (receipt.variantCode !== input.variantCode || receipt.departmentCode !== input.departmentCode) return deny('Usa una denominazione di variante e reparto senza dati personali.');
  return { ...entry, receipt };
}
