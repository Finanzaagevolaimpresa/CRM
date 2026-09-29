import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { hasPermission } from './permission-evaluator';
import { mailboxQualification } from './approved-communication-contract';
import { DIRECT_TEST_FROM, DirectTestError, directTestDigest, directTestMessage, readDirectTestConfig,
  signDirectTestPreview, verifyDirectTestPreview, type DirectTestConfig, type DirectTestOutcome } from './direct-email-test';

type Db = Pick<PrismaClient, '$transaction'>;
type Runtime = { config: () => DirectTestConfig | null;
  send: (config: DirectTestConfig, attemptId: string) => Promise<DirectTestOutcome> };
const receiptSchema = z.object({ format: z.literal('FAI_DIRECT_EMAIL_TEST_V1'),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), outcome: z.enum(['RESERVED', 'ACCEPTED', 'NOT_SENT', 'UNCERTAIN']) }).strict();
function attemptId(reference: string) { return `direct_test_${createHash('sha256').update(reference).digest('hex')}`; }
function config(runtime: Pick<Runtime, 'config'>) {
  const value = runtime.config(); if (!value) throw new DirectTestError('DISABLED'); return value;
}
async function authorize(tx: Prisma.TransactionClient, session: AuthSession, settings: DirectTestConfig) {
  if (!session.sessionId || !z.string().uuid().safeParse(session.sessionId).success || !session.active
    || session.expiresAt * 1000 <= Date.now()) throw new DirectTestError('DENIED');
  // One narrow diagnostic mailbox: serialize before actor/responsible locks so
  // competing admins cannot acquire those user locks in the opposite order.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(641036, 1)::text`;
  const current = await lockAuthoritativeInternalSession(tx, { userId: session.userId, sessionId: session.sessionId });
  if (!current || !current.live || current.revokedAt || !current.active || current.deletedAt || current.role !== 'admin'
    || !hasPermission({ ...session, role: current.role, permissionOverrides: current.permissionOverrides }, 'settings.manage')) throw new DirectTestError('DENIED');
  await tx.$queryRaw`SELECT id FROM "CommunicationMailbox" WHERE address=${DIRECT_TEST_FROM} FOR UPDATE`;
  const box = await tx.communicationMailbox.findUnique({ where: { address: DIRECT_TEST_FROM } });
  if (!box || box.kind !== 'MAILBOX' || box.canonicalMailboxId || !box.canSend || !box.canReceive || !box.responsibleUserId
    || !mailboxQualification({ id: box.id, address: box.address, revision: box.revision,
      configuredRevision: box.configuredRevision, configurationReference: box.configurationReference,
      testedRevision: box.testedRevision, testReference: box.testReference, testedAt: box.testedAt?.toISOString() ?? null,
      enabled: box.enabled, method: 'MANUAL_EXTERNAL', responsibleUserId: box.responsibleUserId,
      restricted: box.restricted }).enabled) throw new DirectTestError('SENDER_NOT_READY');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${box.responsibleUserId} FOR SHARE`;
  const responsible = await tx.user.findUnique({ where: { id: box.responsibleUserId }, select: { active: true, deletedAt: true } });
  if (!responsible?.active || responsible.deletedAt) throw new DirectTestError('SENDER_NOT_READY');
  return directTestDigest(settings, { settings, message: directTestMessage(settings), mailboxId: box.id,
    revision: box.revision, responsibleUserId: box.responsibleUserId, configuredRevision: box.configuredRevision,
    configurationReference: box.configurationReference, testedRevision: box.testedRevision, testReference: box.testReference,
    sessionId: session.sessionId, userId: session.userId });
}
function verifyReceipt(row: { entityType: string | null; entityId: string | null; event: string; after: unknown }, id: string, settings: DirectTestConfig, event: string) {
  const receipt = receiptSchema.safeParse(row.after);
  if (row.entityType !== 'DirectEmailTest' || row.entityId !== id || row.event !== event || !receipt.success
    || receipt.data.configurationHash !== directTestDigest(settings, settings)) throw new DirectTestError('STALE');
  return receipt.data;
}
async function outcome(tx: Prisma.TransactionClient, id: string, settings: DirectTestConfig) {
  const result = await tx.auditLog.findUnique({ where: { id: `${id}_result` } });
  if (!result) return 'UNCERTAIN' as const; // Includes crash or an in-flight reservation: never resend.
  const receipt = verifyReceipt(result, id, settings, 'direct_email_test_result');
  return receipt.outcome === 'RESERVED' ? 'UNCERTAIN' as const : receipt.outcome;
}
export async function previewDirectEmailTest(db: Db, session: AuthSession, runtime = { config: readDirectTestConfig }) {
  const settings = config(runtime);
  return db.$transaction(async tx => {
    const snapshotHash = await authorize(tx, session, settings), id = attemptId(settings.reference);
    const existing = await tx.auditLog.findUnique({ where: { id } });
    if (existing) {
      verifyReceipt(existing, id, settings, 'direct_email_test_reserved');
      return { message: directTestMessage(settings), token: null, outcome: await outcome(tx, id, settings) };
    }
    const preview = { protocol: 'FAI_DIRECT_EMAIL_TEST_V1' as const, reference: settings.reference, snapshotHash, expiresAt: Date.now() + 5 * 60_000 };
    return { message: directTestMessage(settings), token: signDirectTestPreview(settings, preview), outcome: null };
  });
}
export async function sendApprovedDirectEmailTest(db: Db, session: AuthSession, input: { token: string; exactApproval: boolean },
  admitted: boolean, runtime: Runtime): Promise<DirectTestOutcome> {
  if (!admitted || input.exactApproval !== true) throw new DirectTestError('DENIED');
  const settings = config(runtime), preview = verifyDirectTestPreview(settings, input.token), id = attemptId(settings.reference);
  // The reservation commits before any provider call. The mailbox lock serializes
  // all attempts for this diagnostic; the primary key survives processes/restarts.
  const reservation = await db.$transaction(async tx => {
    const hash = await authorize(tx, session, settings);
    if (hash !== preview.snapshotHash) throw new DirectTestError('STALE');
    const existing = await tx.auditLog.findUnique({ where: { id } });
    if (existing) {
      verifyReceipt(existing, id, settings, 'direct_email_test_reserved');
      return { fresh: false, outcome: await outcome(tx, id, settings) };
    }
    const receipt = receiptSchema.parse({ format: preview.protocol, snapshotHash: hash,
      configurationHash: directTestDigest(settings, settings), outcome: 'RESERVED' });
    const saved = await tx.auditLog.create({ data: { id, actorId: session.userId, entityType: 'DirectEmailTest', entityId: id,
      event: 'direct_email_test_reserved', after: receipt } });
    if (JSON.stringify(receiptSchema.parse(saved.after)) !== JSON.stringify(receipt)) throw new DirectTestError('INVALID');
    return { fresh: true, outcome: 'UNCERTAIN' as DirectTestOutcome };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
  if (!reservation.fresh) return reservation.outcome;
  try {
    // No transaction retry around transport. Locks prevent a revocation/mailbox
    // change from racing the final check and the SMTP call. Timeout is bounded.
    return await db.$transaction(async tx => {
      const currentConfig = config(runtime);
      verifyDirectTestPreview(currentConfig, input.token);
      if (await authorize(tx, session, currentConfig) !== preview.snapshotHash) throw new DirectTestError('STALE');
      const result = await runtime.send(currentConfig, id);
      const receipt = receiptSchema.parse({ format: preview.protocol, snapshotHash: preview.snapshotHash,
        configurationHash: directTestDigest(currentConfig, currentConfig), outcome: result });
      const saved = await tx.auditLog.create({ data: { id: `${id}_result`, actorId: session.userId, entityType: 'DirectEmailTest', entityId: id,
        event: 'direct_email_test_result', after: receipt } });
      if (JSON.stringify(receiptSchema.parse(saved.after)) !== JSON.stringify(receipt)) throw new DirectTestError('INVALID');
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
  } catch { return 'UNCERTAIN'; } // Durable reservation is retained, even if result commit is uncertain.
}
