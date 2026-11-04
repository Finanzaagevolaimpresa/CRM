import type { Prisma } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { hasPermission } from './permission-evaluator';
import { currentTechnicalRestriction } from './technical-account-membership';
import { ApprovedCommunicationError, type ApprovedMessageSnapshot } from './approved-communication-contract';
import { selectedInternalDisclosure, type InternalDisclosure } from './internal-content-disclosure';

type Tx = Prisma.TransactionClient;
type Thread = { version: number; ownerUserId: string };
type Participant = { userId: string; version: number };
/** Caller retains the directory and thread/participant locks through commit. */
export async function captureInternalDisclosure(tx: Tx, thread: Thread, participants: readonly Participant[],
  reviewerUserId: string, expiresAt: string | null): Promise<InternalDisclosure> {
  const users = await tx.user.findMany({ where: { id: { in: participants.map(p => p.userId) } },
    select: { id: true, role: true, active: true, deletedAt: true, recordUpdateEpoch: true } });
  if (thread.ownerUserId !== reviewerUserId || users.length !== participants.length
    || users.some(p => !p.active || p.deletedAt)) throw new ApprovedCommunicationError('CONFLICT');
  return { protocol: 'SELECTED_INTERNAL_TEXT_V1', reviewerUserId, threadVersion: thread.version, expiresAt,
    participants: participants.map(p => {
      const user = users.find(user => user.id === p.userId)!;
      return { userId: p.userId, version: p.version, epoch: user.recordUpdateEpoch, role: user.role };
    }).sort((a,b) => a.userId.localeCompare(b.userId)) };
}
export async function assertInternalDisclosureCurrent(tx: Tx, snapshot: ApprovedMessageSnapshot,
  thread: Thread | null, participants: readonly Participant[] | null) {
  const shared = selectedInternalDisclosure(snapshot);
  if (!shared) return;
  if (!thread || !participants) throw new ApprovedCommunicationError('CONFLICT');
  const current = await captureInternalDisclosure(tx, thread, participants, shared.reviewerUserId, shared.expiresAt);
  if (canonicalSha256(current) !== canonicalSha256(shared)) throw new ApprovedCommunicationError('CONFLICT');
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (shared.expiresAt && new Date(shared.expiresAt) <= clock.now) throw new ApprovedCommunicationError('SHARING_EXPIRED');
  const users = await tx.user.findMany({ where: { id: { in: shared.participants.map(p => p.userId) } },
    select: { id: true, role: true, active: true, permissionOverrides: { select: { permission: true, allowed: true } } } });
  for (const user of users) {
    const actor = { ...user, technicalRestricted: await currentTechnicalRestriction(tx, user.id, user) };
    if (!hasPermission(actor, 'communications.internal.read')) throw new ApprovedCommunicationError('RECIPIENT_PERMISSION_REQUIRED');
  }
}
