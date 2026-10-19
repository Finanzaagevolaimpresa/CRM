import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewClient, canViewDocument, canViewProject } from './access-control';
import { canonicalSha256 } from './canonical-json';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { guardProjectResources } from './project-resource-guard';
import { ProjectUnavailableError } from './project-lifecycle-lock';
import { withSerializableTransaction } from './serializable';
import { readPrivateDocumentBounded } from './storage';
import { paymentCollectionCommand, PaymentCollectionError,
  type PaymentCollectionCommand, type PaymentCollectionPreview } from './payment-collection-contract';

type Tx = Prisma.TransactionClient;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const EVENT = 'payment_collection_v1';
const receiptSchema = z.object({ type: z.literal('PAYMENT_COLLECTION_V1'), action: z.literal('DECLARE_COLLECTION'),
  clientId: z.string().min(1), paymentId: z.string().min(1), documentVersionId: z.string().min(1),
  sourceHash: hash, sessionHash: hash, beforeHash: hash, afterHash: hash,
}).strict();
const fingerprint = (value: unknown) => canonicalSha256(JSON.parse(JSON.stringify(value)));
function fail(code: PaymentCollectionError['code']): never { throw new PaymentCollectionError(code); }

async function context(tx: Tx, claimed: AuthSession, clientId: string, paymentId: string,
  options: { write?: boolean; proof?: UpdateCredentials } = {}) {
  const auth = await updateActor(tx, claimed, options.proof);
  if (auth.actor.role !== 'admin' || !(['client.read', 'contract.read', 'payment.read', 'payment.write', 'document.download'] as const)
    .every(permission => recordUpdatePermission(auth.actor, permission))) fail('DENIED');
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Client" WHERE id=${clientId} ${Prisma.raw(options.write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const client = await tx.client.findUnique({ where: { id: clientId } });
  if (!client || client.deletedAt || ['archiviato', 'sospeso'].includes(client.status) || !canViewClient(auth.actor, client)) fail('DENIED');
  const initial = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!initial || initial.clientId !== clientId) fail('DENIED');
  await tx.$queryRaw`SELECT id FROM "Contract" WHERE id=${initial.contractId} FOR SHARE`;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Payment" WHERE id=${paymentId} ${Prisma.raw(options.write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const contract = await tx.contract.findUnique({ where: { id: initial.contractId } });
  if (!contract || payment.clientId !== client.id || payment.contractId !== contract.id || contract.clientId !== client.id) fail('DENIED');
  const project = contract.projectId ? await tx.project.findUnique({ where: { id: contract.projectId } }) : null;
  if (contract.projectId && (!project || project.clientId !== client.id || project.deletedAt || project.status === 'archiviato'
    || !canViewProject(auth.actor, { ...project, client }))) fail('DENIED');
  await guardProjectResources(tx, auth.actor.id, [{ clientId, projectId: contract.projectId, contractId: contract.id }]);
  await auth.finish();
  return { ...auth, client, payment, contract, project };
}
type Context = Awaited<ReturnType<typeof context>>;
async function openForCollection(tx: Tx, c: Context) {
  return c.payment.status === 'da_incassare' && !c.payment.collectedAt && !c.payment.accountingDocumentId
    && c.contract.status === 'firmato' && Boolean(c.contract.signedAt && c.contract.signedAt <= new Date())
    && c.payment.totalAmount.gt(0) && c.payment.totalAmount.lte(c.contract.totalAmount)
    && await tx.clientService.count({ where: { paymentId: c.payment.id } }) === 0;
}
async function evidence(tx: Tx, c: Context, versionId: string, verifyBytes: boolean) {
  const initial = await tx.documentVersion.findUnique({ where: { id: versionId } });
  if (!initial) fail('DOCUMENT');
  await guardProjectResources(tx, c.actor.id, [{ documentId: initial.documentId }]);
  await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${initial.documentId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "DocumentVersion" WHERE id=${versionId} FOR SHARE`;
  const document = await tx.document.findUnique({ where: { id: initial.documentId } });
  const version = await tx.documentVersion.findUnique({ where: { id: versionId } });
  const latest = await tx.documentVersion.findFirst({ where: { documentId: initial.documentId }, orderBy: [{ version: 'desc' }, { id: 'desc' }] });
  if (!document || !version || latest?.id !== version.id || document.deletedAt || document.clientId !== c.client.id
    || document.id === c.contract.signedDocumentId || document.status !== 'verificato'
    || (document.projectId && document.projectId !== c.contract.projectId)
    || (document.validUntil && document.validUntil <= new Date()) || document.sizeBytes < 1 || document.sizeBytes > 50 * 1024 * 1024
    || !document.checksum?.match(/^[a-f0-9]{64}$/) || version.checksum !== document.checksum || version.storagePath !== document.storagePath) fail('DOCUMENT');
  const service = document.clientServiceId ? await tx.clientService.findUnique({ where: { id: document.clientServiceId } }) : null;
  if (document.clientServiceId && (!service || service.deletedAt || service.clientId !== c.client.id
    || service.contractId !== c.contract.id || service.projectId !== c.contract.projectId
    || service.paymentId || service.status !== 'richiesto' || service.operationalStatus !== 'nuova')) fail('DOCUMENT');
  const linkedService = service ? { ...service, client: c.client, project: c.project } : null;
  if (!canViewDocument(c.actor, { ...document, client: c.client,
    project: document.projectId ? { ...c.project!, client: c.client } : null, clientService: linkedService },
    recordUpdatePermission(c.actor, 'document.sensitive.read'))) fail('DENIED');
  if (verifyBytes) {
    let bytes: Buffer;
    try { bytes = await readPrivateDocumentBounded(document.storagePath, 50 * 1024 * 1024); }
    catch { fail('DOCUMENT'); }
    if (bytes.length !== document.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== document.checksum) fail('DOCUMENT');
  }
  return { document, version, service };
}
async function proposal(tx: Tx, c: Context, input: PaymentCollectionCommand) {
  if (!await openForCollection(tx, c)) fail('CLOSED');
  const now = await c.finish(), collectedAt = new Date(input.collectedAt);
  if (!Number.isFinite(collectedAt.getTime()) || collectedAt > now) fail('INVALID');
  const proof = await evidence(tx, c, input.documentVersionId, true);
  const digest = fingerprint({ input, actorId: c.actor.id, sessionId: c.registry.id,
    client: c.client, contract: c.contract, payment: c.payment, project: c.project, ...proof });
  await c.finish();
  const preview: PaymentCollectionPreview = { digest, client: c.client.displayName, contract: c.contract.contractNumber,
    amount: c.payment.totalAmount.toFixed(2), collectedAt: input.collectedAt, document: proof.document.title,
    documentVersion: proof.version.version, project: c.project?.title ?? null };
  return { preview, proof, collectedAt };
}
async function receipt(tx: Tx, c: Context, commandId: string, input?: PaymentCollectionCommand) {
  const row = await tx.auditLog.findUnique({ where: { id: 'payment_collection_' + commandId } });
  if (!row) return null;
  const parsed = receiptSchema.safeParse(row.after);
  if (!parsed.success || row.event !== EVENT || row.entityType !== 'Payment' || row.entityId !== c.payment.id
    || row.actorId !== c.actor.id || parsed.data.clientId !== c.client.id || parsed.data.paymentId !== c.payment.id
    || (input && (parsed.data.sourceHash !== fingerprint(input) || parsed.data.sessionHash !== fingerprint(c.registry.id)))) fail('DENIED');
  await c.finish();
  return { paymentId: c.payment.id, clientId: c.client.id };
}
export async function previewPaymentCollection(db: PrismaClient, actor: AuthSession, raw: unknown) {
  const input = paymentCollectionCommand.parse(raw);
  return withSerializableTransaction(db, async tx => (await proposal(tx, await context(tx, actor, input.clientId, input.paymentId), input)).preview);
}
export async function confirmPaymentCollection(db: PrismaClient, actor: AuthSession, raw: unknown, digest: string, credentials: UpdateCredentials) {
  const input = paymentCollectionCommand.parse(raw); hash.parse(digest);
  if (!credentials) fail('DENIED');
  return withSerializableTransaction(db, async tx => {
    const c = await context(tx, actor, input.clientId, input.paymentId, { write: true, proof: credentials });
    const prior = await receipt(tx, c, input.commandId, input);
    if (prior) return prior;
    const current = await proposal(tx, c, input);
    if (current.preview.digest !== digest) fail('STALE');
    const updated = await tx.payment.update({ where: { id: c.payment.id }, data: { status: 'incassato',
      collectedAt: current.collectedAt, accountingDocumentId: current.proof.document.id } });
    const after = receiptSchema.parse({ type: 'PAYMENT_COLLECTION_V1', action: 'DECLARE_COLLECTION', clientId: c.client.id,
      paymentId: c.payment.id, documentVersionId: current.proof.version.id, sourceHash: fingerprint(input),
      sessionHash: fingerprint(c.registry.id), beforeHash: fingerprint(c.payment), afterHash: fingerprint(updated) });
    const recorded = await tx.auditLog.create({ data: { id: 'payment_collection_' + input.commandId, actorId: c.actor.id,
      entityType: 'Payment', entityId: c.payment.id, event: EVENT, after } });
    if (fingerprint(receiptSchema.parse(recorded.after)) !== fingerprint(after)) fail('INVALID');
    // A receipt reader waiting on this client must not use a snapshot from before
    // the commit to report a false absence. This fence changes atomically.
    await tx.client.update({ where: { id: c.client.id }, data: { recordUpdateEpoch: { increment: 1 } } });
    await c.finish();
    return { paymentId: c.payment.id, clientId: c.client.id };
  });
}
export async function readPaymentCollectionReceipt(db: PrismaClient, actor: AuthSession, clientId: string, paymentId: string, commandId: string) {
  z.string().uuid().parse(commandId);
  return withSerializableTransaction(db, async tx => receipt(tx, await context(tx, actor, clientId, paymentId), commandId));
}
export async function paymentCollectionSetup(db: PrismaClient, actor: AuthSession, paymentId: string, query = '') {
  return withSerializableTransaction(db, async tx => {
    const initial = await tx.payment.findUnique({ where: { id: paymentId }, select: { clientId: true } });
    if (!initial) fail('DENIED');
    const c = await context(tx, actor, initial.clientId, paymentId), reconciliationOnly = !await openForCollection(tx, c);
    const documents: Array<{ id: string; title: string; version: number }> = [];
    const candidates = reconciliationOnly ? [] : await tx.document.findMany({ where: { clientId: c.client.id, deletedAt: null,
      status: 'verificato', id: { not: c.contract.signedDocumentId ?? '' }, ...(query.trim() ? { title: { contains: query.trim().slice(0, 80), mode: 'insensitive' } } : {}) },
      select: { id: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 101 });
    for (const candidate of candidates.slice(0, 100)) {
      const version = await tx.documentVersion.findFirst({ where: { documentId: candidate.id }, orderBy: [{ version: 'desc' }, { id: 'desc' }] });
      if (!version) continue;
      try {
        const admitted = await evidence(tx, c, version.id, false);
        documents.push({ id: admitted.version.id, title: admitted.document.title, version: admitted.version.version });
      } catch (error) { if (!(error instanceof PaymentCollectionError) && !(error instanceof ProjectUnavailableError)) throw error; }
    }
    await c.finish();
    return { clientId: c.client.id, paymentId, client: c.client.displayName, contract: c.contract.contractNumber,
      amount: c.payment.totalAmount.toFixed(2), reconciliationOnly, documents, moreDocuments: candidates.length > 100 };
  });
}
