import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import type { UpdateCredentials } from './record-updates';
import { canonicalSha256 as hash } from './canonical-json';
import { withSerializableTransaction } from './serializable';
import { admitOperationalDocumentInTransaction } from './operational-documents';
import { attestedProformaReceipts, OperationalDocumentError } from './operational-document-contract';
import { renderOperationalProformaPdf } from './operational-document-pdf';
import { assertFinancialDriveFolderInTransaction, readDriveFolderInTransaction } from './drive-folder-library';
import { parseDriveVideoLink as parseDriveFileLink } from './drive-video-contract';
import { savePrivateDocumentFile } from './storage';
import { communicationFileDerivedCommand as derivedId } from './communication-file-journal';
import { admitAdminDraftTarget, readPracticeCommunications, saveApprovedMessageDraftInTransaction } from './approved-communications';
import { communicationDeliveryLabel } from './ordinary-email-receipt';

type Tx = Prisma.TransactionClient;
const model = 'OperationalDocumentDelivery', uuid = z.string().uuid(), sha = z.string().regex(/^[a-f0-9]{64}$/);
const email = z.object({ messageId: uuid, attachmentId: uuid, attachmentVersionId: uuid, snapshotHash: sha,
  fingerprint: sha, pdfSha256: sha, createdAt: z.string().datetime() }).strict();
const archive = z.object({ commandId: uuid, folderId: uuid, fileId: z.string(), url: z.string().url(), pdfSha256: sha,
  evidence: z.string().min(10).max(1000), occurredAt: z.string().datetime(), actorId: z.string(), recordedAt: z.string().datetime() }).strict();
const stateSchema = z.object({ id: uuid, documentId: uuid, contentHash: sha, revision: z.number().int().positive(), email: email.nullable(), archives: z.array(archive) }).strict();
type DeliveryState = z.infer<typeof stateSchema>;
const command = z.object({ commandId: uuid, documentId: uuid, contentHash: sha, confirmed: z.literal(true) }).strict();
export const proformaEmailCommand = command.extend({ mailboxId: uuid, to: z.string().email(), subject: z.string().trim().min(3).max(200), body: z.string().trim().min(10).max(12000) });
export const proformaArchiveCommand = command.extend({ folderId: uuid, fileUrl: z.string().max(2048), pdfSha256: sha,
  evidence: z.string().trim().min(10).max(1000), occurredAt: z.string().datetime(), folderMembershipConfirmed: z.literal(true), accessConfirmed: z.literal(true) });
const plain = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
function deny(): never { throw new OperationalDocumentError('DENIED'); }
async function load(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'operational-document-delivery:' + id},0))::text`;
  const rows = await tx.adminRecordRevision.findMany({ where: { model, recordId: id } });
  const history = rows.map(row => ({ row, state: stateSchema.parse(row.after) })).sort((a,b) => a.state.revision - b.state.revision);
  let current: DeliveryState | null = null;
  for (const item of history) {
    if (item.state.id !== id || item.state.documentId !== id || item.state.revision !== (current?.revision ?? 0) + 1 || item.row.beforeHash !== hash(current)
      || hash(item.row.before) !== hash(current) || item.row.afterHash !== hash(item.state)) deny();
    current = item.state;
  }
  return current;
}
async function record(tx: Tx, actor: { id: string }, sessionId: string, input: { commandId: string; documentId: string }, before: DeliveryState | null, after: DeliveryState) {
  const beforeHash = hash(before), afterHash = hash(after), operation = before ? 'UPDATE' : 'CREATE';
  await tx.adminRecordRevision.create({ data: { commandId: input.commandId, model, recordId: input.documentId, actorId: actor.id, sessionId,
    operation, requestHash: hash(input), beforeHash, afterHash, before: before ? plain(before) : Prisma.JsonNull, after: plain(after), reason: 'Proforma · preparazione invio o evidenza archivio' } });
  await tx.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: actor.id, entityType: model, entityId: input.documentId,
    event: 'admin_record_changed', after: { commandId: input.commandId, action: operation, beforeHash, afterHash } } });
}
function pdf(row: { id: string; content: string }) {
  const bytes = renderOperationalProformaPdf(row);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function confirmedProforma(tx: Tx, claimed: AuthSession, input: z.infer<typeof command>, proof: UpdateCredentials) {
  const data = await admitOperationalDocumentInTransaction(tx, claimed, input.documentId, true, proof);
  if (data.row.kind !== 'PROFORMA' || !data.clientId || data.row.contentHash !== input.contentHash) deny();
  const confirmation = await tx.operationalDocumentDecision.findUnique({ where: { documentId: data.row.id } });
  if (!confirmation || confirmation.contentHash !== data.row.contentHash) throw new OperationalDocumentError('UNCONFIRMED');
  return { ...data, clientId: data.clientId };
}
/** Prepare exactly one native draft and immutable generated PDF. No approval, provider call or send. */
export async function prepareOperationalProformaEmail(db: PrismaClient, claimed: AuthSession, raw: unknown, proof: UpdateCredentials) {
  const input = proformaEmailCommand.parse(raw), fingerprint = hash({ ...input, commandId: null });
  return withSerializableTransaction(db, async tx => {
    const { auth, row, clientId } = await confirmedProforma(tx, claimed, input, proof), previous = await load(tx, row.id);
    if (previous?.email) {
      if (previous.email.fingerprint !== fingerprint) throw new OperationalDocumentError('STALE');
      await auth.finish(); return { id: row.id, messageId: previous.email.messageId, replay: true };
    }
    await admitAdminDraftTarget(tx, claimed, { kind: 'CLIENT', id: clientId });
    const artifact = pdf(row), attachmentId = derivedId('proforma-pdf-document', row.id + row.contentHash);
    const attachmentVersionId = derivedId('proforma-pdf-version', row.id + row.contentHash), messageId = derivedId('proforma-email', row.id + row.contentHash);
    const saved = await savePrivateDocumentFile({ file: new File([new Uint8Array(artifact.bytes)], 'proforma.pdf', { type: 'application/pdf' }),
      fileName: 'proforma-' + row.id + '.pdf', clientId, storageToken: hash({ documentId: row.id, contentHash: row.contentHash }) });
    if (saved.checksum !== artifact.sha256) deny();
    await tx.document.create({ data: { id: attachmentId, clientId, type: 'application/pdf', title: 'Proforma per approvazione invio',
      fileName: 'proforma-' + row.id + '.pdf', mimeType: 'application/pdf', documentCategory: 'fattura', containsSensitiveData: true,
      uploadedById: auth.actor.id, ...saved } });
    await tx.documentVersion.create({ data: { id: attachmentVersionId, documentId: attachmentId, version: 1, storagePath: saved.storagePath, checksum: saved.checksum } });
    const mailbox = await tx.communicationMailbox.findUnique({ where: { id: input.mailboxId } });
    if (!mailbox) deny();
    const draft = await saveApprovedMessageDraftInTransaction(tx, claimed, { messageId, expectedRevision: 0,
      context: { kind: 'CLIENT', id: clientId }, mailboxId: mailbox.id, replyTo: mailbox.address, to: [input.to], cc: [], bcc: [],
      subject: input.subject, body: input.body, attachmentVersionIds: [attachmentVersionId], classification: 'SENSITIVE' });
    const state = stateSchema.parse({ id: row.id, documentId: row.id, contentHash: row.contentHash, revision: (previous?.revision ?? 0) + 1,
      email: { messageId, attachmentId, attachmentVersionId, snapshotHash: draft.snapshotHash, fingerprint, pdfSha256: artifact.sha256, createdAt: (await auth.finish()).toISOString() }, archives: previous?.archives ?? [] });
    await record(tx, auth.actor, auth.registry.id, input, previous, state); await auth.finish();
    return { id: row.id, messageId, replay: false };
  });
}
/** Operator attestation of an existing Drive file; never uploads or asserts provider verification. */
export async function recordOperationalProformaArchive(db: PrismaClient, claimed: AuthSession, raw: unknown, proof: UpdateCredentials) {
  const input = proformaArchiveCommand.parse(raw), file = parseDriveFileLink(input.fileUrl);
  return withSerializableTransaction(db, async tx => {
    const { auth, row, clientId } = await confirmedProforma(tx, claimed, input, proof), previous = await load(tx, row.id), artifact = pdf(row);
    if (artifact.sha256 !== input.pdfSha256 || new Date(input.occurredAt) > await auth.finish()) throw new OperationalDocumentError('STALE');
    const folder = await readDriveFolderInTransaction(tx, claimed, input.folderId, true);
    if (folder.state !== 'ACTIVE' || folder.clientId !== clientId) deny();
    await assertFinancialDriveFolderInTransaction(tx, folder.id);
    const replay = previous?.archives.find(item => item.fileId === file.fileId && item.pdfSha256 === artifact.sha256);
    if (replay) { await auth.finish(); return { id: row.id, replay: true }; }
    const state = stateSchema.parse({ id: row.id, documentId: row.id, contentHash: row.contentHash, revision: (previous?.revision ?? 0) + 1,
      email: previous?.email ?? null, archives: [...(previous?.archives ?? []), { commandId: input.commandId, folderId: folder.id, fileId: file.fileId,
        url: file.viewUrl, pdfSha256: artifact.sha256, evidence: input.evidence, occurredAt: input.occurredAt, actorId: auth.actor.id, recordedAt: (await auth.finish()).toISOString() }] });
    await record(tx, auth.actor, auth.registry.id, input, previous, state); await auth.finish();
    return { id: row.id, replay: false };
  });
}
export async function readOperationalDocumentDelivery(db: PrismaClient, claimed: AuthSession, documentId: string) {
  const data = await withSerializableTransaction(db, async tx => {
    const { auth, row, clientId } = await admitOperationalDocumentInTransaction(tx, claimed, documentId), state = await load(tx, row.id);
    const archives = [];
    for (const item of state?.archives ?? []) {
      try { const folder = await readDriveFolderInTransaction(tx, claimed, item.folderId, auth.actor.role === 'admin');
        if (folder.state === 'ACTIVE' && folder.clientId === clientId) archives.push(item);
      } catch { /* A withdrawn folder reference never leaks its file URL. */ }
    }
    const mailboxes = auth.actor.role === 'admin' ? await tx.communicationMailbox.findMany({ select: { id: true, address: true }, orderBy: { address: 'asc' } }) : [];
    await auth.finish(); return { state, archives, mailboxes, clientId, isAdmin: auth.actor.role === 'admin', pdfSha256: pdf(row).sha256 };
  });
  let native: null | { state: string; label: string; attempts: { state: string; createdAt: string }[]; receipts: { outcome: string | null; recordedAt: string | null }[] } = null;
  if (data.isAdmin && data.state?.email && data.clientId) {
    try {
      const detail = await readPracticeCommunications(db, claimed, { kind: 'CLIENT', id: data.clientId }, 1, data.state.email.messageId);
      const message = detail.messages.find(row => row.id === data.state!.email!.messageId && row.snapshotHash === data.state!.email!.snapshotHash);
      if (message) native = { state: message.state, label: communicationDeliveryLabel(message.state, message.currentRevision, message.ordinaryReceipts, message.attempts), attempts: message.attempts.map(item => ({ state: item.state, createdAt: item.createdAt.toISOString() })),
        receipts: attestedProformaReceipts(message.currentRevision, message.ordinaryReceipts) };
    } catch { /* Native message/attachment admission remains authoritative. */ }
  }
  return { archives: data.archives, mailboxes: data.mailboxes, pdfSha256: data.pdfSha256, isAdmin: data.isAdmin,
    email: data.state?.email ? { messageId: data.state.email.messageId, createdAt: data.state.email.createdAt, native } : null };
}
