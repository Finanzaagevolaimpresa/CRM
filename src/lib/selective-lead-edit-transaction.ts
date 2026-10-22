import { timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { loadActivePrivilegedStepUpKey, lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { privilegedAccessMode } from './application-security-policy';
import { canonicalSha256 } from './canonical-json';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { lockAuthoritativeInternalSession, lockInternalUser, tokenDigestFromCookie } from './internal-session-registry';
import { acquireLeadIdentityWriteLock } from './lead-identity';
import { hasPermission } from './permission-evaluator';
import { verifyPrivilegedStepUpToken, type PrivilegedStepUpKey } from './privileged-step-up-token';
import { withSerializableTransaction } from './serializable';
import { internalSessionMode } from './session';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { readSelectiveLeadGrant } from './selective-lead-grant';
import { verifySelectiveLeadProof } from './selective-lead-proof';

type Tx = Prisma.TransactionClient;
type CurrentSession = AuthSession & { registryExpiresAt: Date };
type EditAuthority = { id: string; userId: string; revision: number; enabled: boolean };
export type LeadEditPersonalProof = { key: PrivilegedStepUpKey; sessionToken: string; stepUpToken: string };
export class LeadEditError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'UNAVAILABLE') { super(`SELECTIVE_LEAD_EDIT_${code}`); }
}
function deny(): never { throw new LeadEditError('DENIED'); }
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const generation = z.number().int().positive().max(2_147_483_647);
const authoritySchema = z.object({ id: z.literal('lead-edit'), userId: identifier,
  revision: generation, enabled: z.boolean() }).strict();

export async function leadEditClock(tx: Tx) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!row || !Number.isFinite(row.now.getTime())) throw new LeadEditError('UNAVAILABLE');
  return row.now;
}
async function liveUser(tx: Tx, id: string) {
  const user = await tx.user.findUnique({ where: { id }, include: { permissionOverrides: true } });
  if (!user || !user.active || user.deletedAt) deny();
  return user;
}
function allowed(user: Pick<AuthSession, 'active' | 'role' | 'permissionOverrides'>, write = false) {
  const permissions = write ? ['lead.read', 'lead.write'] as const : ['lead.read'] as const;
  return user.active && permissions.every(permission => hasPermission(user, permission)
    && !user.permissionOverrides.some(item => item.permission === permission && !item.allowed));
}
async function liveSession(tx: Tx, current: CurrentSession) {
  const now = await leadEditClock(tx);
  if (!Number.isFinite(current.expiresAt) || current.expiresAt * 1000 <= now.getTime()
    || current.registryExpiresAt <= now) deny();
  return now;
}
async function personal(tx: Tx, current: CurrentSession, proof: LeadEditPersonalProof) {
  const now = await liveSession(tx, current);
  const session = await tx.internalSession.findUnique({ where: { id: current.sessionId! }, select: { tokenDigest: true } });
  const digest = await tokenDigestFromCookie(proof.sessionToken);
  if (privilegedAccessMode() !== 'enforced' || !session || !digest || digest.length !== session.tokenDigest.length
    || !timingSafeEqual(digest, session.tokenDigest) || !verifyPrivilegedStepUpToken({ key: proof.key,
      expectedUserId: current.userId, sessionToken: proof.sessionToken, token: proof.stepUpToken,
      nowSeconds: Math.floor(now.getTime() / 1000) })) deny();
}

export type LeadEditTransactionState = {
  current: CurrentSession; key: PrivilegedStepUpKey;
  readAuthority: NonNullable<Awaited<ReturnType<Tx['selectiveLeadAuthority']['findUnique']>>>;
  editAuthority: EditAuthority;
  authorityUser: Awaited<ReturnType<typeof liveUser>>;
  actor: Awaited<ReturnType<typeof liveUser>>;
  recipient: Awaited<ReturnType<typeof liveUser>>;
};

/** Transaction foundation only: this does not admit a lead, a capability or a
 * mutation. The callback must lock the lead and verify both signed journals.
 * The empty SelectiveLeadEditAuthority table requires its own reviewed
 * SQL and personal binding; there is no fallback to the read-only authority.
 * An absent or disabled authority fails closed, including for Admin accounts.
 */
export async function withLeadEditTransaction<T>(db: PrismaClient, claimed: AuthSession,
  recipientId: string, proof: LeadEditPersonalProof | null,
  work: (tx: Tx, state: LeadEditTransactionState) => Promise<T>,
  options: { inactiveRecipientForRevocation?: true } = {}) {
  identifier.parse(claimed.userId); identifier.parse(recipientId);
  if (options.inactiveRecipientForRevocation && !proof) deny();
  return withSerializableTransaction(db, async tx => {
    if (internalSessionMode() !== 'registry' || !z.string().uuid().safeParse(claimed.sessionId).success) deny();
    const key = proof?.key ?? await loadActivePrivilegedStepUpKey(tx);
    if (!key || !await lockRegisteredPrivilegedStepUpKey(tx, key)) throw new LeadEditError('UNAVAILABLE');
    // Match read-sharing, directory/profile writers and lifecycle: key first,
    // directory, identity, read authority, edit authority, sorted users/session.
    await lockCommunicationDirectory(tx);
    await acquireLeadIdentityWriteLock(tx);
    await tx.$queryRaw`SELECT id FROM "SelectiveLeadAuthority" WHERE id='lead-sharing' FOR SHARE`;
    const readAuthority = await tx.selectiveLeadAuthority.findUnique({ where: { id: 'lead-sharing' } });
    const edits = await tx.$queryRaw<EditAuthority[]>`
      SELECT id,"userId",revision,enabled FROM "SelectiveLeadEditAuthority" WHERE id='lead-edit' FOR SHARE`;
    const parsed = authoritySchema.safeParse(edits[0]);
    if (!readAuthority?.enabled || !parsed.success || !parsed.data.enabled
      || parsed.data.userId !== readAuthority.userId) deny();
    const editAuthority = parsed.data;
    for (const id of [...new Set([readAuthority.userId, claimed.userId, recipientId])].sort()) {
      await lockInternalUser(tx, id);
    }
    const row = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId! });
    if (!row || row.revokedAt || !row.active || row.deletedAt) deny();
    const current: CurrentSession = { ...claimed, role: row.role, active: row.active,
      permissionOverrides: [...row.permissionOverrides], registryExpiresAt: row.expiresAt,
      ...await loadSelectiveProjectScope(tx, claimed.userId) };
    const authorityUser = await liveUser(tx, readAuthority.userId), actor = await liveUser(tx, claimed.userId);
    const recipient = options.inactiveRecipientForRevocation
      ? await tx.user.findUnique({ where: { id: recipientId }, include: { permissionOverrides: true } })
      : await liveUser(tx, recipientId);
    if (!recipient || !allowed(current) || (!options.inactiveRecipientForRevocation && !allowed(recipient))
      || authorityUser.role !== 'admin' || !allowed(authorityUser, true)) deny();
    if (current.userId !== recipientId && (current.userId !== editAuthority.userId
      || current.role !== 'admin' || !allowed(current, true))) deny();
    if (proof && (current.userId !== editAuthority.userId || current.role !== 'admin' || !allowed(current, true))) deny();
    await liveSession(tx, current);
    if (proof) await personal(tx, current, proof);
    const result = await work(tx, { current, key, readAuthority, editAuthority, authorityUser, actor, recipient });
    // Surface deferred integrity errors inside the callback. A successful
    // callback value must never be mistaken for a committed command when a
    // deferred PostgreSQL trigger rejects COMMIT through the ORM adapter.
    await tx.$executeRaw`SET CONSTRAINTS selective_lead_edit_grant_atomic,
      selective_lead_edit_revision_atomic, selective_lead_edit_decision_atomic,
      selective_lead_edit_command_atomic IMMEDIATE`;
    await liveSession(tx, current);
    if (proof) await personal(tx, current, proof);
    return result;
  });
}

const readReceiptSchema = z.object({ protocol: z.literal('SELECTIVE_LEAD_RECEIPT_V1'), commandId: z.string().uuid(),
  grantId: z.string().uuid(), revisionId: z.string().uuid(), revision: generation,
  operation: z.enum(['GRANT', 'REVOKE']), fieldCount: z.number().int().min(1).max(12), keyVersion: generation,
}).strict();

/** Internal admission facts, never a route response. Only call under the locks
 * held by withLeadEditTransaction, then lock the edit capability. A signed read
 * payload alone is insufficient: its persisted revision, command, receipt and
 * minimized audit must agree with the currently locked lead and recipient.
 */
export async function lockLeadEditReadContext(tx: Tx, state: LeadEditTransactionState, leadId: string, write = false) {
  identifier.parse(leadId);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Lead" WHERE id=${leadId} ${Prisma.raw(write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const lead = await tx.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.deletedAt || lead.status === 'archiviato' || lead.clientId) deny();
  await tx.$queryRaw`SELECT id FROM "SelectiveLeadGrant"
    WHERE "leadId"=${leadId} AND "recipientId"=${state.recipient.id} FOR SHARE`;
  const grant = await tx.selectiveLeadGrant.findUnique({
    where: { leadId_recipientId: { leadId, recipientId: state.recipient.id } } });
  if (!grant) deny();
  const current = { leadId, recipientId: state.recipient.id, revision: grant.revision,
    authority: { enabled: state.readAuthority.enabled, userId: state.readAuthority.userId,
      revision: state.readAuthority.revision, actorEpoch: state.authorityUser.selectiveLeadEpoch, actorActive: true },
    recipientActive: state.recipient.active && !state.recipient.deletedAt, recipientEpoch: state.recipient.selectiveLeadEpoch,
    leadEpoch: lead.recordUpdateEpoch, leadOperational: true };
  const raw = { payload: grant.payload, proof: grant.proof, revokedAt: grant.revokedAt?.toISOString() ?? null };
  const payload = readSelectiveLeadGrant(raw, state.key, current, (await leadEditClock(tx)).getTime());
  if (!payload || payload.id !== grant.id) deny();
  const revision = await tx.selectiveLeadRevision.findUnique({
    where: { grantId_revision: { grantId: grant.id, revision: grant.revision } }, include: { command: true } });
  const audit = revision && await tx.auditLog.findUnique({ where: { id: revision.id } });
  if (!revision || !audit || revision.revokedAt || revision.proof !== grant.proof
    || canonicalSha256(revision.payload) !== canonicalSha256(grant.payload)
    || revision.command.id !== payload.selection.commandId || revision.command.leadId !== leadId
    || revision.command.recipientId !== state.recipient.id || revision.command.expectedRevision + 1 !== grant.revision
    || revision.command.operation !== 'GRANT' || revision.command.actorId !== payload.approvedById
    || revision.command.transactionId !== revision.transactionId || audit.actorId !== payload.approvedById
    || audit.event !== 'selective_lead_changed' || audit.entityType !== 'SelectiveLeadRevision' || audit.entityId !== revision.id
    || canonicalSha256(audit.before) !== canonicalSha256({ version: revision.command.expectedRevision })
    || canonicalSha256(audit.after) !== canonicalSha256({ version: grant.revision, action: 'GRANT', fieldCount: payload.selection.fields.length })) deny();
  const receipt = readReceiptSchema.parse(revision.command.receipt);
  if (receipt.commandId !== revision.command.id || receipt.grantId !== grant.id || receipt.revisionId !== revision.id
    || receipt.revision !== grant.revision || receipt.operation !== 'GRANT' || receipt.fieldCount !== payload.selection.fields.length
    || receipt.keyVersion !== state.key.version || !verifySelectiveLeadProof(state.key, 'receipt', receipt, revision.command.receiptProof)) deny();
  const now = await liveSession(tx, state.current);
  if (!readSelectiveLeadGrant(raw, state.key, current, now.getTime())) deny();
  return { lead, grant, payload, raw, current, now };
}
