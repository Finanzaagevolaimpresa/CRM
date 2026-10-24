import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { CommunicationContext } from './approved-communication-contract';
import { canonicalSha256 } from './canonical-json';
import { lockCommercialAdminRequestContext } from './admin-request-commercial-loader';
import { currentRecordUpdateUser } from './record-update-context';
import { loadActivePrivilegedStepUpKey, lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { lockInternalUser } from './internal-session-registry';
import { loadTechnicalAssignmentIndependentScope } from './selective-project-scope';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { isSelectivePractice } from './selective-practice-policy';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import { lockTechnicalAssignmentRecord, loadTechnicalAssignmentJournal } from './technical-assignment-storage';
import { readRetainedTechnicalAssignmentJournal } from './technical-assignment-journal';
import { admitsTechnicalAssignmentManager, admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { technicalAssignmentClock } from './technical-assignment-transaction';
import { technicalImplementedActions } from './technical-assignment-contract';

export const requestSubject = z.object({ kind: z.enum(['Lead', 'Client', 'Project', 'TechnicalPractice']),
  targetId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();
export type RequestSubject = z.infer<typeof requestSubject>;
export class AdminRequestError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'UNAVAILABLE') { super(`ADMIN_REQUEST_${code}`); }
}
export function requestDenied(): never { throw new AdminRequestError('DENIED'); }
export function requestStale(): never { throw new AdminRequestError('STALE'); }
type Tx = Prisma.TransactionClient;

/** Principal-only origin check. The caller authenticates its OWN session.
 * An Admin reviewing a request does not impersonate its author or require that
 * author's old browser session to remain open. Current ownership, authority,
 * recipient epochs and retained assignment evidence are nevertheless mandatory. */
export async function admitAdminRequestOrigin(tx: Tx, authorId: string, rawSubject: unknown) {
  const subject = requestSubject.parse(rawSubject);
  await lockCommunicationDirectory(tx);
  await lockInternalUser(tx, authorId);
  const author = await currentRecordUpdateUser(tx, authorId);
  if (!author) requestDenied();
  if (subject.kind === 'Lead' || subject.kind === 'Client') {
    const context = await lockCommercialAdminRequestContext(tx, author, subject);
    return { subject, authorId, recipientEpoch: author.recordUpdateEpoch, accessRevision: context.accessRevision,
      contextSha256: context.contextSha256, accessUntil: Infinity,
      communicationContext: { kind: subject.kind === 'Lead' ? 'LEAD' : 'CLIENT', id: subject.targetId } as CommunicationContext };
  }
  const key = await loadActivePrivilegedStepUpKey(tx);
  if (!key || !await lockRegisteredPrivilegedStepUpKey(tx, key)) requestDenied();
  const [authority] = await tx.$queryRaw<Array<{ userId: string; revision: number; enabled: boolean }>>`
    SELECT "userId",revision,enabled FROM "TechnicalAssignmentAuthority" WHERE id='technical-assignment' FOR SHARE`;
  if (!authority?.enabled) requestDenied();
  await lockInternalUser(tx, authority.userId);
  const manager = await currentRecordUpdateUser(tx, authority.userId);
  const principal = { ...author, ...await loadTechnicalAssignmentIndependentScope(tx, authorId) };
  if (!manager || !admitsTechnicalAssignmentManager(manager, subject.kind)
    || !admitsTechnicalRolePermission(principal, subject.kind, 'request_admin')) requestDenied();
  const technicalSubject = { kind: subject.kind, targetId: subject.targetId };
  const context = await lockTechnicalAssignmentContext(tx, technicalSubject);
  if (!context?.operational || hasSelectiveClientContext(principal, context) || hasSelectiveContext(principal, context)
    || (subject.kind === 'TechnicalPractice' && isSelectivePractice(principal, subject.targetId))) requestDenied();
  const record = await lockTechnicalAssignmentRecord(tx, { ...technicalSubject, recipientId: authorId }, 'read');
  if (!record || record.revokedAt !== null) requestDenied();
  const now = await technicalAssignmentClock(tx);
  const journal = readRetainedTechnicalAssignmentJournal(await loadTechnicalAssignmentJournal(tx, record), key, now);
  if (!journal || journal.decision.operation !== 'ASSIGN') requestDenied();
  const p = journal.assignment.payload;
  if (p.id !== record.id || p.revision !== record.revision || p.targetId !== subject.targetId
    || p.selection.kind !== subject.kind || p.selection.userId !== authorId
    || p.approvedById !== manager.id || p.approvedById === authorId
    || p.authorityRevision !== authority.revision || p.actorEpoch !== manager.recordUpdateEpoch
    || p.recipientEpoch !== author.recordUpdateEpoch || p.contextSha256 !== context.contextSha256
    || p.keyVersion !== key.version || Date.parse(p.selection.expiresAt) <= now.getTime()
    || !p.selection.actions.includes('request_admin')
    || p.selection.actions.some(action => !technicalImplementedActions.some(available => available === action))) requestDenied();
  // Project requests retain their exact project origin. The existing CLIENT
  // composer is used only for the real parent client; no fake practice exists.
  return { subject, authorId, recipientEpoch: author.recordUpdateEpoch, accessRevision: record.revision,
    contextSha256: canonicalSha256({ context: context.contextSha256, assignment: record.id,
      authority: authority.revision, managerEpoch: manager.recordUpdateEpoch, keyVersion: key.version }),
    accessUntil: Date.parse(p.selection.expiresAt),
    communicationContext: { kind: subject.kind === 'Project' ? 'CLIENT' : 'TECHNICAL',
      id: subject.kind === 'Project' ? context.clientId : subject.targetId } as CommunicationContext };
}

export function exactRequestOrigin(origin: Awaited<ReturnType<typeof admitAdminRequestOrigin>>,
  submitted: { expectedContextSha256: string; expectedRecipientEpoch: number; expectedAccessRevision: number }) {
  if (origin.contextSha256 !== submitted.expectedContextSha256 || origin.recipientEpoch !== submitted.expectedRecipientEpoch
    || origin.accessRevision !== submitted.expectedAccessRevision) requestStale();
}
