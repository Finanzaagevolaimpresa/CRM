import { selectedDocumentMode } from './selected-document-formats';
import { selectedDocumentResponseMime } from './selected-document-content';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewClient } from './access-control';
import { loadClientReadScope } from './client-read-perimeter';
import { loadActivePrivilegedStepUpKey, lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { privilegedAccessMode } from './application-security-policy';
import { canonicalSha256 } from './canonical-json';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { lockAuthoritativeInternalSession, lockInternalUser, tokenDigestFromCookie } from './internal-session-registry';
import { acquireLeadIdentityWriteLock } from './lead-identity';
import { hasPermission } from './permission-evaluator';
import { verifyPrivilegedStepUpToken, type PrivilegedStepUpKey } from './privileged-step-up-token';
import { internalSessionMode } from './session';
import { withSerializableTransaction } from './serializable';
import { loadSelectiveClientScope } from './selective-client-scope';
import { clientFieldProjection, selectiveClientSelectionSchema, type SelectiveClientSelection, type SelectiveClientScope } from './selective-client-policy';
import { createSelectiveClientPreview, readSelectiveClientPreview } from './selective-client-preview';
import { readSelectiveClientGrant, selectiveClientGrantPayloadSchema, type SelectiveClientGrantPayload } from './selective-client-grant';
import { selectiveClientProof, verifySelectiveClientProof } from './selective-client-proof';
import { selectClientDocuments, listClientDocumentOptions } from './selective-client-documents';
import { maxClientDocumentBytes, maxClientDocuments } from './selective-client-document-policy';
import { selectClientCompanies, listClientCompanyOptions } from './selective-client-companies';
import { maxClientCompanyChoices, selectiveClientCompanyFields } from './selective-client-company-policy';
import { selectClientPeople, listClientPeopleOptions } from './selective-client-people';
import { maxClientPersonChoices, selectiveClientPersonFields } from './selective-client-person-policy';

type Tx = Prisma.TransactionClient;
export type ClientSharingCredentials = { key: PrivilegedStepUpKey; sessionToken: string; stepUpToken: string };
export class ClientSharingError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'UNAVAILABLE') { super(`SELECTIVE_CLIENT_${code}`); }
}
function deny(): never { throw new ClientSharingError('DENIED'); }
function stale(): never { throw new ClientSharingError('STALE'); }
const asJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
async function clock(tx: Tx) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!row) throw new ClientSharingError('UNAVAILABLE');
  return row.now;
}
function allowed(actor: Pick<AuthSession, 'role' | 'active' | 'permissionOverrides'>, write = false) {
  const codes = write ? ['client.read', 'client.write'] as const : ['client.read'] as const;
  return actor.active && codes.every(code => hasPermission(actor, code)
    && !actor.permissionOverrides.some(item => item.permission === code && !item.allowed));
}
async function liveUser(tx: Tx, id: string) {
  const user = await tx.user.findUnique({ where: { id }, include: { permissionOverrides: true } });
  if (!user || !user.active || user.deletedAt) deny();
  return user;
}
async function sessionLive(tx: Tx, current: AuthSession & { registryExpiresAt: Date }) {
  const now = await clock(tx);
  if (!Number.isFinite(current.expiresAt) || current.expiresAt * 1000 <= now.getTime() || current.registryExpiresAt <= now) deny();
  return now;
}
async function personal(tx: Tx, current: AuthSession, proof: ClientSharingCredentials) {
  const now = await clock(tx);
  const session = await tx.internalSession.findUnique({ where: { id: current.sessionId! }, select: { tokenDigest: true } });
  const digest = await tokenDigestFromCookie(proof.sessionToken);
  if (privilegedAccessMode() !== 'enforced' || !session || !digest || digest.length !== session.tokenDigest.length
    || !timingSafeEqual(digest, session.tokenDigest) || !verifyPrivilegedStepUpToken({ key: proof.key,
      expectedUserId: current.userId, sessionToken: proof.sessionToken, token: proof.stepUpToken,
      nowSeconds: Math.floor(now.getTime() / 1000) })) deny();
}

/** Key → directory → conversion identity → ordered users/session → client. All state is
 * reread after locks. Projection/management reads never create a grant. Only a
 * successful byte read records the minimized document access audit. */
async function transaction<T>(db: PrismaClient, claimed: AuthSession, recipientId: string | null,
  proof: ClientSharingCredentials | null, work: (tx: Tx, state: {
    current: AuthSession & SelectiveClientScope & { registryExpiresAt: Date }; key: PrivilegedStepUpKey;
    binding: NonNullable<Awaited<ReturnType<Tx['selectiveClientAuthority']['findUnique']>>>;
    authorityUser: Awaited<ReturnType<typeof liveUser>>; actor: Awaited<ReturnType<typeof liveUser>>;
  }) => Promise<T>) {
  return withSerializableTransaction(db, async tx => {
    if (internalSessionMode() !== 'registry' || !z.string().uuid().safeParse(claimed.sessionId).success) deny();
    const key = proof?.key ?? await loadActivePrivilegedStepUpKey(tx);
    if (!key || !await lockRegisteredPrivilegedStepUpKey(tx, key)) throw new ClientSharingError('UNAVAILABLE');
    await lockCommunicationDirectory(tx);
    await acquireLeadIdentityWriteLock(tx);
    await tx.$queryRaw`SELECT id FROM "SelectiveClientAuthority" WHERE id='client-sharing' FOR SHARE`;
    const binding = await tx.selectiveClientAuthority.findUnique({ where: { id: 'client-sharing' } });
    if (!binding?.enabled) deny();
    for (const id of [...new Set([binding.userId, claimed.userId, ...(recipientId ? [recipientId] : [])])].sort()) {
      await lockInternalUser(tx, id);
    }
    const row = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId! });
    if (!row || row.revokedAt || !row.active || row.deletedAt) deny();
    const current = { ...claimed, role: row.role, active: row.active, permissionOverrides: [...row.permissionOverrides],
      registryExpiresAt: row.expiresAt, clientReadScope: await loadClientReadScope(tx, claimed.userId),
      ...await loadSelectiveClientScope(tx, claimed.userId) };
    const actor = await liveUser(tx, claimed.userId), authorityUser = await liveUser(tx, binding.userId);
    if (!allowed(current) || authorityUser.role !== 'admin' || !allowed(authorityUser, true)) deny();
    await sessionLive(tx, current);
    if (proof) await personal(tx, current, proof);
    const result = await work(tx, { current, key, binding, authorityUser, actor });
    await sessionLive(tx, current);
    if (proof) await personal(tx, current, proof);
    return result;
  });
}
type State = Parameters<Parameters<typeof transaction>[4]>[1];
function manager(state: State) {
  if (state.binding.userId !== state.current.userId || state.current.role !== 'admin' || !allowed(state.current, true)) deny();
}
async function client(tx: Tx, id: string, write = false, allowInactive = false) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Client" WHERE id=${id} ${Prisma.raw(write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const row = await tx.client.findUnique({ where: { id } });
  if (!row || (!allowInactive && (row.deletedAt || ['archiviato', 'archiviata', 'sospeso'].includes(row.status)))) deny();
  return row;
}
async function selectedState(tx: Tx, state: State, input: SelectiveClientSelection, write = false) {
  manager(state);
  if (input.recipientId === state.current.userId) deny();
  const target = await liveUser(tx, input.recipientId);
  if (!allowed(target)) deny();
  const row = await client(tx, input.clientId, write);
  if (!canViewClient(state.current, row)) deny();
  const previous = await tx.selectiveClientGrant.findUnique({ where: { clientId_recipientId: { clientId: row.id, recipientId: target.id } } });
  if ((previous?.revision ?? 0) !== input.revision) stale();
  const now = await clock(tx);
  if (input.expiresAt && new Date(input.expiresAt) <= now) stale();
  const people = await selectClientPeople(tx, state.authorityUser, target, row.id, input.people ?? [], input.companies ?? []);
  const companies = await selectClientCompanies(tx, state.authorityUser, target, row.id, input.companies ?? []);
  const documents = await selectClientDocuments(tx, state.current.userId, target, row.id, input.documents ?? []);
  const admission = { actorId: state.actor.id, sessionId: state.current.sessionId!, authorityRevision: state.binding.revision,
    actorEpoch: state.actor.selectiveClientEpoch, recipientEpoch: target.selectiveClientEpoch, clientEpoch: row.recordUpdateEpoch,
    stateHash: canonicalSha256(asJson({ client: row, target: { id: target.id, name: target.name, email: target.email,
      role: target.role, epoch: target.selectiveClientEpoch, permissions: target.permissionOverrides },
      previous: previous ? { id: previous.id, revision: previous.revision, proof: previous.proof, revokedAt: previous.revokedAt } : null,
      documents: documents.snapshots, ...((input.version === 3 || input.version === 4) ? { companies: companies.snapshots } : {}),
      ...(input.version === 4 ? { people: people.snapshots } : {}) })) };
  return { row, target, previous, admission, now: await clock(tx), documents, companies, people };
}

export async function mayManageClientSharing(db: PrismaClient, session: AuthSession) {
  const binding = await db.selectiveClientAuthority.findUnique({ where: { id: 'client-sharing' } });
  return !!(session.sessionId && session.role === 'admin' && allowed(session, true) && binding?.enabled && binding.userId === session.userId);
}
export async function previewClientSharing(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = selectiveClientSelectionSchema.parse(raw);
  return transaction(db, claimed, input.recipientId, null, async (tx, state) => {
    const selected = await selectedState(tx, state, input);
    const targetScope = await loadSelectiveClientScope(tx, input.recipientId);
    return { token: createSelectiveClientPreview(state.key, input, selected.admission, selected.now.getTime()), input,
      fields: clientFieldProjection(selected.row as unknown as Record<string, unknown>, input.fields),
      documents: selected.documents.snapshots, companies: selected.companies.projection, people: selected.people.projection,
      recipient: { name: selected.target.name, email: selected.target.email, role: selected.target.role },
      replacesFullAccess: canViewClient({ userId: selected.target.id, role: selected.target.role, clientReadScope: await loadClientReadScope(tx, selected.target.id), ...targetScope }, selected.row),
      replacesSelection: !!selected.previous };
  });
}

const legacyReceiptSchema = z.object({ protocol: z.literal('SELECTIVE_CLIENT_RECEIPT_V1'), commandId: z.string().uuid(),
  grantId: z.string().uuid(), revisionId: z.string().uuid(), revision: z.number().int().positive(),
  operation: z.enum(['GRANT', 'REVOKE']), fieldCount: z.number().int().min(1).max(3), keyVersion: z.number().int().positive(),
}).strict();
const documentReceiptSchema = legacyReceiptSchema.extend({
  protocol: z.literal('SELECTIVE_CLIENT_RECEIPT_V2'), fieldCount: z.number().int().min(0).max(3),
  documentCount: z.number().int().min(0).max(maxClientDocuments),
});
const companyReceiptSchema = documentReceiptSchema.extend({
  protocol: z.literal('SELECTIVE_CLIENT_RECEIPT_V3'), companyCount: z.number().int().min(0).max(maxClientCompanyChoices),
  companyFieldCount: z.number().int().min(0).max(maxClientCompanyChoices * Object.keys(selectiveClientCompanyFields).length),
});
const receiptSchema = z.discriminatedUnion('protocol', [legacyReceiptSchema, documentReceiptSchema, companyReceiptSchema, companyReceiptSchema.extend({
  protocol: z.literal('SELECTIVE_CLIENT_RECEIPT_V4'), personCount: z.number().int().min(0).max(maxClientPersonChoices),
  personFieldCount: z.number().int().min(0).max(maxClientPersonChoices * Object.keys(selectiveClientPersonFields).length),
})]);
function receiptProtocol(input: SelectiveClientSelection) {
  return input.version === 4 ? 'SELECTIVE_CLIENT_RECEIPT_V4' : input.version === 3 ? 'SELECTIVE_CLIENT_RECEIPT_V3' : input.version === 2 ? 'SELECTIVE_CLIENT_RECEIPT_V2' : 'SELECTIVE_CLIENT_RECEIPT_V1';
}
function selectionCounts(input: SelectiveClientSelection) {
  return { fieldCount: input.fields.length, ...(input.version !== undefined ? { documentCount: input.documents!.length } : {}),
    ...((input.version === 3 || input.version === 4) ? { companyCount: input.companies!.length, companyFieldCount: input.companies!.reduce((sum, row) => sum + row.fields.length, 0) } : {}),
    ...(input.version === 4 ? { personCount: input.people!.length, personFieldCount: input.people!.reduce((sum, row) => sum + row.fields.length, 0) } : {}) };
}
async function previousCommand(tx: Tx, state: State, id: string, digest: string) {
  const command = await tx.selectiveClientCommand.findUnique({ where: { id } });
  if (!command) return null;
  if (command.actorId !== state.current.userId || command.sessionId !== state.current.sessionId || command.requestDigest !== digest) stale();
  const receipt = receiptSchema.parse(command.receipt);
  if (receipt.keyVersion !== state.key.version || !verifySelectiveClientProof(state.key, 'receipt', receipt, command.receiptProof)) deny();
  return receipt;
}
async function persist(tx: Tx, state: State, input: SelectiveClientSelection, payload: SelectiveClientGrantPayload,
  previous: { id: string; revision: number } | null, operation: 'GRANT' | 'REVOKE', requestDigest: string, now: Date) {
  const proof = selectiveClientProof(state.key, 'grant', payload), revokedAt = operation === 'REVOKE' ? now : null;
  const data = { id: payload.id, clientId: input.clientId, recipientId: input.recipientId, revision: payload.revision,
    payload: asJson(payload), proof, revokedAt, updatedAt: now };
  if (previous) await tx.selectiveClientGrant.update({ where: { id: previous.id, revision: previous.revision }, data });
  else await tx.selectiveClientGrant.create({ data });
  const revisionId = randomUUID();
  const receipt = receiptSchema.parse({ protocol: receiptProtocol(input), commandId: input.commandId,
    grantId: payload.id, revisionId, revision: payload.revision, operation, ...selectionCounts(input), keyVersion: state.key.version });
  await tx.selectiveClientCommand.create({ data: { id: input.commandId, actorId: state.current.userId, sessionId: state.current.sessionId!,
    clientId: input.clientId, recipientId: input.recipientId, expectedRevision: input.revision, operation, requestDigest,
    receipt: asJson(receipt), receiptProof: selectiveClientProof(state.key, 'receipt', receipt) } });
  await tx.selectiveClientRevision.create({ data: { id: revisionId, grantId: payload.id, revision: payload.revision,
    commandId: input.commandId, payload: asJson(payload), proof, revokedAt } });
  await tx.auditLog.create({ data: { id: revisionId, actorId: state.current.userId, entityType: 'SelectiveClientRevision', entityId: revisionId,
    event: 'selective_client_changed', before: { version: input.revision },
    after: { version: payload.revision, action: operation, ...selectionCounts(input) } } });
  return receipt;
}
export async function confirmClientSharing(db: PrismaClient, claimed: AuthSession, raw: unknown, token: string, proof: ClientSharingCredentials) {
  const input = selectiveClientSelectionSchema.parse(raw);
  if (token.length > (input.version === 4 ? 40_000 : input.version === 3 ? 24_000 : 12_000)) deny();
  const requestDigest = canonicalSha256({ operation: 'GRANT', input, token });
  return transaction(db, claimed, input.recipientId, proof, async (tx, state) => {
    manager(state);
    const existing = await previousCommand(tx, state, input.commandId, requestDigest);
    if (existing) return existing;
    const selected = await selectedState(tx, state, input, true);
    const verified = readSelectiveClientPreview(token, state.key, selected.admission, selected.now.getTime());
    if (!verified || canonicalSha256(verified) !== canonicalSha256(input)) stale();
    const payload = selectiveClientGrantPayloadSchema.parse({ id: selected.previous?.id ?? randomUUID(), selection: input,
      revision: input.revision + 1, approvedById: state.current.userId, approvedAt: selected.now.toISOString(),
      authorityRevision: state.binding.revision, actorEpoch: state.actor.selectiveClientEpoch,
      recipientEpoch: selected.target.selectiveClientEpoch, clientEpoch: selected.row.recordUpdateEpoch, keyVersion: state.key.version,
      ...(input.version !== undefined ? { documents: selected.documents.snapshots } : {}),
      ...((input.version === 3 || input.version === 4) ? { companies: selected.companies.snapshots } : {}),
      ...(input.version === 4 ? { people: selected.people.snapshots } : {}) });
    const receipt = await persist(tx, state, input, payload, selected.previous, 'GRANT', requestDigest, selected.now);
    if (!readSelectiveClientPreview(token, state.key, selected.admission, (await clock(tx)).getTime())) stale();
    return receipt;
  });
}
const revokeSchema = z.object({ grantId: z.string().uuid(), revision: z.number().int().positive(), commandId: z.string().uuid() }).strict();
export async function revokeClientSharing(db: PrismaClient, claimed: AuthSession, raw: unknown, proof: ClientSharingCredentials) {
  const input = revokeSchema.parse(raw);
  const requestDigest = canonicalSha256({ operation: 'REVOKE', input });
  // IDs only for lock order; all grant values are reread within the transaction.
  const identity = await db.selectiveClientGrant.findUnique({ where: { id: input.grantId }, select: { recipientId: true } });
  if (!identity) deny();
  return transaction(db, claimed, identity.recipientId, proof, async (tx, state) => {
    manager(state);
    const existing = await previousCommand(tx, state, input.commandId, requestDigest);
    if (existing) return existing;
    const grant = await tx.selectiveClientGrant.findUnique({ where: { id: input.grantId } });
    if (!grant || grant.recipientId !== identity.recipientId || grant.revision !== input.revision || grant.revokedAt) stale();
    if (grant.recipientId === state.current.userId) deny();
    const row = await client(tx, grant.clientId, true, true);
    if (state.current.selectiveClientIds?.includes(row.id)) deny();
    const old = selectiveClientGrantPayloadSchema.parse(grant.payload);
    const selection = { ...old.selection, revision: grant.revision, commandId: input.commandId };
    const now = await clock(tx);
    const target = await tx.user.findUniqueOrThrow({ where: { id: grant.recipientId }, select: { selectiveClientEpoch: true } });
    const payload = { ...old, selection, revision: grant.revision + 1, approvedAt: now.toISOString(),
      approvedById: state.current.userId, authorityRevision: state.binding.revision, actorEpoch: state.actor.selectiveClientEpoch,
      recipientEpoch: target.selectiveClientEpoch, clientEpoch: row.recordUpdateEpoch, keyVersion: state.key.version };
    return persist(tx, state, selection, payload, grant, 'REVOKE', requestDigest, now);
  });
}

async function authorizedClientSharing(tx: Tx, state: State, clientId: string) {
    const row = await client(tx, clientId);
    const grant = await tx.selectiveClientGrant.findUnique({ where: { clientId_recipientId: { clientId, recipientId: state.current.userId } } });
    if (!grant) deny();
    const current = { clientId, recipientId: state.current.userId, revision: grant.revision,
      authority: { enabled: state.binding.enabled, userId: state.binding.userId, revision: state.binding.revision,
        actorEpoch: state.authorityUser.selectiveClientEpoch, actorActive: true },
      recipientActive: true, recipientEpoch: state.actor.selectiveClientEpoch, clientEpoch: row.recordUpdateEpoch, clientOperational: true };
    const raw = { payload: grant.payload, proof: grant.proof, revokedAt: grant.revokedAt?.toISOString() ?? null };
    const payload = readSelectiveClientGrant(raw, state.key, current, (await clock(tx)).getTime());
    if (!payload || payload.id !== grant.id) deny();
    const revision = await tx.selectiveClientRevision.findUnique({ where: { grantId_revision: { grantId: grant.id, revision: grant.revision } }, include: { command: true } });
    const audit = revision && await tx.auditLog.findUnique({ where: { id: revision.id } });
    if (!revision || !audit || revision.proof !== grant.proof || canonicalSha256(revision.payload) !== canonicalSha256(grant.payload)
      || revision.command.id !== payload.selection.commandId || revision.command.clientId !== clientId
      || revision.command.recipientId !== state.current.userId || revision.command.expectedRevision + 1 !== grant.revision
      || canonicalSha256(audit.before) !== canonicalSha256({ version: revision.command.expectedRevision })
      || revision.revokedAt || revision.command.operation !== 'GRANT' || revision.command.actorId !== payload.approvedById
      || revision.command.transactionId !== revision.transactionId || audit.actorId !== payload.approvedById
      || audit.event !== 'selective_client_changed' || audit.entityType !== 'SelectiveClientRevision' || audit.entityId !== revision.id
      || canonicalSha256(audit.after) !== canonicalSha256({ version: grant.revision, action: 'GRANT', ...selectionCounts(payload.selection) })) deny();
    const receipt = receiptSchema.parse(revision.command.receipt);
    if (receipt.commandId !== revision.command.id || receipt.grantId !== grant.id || receipt.revisionId !== revision.id
      || receipt.revision !== grant.revision || receipt.operation !== 'GRANT' || receipt.fieldCount !== payload.selection.fields.length
      || receipt.protocol !== receiptProtocol(payload.selection)
      || (receipt.protocol !== 'SELECTIVE_CLIENT_RECEIPT_V1' && receipt.documentCount !== payload.documents?.length)
      || ((receipt.protocol === 'SELECTIVE_CLIENT_RECEIPT_V3' || receipt.protocol === 'SELECTIVE_CLIENT_RECEIPT_V4') && (receipt.companyCount !== payload.companies?.length
        || receipt.companyFieldCount !== payload.selection.companies?.reduce((sum, row) => sum + row.fields.length, 0)))
      || (receipt.protocol === 'SELECTIVE_CLIENT_RECEIPT_V4' && (receipt.personCount !== payload.people?.length
        || receipt.personFieldCount !== payload.selection.people?.reduce((sum, row) => sum + row.fields.length, 0)))
      || receipt.keyVersion !== state.key.version || !verifySelectiveClientProof(state.key, 'receipt', receipt, revision.command.receiptProof)) deny();
    if (!readSelectiveClientGrant(raw, state.key, current, (await clock(tx)).getTime())) deny();
    const people = await selectClientPeople(tx, state.authorityUser, state.actor, clientId, payload.selection.people ?? [], payload.selection.companies ?? []);
    if (canonicalSha256(people.snapshots) !== canonicalSha256(payload.people ?? [])) deny();
    const companies = await selectClientCompanies(tx, state.authorityUser, state.actor, clientId, payload.selection.companies ?? []);
    if (canonicalSha256(companies.snapshots) !== canonicalSha256(payload.companies ?? [])) deny();
    const documents = await selectClientDocuments(tx, state.binding.userId, state.actor, clientId, payload.selection.documents ?? []);
    if (canonicalSha256(documents.snapshots) !== canonicalSha256(payload.documents ?? [])) deny();
    return { row, grant, payload, documents, companies, people, current, raw };
}

export async function readClientSharing(db: PrismaClient, claimed: AuthSession, clientId: string) {
  return transaction(db, claimed, null, null, async (tx, state) => {
    const selected = await authorizedClientSharing(tx, state, clientId);
    if (!readSelectiveClientGrant(selected.raw, state.key, selected.current, (await clock(tx)).getTime())) deny();
    return { clientId, revision: selected.grant.revision, fields: clientFieldProjection(selected.row as unknown as Record<string, unknown>, selected.payload.selection.fields),
      documents: selected.documents.snapshots, companies: selected.companies.projection, people: selected.people.projection, expiresAt: selected.payload.selection.expiresAt };
  });
}

export async function readSharedClientDocument(db: PrismaClient, claimed: AuthSession, clientId: string, versionId: string, download: boolean,
  readBytes: (path: string, limit: number) => Promise<Buffer>) {
  return transaction(db, claimed, null, null, async (tx, state) => {
    const selected = await authorizedClientSharing(tx, state, clientId);
    const document = selected.documents.snapshots.find(row => row.versionId === versionId);
    const path = selected.documents.paths.get(versionId);
    if (!document || !path || (download && !document.download) || (!download && selectedDocumentMode(document) !== 'preview')) deny();
    const bytes = await readBytes(path, maxClientDocumentBytes);
    if (bytes.length > maxClientDocumentBytes || createHash('sha256').update(bytes).digest('hex') !== document.checksum) deny();
    const contentType = selectedDocumentResponseMime(document, bytes, download);
    await tx.auditLog.create({ data: { actorId: state.current.userId, entityType: 'Document', entityId: document.documentId,
      event: download ? 'selective_client_document_download' : 'selective_client_document_view',
      after: { versionId, grantId: selected.grant.id, revision: selected.grant.revision } } });
    if (!readSelectiveClientGrant(selected.raw, state.key, selected.current, (await clock(tx)).getTime())) deny();
    return { bytes, document, contentType };
  });
}

export async function readClientSharingReceipt(db: PrismaClient, claimed: AuthSession, commandId: string, clientId: string) {
  z.string().uuid().parse(commandId);
  z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(clientId);
  return transaction(db, claimed, null, null, async (tx, state) => {
    manager(state);
    const command = await tx.selectiveClientCommand.findUnique({ where: { id: commandId } });
    if (!command || command.actorId !== state.current.userId || command.clientId !== clientId) return null;
    const receipt = receiptSchema.parse(command.receipt);
    if (receipt.keyVersion !== state.key.version || !verifySelectiveClientProof(state.key, 'receipt', receipt, command.receiptProof)) deny();
    return receipt;
  });
}

/** Management view is read-only and does not enroll its visitor as authority. */
export async function clientSharingManagement(db: PrismaClient, claimed: AuthSession, clientId: string) {
  return transaction(db, claimed, null, null, async (tx, state) => {
    manager(state);
    const row = await client(tx, clientId);
    if (!canViewClient(state.current, row)) deny();
    const people = await tx.user.findMany({ where: { id: { not: state.current.userId }, active: true, deletedAt: null },
      include: { permissionOverrides: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    const grants = await tx.selectiveClientGrant.findMany({ where: { clientId }, orderBy: { updatedAt: 'desc' },
      include: { recipient: { select: { name: true, email: true } } } });
    const { documentOptions, documentsLimited } = await listClientDocumentOptions(tx, state.actor, clientId);
    const companies = await listClientCompanyOptions(tx, state.authorityUser, clientId);
    const personCatalogue = await listClientPeopleOptions(tx, state.authorityUser, clientId);
    return { clientId, title: row.displayName, documentOptions, ...companies, ...personCatalogue,
      documentsLimited,
      recipients: people.filter(person => allowed(person)).map(({ id, name, email, role }) => ({ id, name, email, role })),
      grants: grants.map(grant => {
        const payload = selectiveClientGrantPayloadSchema.safeParse(grant.payload);
        return { id: grant.id, recipientId: grant.recipientId, recipientName: grant.recipient.name,
          recipientEmail: grant.recipient.email, revision: grant.revision, revoked: !!grant.revokedAt,
          expiresAt: payload.success ? payload.data.selection.expiresAt : null,
          fields: payload.success ? payload.data.selection.fields : [],
          documentCount: payload.success ? (payload.data.documents?.length ?? 0) : 0,
          companyCount: payload.success ? (payload.data.companies?.length ?? 0) : 0,
          companyFieldCount: payload.success ? (payload.data.selection.companies?.reduce((sum, row) => sum + row.fields.length, 0) ?? 0) : 0,
          personCount: payload.success ? (payload.data.people?.length ?? 0) : 0,
          personFieldCount: payload.success ? (payload.data.selection.people?.reduce((sum, row) => sum + row.fields.length, 0) ?? 0) : 0 };
      }) };
  });
}

export async function listSharedClientIds(db: PrismaClient, claimed: AuthSession, page: number) {
  return transaction(db, claimed, null, null, async (tx, state) => {
    const rows = await tx.selectiveClientGrant.findMany({ where: { recipientId: state.current.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (Math.max(1, Math.min(200, Math.trunc(page))) - 1) * 30,
      take: 31, select: { clientId: true } });
    return { ids: rows.slice(0, 30).map(row => row.clientId), hasNext: rows.length > 30 };
  });
}
