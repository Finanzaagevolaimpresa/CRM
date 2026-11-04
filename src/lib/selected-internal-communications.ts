import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { hasPermission } from './permission-evaluator';
import { approvedMessageSnapshotSchema, approvedMessageHash, ApprovedCommunicationError } from './approved-communication-contract';
import { internalDisclosureReader, selectedInternalDisclosure } from './internal-content-disclosure';
import { readOperationalState } from './admin-operational-state';

function deny(): never { throw new ApprovedCommunicationError('DENIED'); }
/** A separate read projection: no mailbox, A/CC/BCC, receipt, reply, attachment,
 * file identifier or linked CRM record is returned with the published text. */
export async function readSelectedInternalCommunications(db: Pick<PrismaClient, '$transaction'>, session: AuthSession, threadId?: string) {
  if (threadId) z.string().uuid().parse(threadId);
  return db.$transaction(async tx => {
    if (!session.sessionId || !session.active) deny();
    await lockCommunicationDirectory(tx);
    const actor = await lockAuthoritativeInternalSession(tx, { userId: session.userId, sessionId: session.sessionId });
    if (!actor || !actor.live || !actor.active || actor.revokedAt || actor.deletedAt || !hasPermission(actor, 'communications.internal.read')) deny();
    const user = await tx.user.findUnique({ where: { id: actor.userId }, select: { recordUpdateEpoch: true } });
    if (!user) deny();
    const rows = await tx.$queryRaw<Array<{ id: string; title: string; version: number; ownerUserId: string; participantVersion: number }>>`
      SELECT t.id,t.title,t.version,t."ownerUserId",p.version AS "participantVersion"
      FROM "InternalCommunicationThread" t JOIN "InternalCommunicationParticipant" p
      ON p."threadId"=t.id AND p."userId"=${actor.userId} AND p.active
      WHERE t."deletedAt" IS NULL ${threadId ? Prisma.sql`AND t.id=${threadId}::uuid` : Prisma.empty}
      ORDER BY t.id LIMIT 100 FOR SHARE OF t,p`;
    if (threadId && rows.length !== 1) deny();
    let until = Math.min(session.expiresAt * 1000, actor.expiresAt.getTime());
    const threads = [];
    for (const thread of rows) {
      const owner = await tx.user.findUnique({ where: { id: thread.ownerUserId },
        select: { active: true, deletedAt: true, role: true } });
      if (!owner?.active || owner.deletedAt || owner.role !== 'admin') continue;
      const ids = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "ApprovedCommunication"
        WHERE "contextKind"='INTERNAL' AND "internalThreadId"=${thread.id}::uuid
        ORDER BY id LIMIT 100 FOR SHARE`;
      const messages = [];
      for (const { id } of ids) {
        const row = await tx.approvedCommunication.findUnique({ where: { id },
          include: { versions: { include: { approval: true } } } });
        if (!row || !['APPROVED', 'SENDING', 'SENT', 'ERROR', 'UNCERTAIN'].includes(row.state)) continue;
        const version = row.versions.find(item => item.revision === row.currentRevision);
        if (!version?.approval || version.approval.snapshotHash !== version.snapshotHash
          || version.approval.approverUserId !== thread.ownerUserId || version.createdById !== thread.ownerUserId) continue;
        const parsed = approvedMessageSnapshotSchema.safeParse(version.snapshot);
        if (!parsed.success) continue;
        const snapshot = parsed.data, shared = selectedInternalDisclosure(snapshot);
        if (!shared || shared.reviewerUserId !== thread.ownerUserId || approvedMessageHash(snapshot) !== version.snapshotHash
          || snapshot.messageId !== row.id || snapshot.revision !== row.currentRevision
          || snapshot.context.kind !== 'INTERNAL' || snapshot.context.id !== thread.id) continue;
        const lifecycle = await readOperationalState(tx, 'ApprovedCommunication', row.id);
        if (lifecycle && (lifecycle.state !== 'ACTIVE' || lifecycle.version > 0 && lifecycle.updatedAt >= version.createdAt)) continue;
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        if (!internalDisclosureReader(shared, { userId: actor.userId, participantVersion: thread.participantVersion,
          epoch: user.recordUpdateEpoch, role: actor.role, threadVersion: thread.version, canRead: true }, clock.now)) continue;
        until = Math.min(until, shared.expiresAt ? new Date(shared.expiresAt).getTime() : Infinity);
        messages.push({ id: row.id, revision: row.currentRevision, subject: snapshot.subject, body: snapshot.body,
          publishedAt: version.approval.approvedAt.toISOString(), expiresAt: shared.expiresAt });
      }
      threads.push({ id: thread.id, title: messages.length ? thread.title : 'Conversazione interna · nessun testo pubblicato', messages });
    }
    const [end] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (end.now.getTime() >= until) deny();
    return threads;
  }, { timeout: 30_000 });
}
