import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { canViewClient, canViewProject, canViewTask, canViewTechnicalPractice } from './access-control';
import { currentRecordUpdateUser, recordUpdatePermission, recordReadPermissions } from './record-update-context';
import { lockInternalUser } from './internal-session-registry';
import { loadTechnicalAssignmentIndependentScope } from './selective-project-scope';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { isSelectivePractice } from './selective-practice-policy';
import { admitsTechnicalAssignmentManager, admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { lockTechnicalAssignmentRecord, loadTechnicalAssignmentJournal } from './technical-assignment-storage';
import { readRetainedTechnicalAssignmentJournal } from './technical-assignment-journal';
import { assertTechnicalAssignmentDocuments } from './technical-assignment-documents';
import { TechnicalAssignmentError } from './technical-assignment-errors';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { LockedReminderSource } from './record-reminder-source';
import type { ReminderRecipientAdmission } from './record-reminder-contract';
import { admitTechnicalReminderSelection } from './record-reminder-technical-policy';

type Tx = Prisma.TransactionClient;
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const authoritySchema = z.object({ id: z.literal('technical-assignment'), userId: id,
  enabled: z.boolean(), revision: z.number().int().positive().max(2_147_483_647) }).strict();

/** Called after key/directory admission and before domain locks. The selected
 * people are current directory IDs, never caller-supplied admission facts. */
export async function lockReminderPrincipals(tx: Tx, authorId: string, recipientIds: readonly string[]) {
  const ids = [...new Set([authorId, ...recipientIds].map(value => id.parse(value)))];
  if (ids.length > 101) throw new Error('REMINDER_PRINCIPALS_UNAVAILABLE');
  const rows = await tx.$queryRaw<unknown[]>`SELECT id,"userId",enabled,revision FROM "TechnicalAssignmentAuthority"
    WHERE id='technical-assignment' FOR SHARE`;
  if (rows.length > 1) throw new Error('REMINDER_AUTHORITY_UNAVAILABLE');
  const authority = rows.length ? authoritySchema.parse(rows[0]) : null;
  if (authority) ids.push(authority.userId);
  const principals = new Map<string, { raw: Prisma.UserGetPayload<{ include: { permissionOverrides: true } }>;
    ordinary: NonNullable<Awaited<ReturnType<typeof currentRecordUpdateUser>>>;
    technicalScope: Awaited<ReturnType<typeof loadTechnicalAssignmentIndependentScope>> }>();
  for (const userId of [...new Set(ids)].sort()) {
    await lockInternalUser(tx, userId);
    const raw = await tx.user.findUnique({ where: { id: userId }, include: { permissionOverrides: true } });
    const ordinary = await currentRecordUpdateUser(tx, userId);
    if (raw && ordinary) principals.set(userId, { raw, ordinary,
      technicalScope: await loadTechnicalAssignmentIndependentScope(tx, userId) });
  }
  return { authority, principals, authorId };
}
export type ReminderPrincipals = Awaited<ReturnType<typeof lockReminderPrincipals>>;

export function ordinaryReminderAdmission(source: LockedReminderSource,
  user: NonNullable<Awaited<ReturnType<typeof currentRecordUpdateUser>>>): ReminderRecipientAdmission | null {
  if (['consulente', 'backoffice'].includes(user.role) || source.task.technicalPrivate || !recordUpdatePermission(user, 'service.read')
    || !recordUpdatePermission(user, recordReadPermissions[source.source.kind]) || !canViewTask(user, source.taskAccess)) return null;
  const recordReadable = source.source.kind === 'CLIENT' ? canViewClient(user, source.client)
    : source.source.kind === 'PROJECT' ? source.project && canViewProject(user, { ...source.project, client: source.client })
      : source.practice && canViewTechnicalPractice(user, { ...source.practice, client: source.client,
        project: source.project ? { ...source.project, client: source.client } : null,
        clientService: source.service ? { ...source.service, client: source.client,
          project: source.project ? { ...source.project, client: source.client } : null } : null });
  if (!recordReadable) return null;
  return { id: user.id, epoch: user.recordUpdateEpoch, canReadRecord: true, canReadTaskDeadline: true,
    accessUntil: null, accessBinding: canonicalSha256({ protocol: 'ORDINARY_REMINDER_ADMISSION_V1',
      actorId: user.id, epoch: user.recordUpdateEpoch, source: source.source.scopeDigest }) };
}

/** Current principal-only admission for a scheduled notice. No recipient is
 * impersonated: the caller authenticates its own session separately. */
export async function technicalReminderAdmission(tx: Tx, key: PrivilegedStepUpKey, loaded: ReminderPrincipals,
  source: LockedReminderSource, recipientId: string, now: Date): Promise<ReminderRecipientAdmission | null> {
  const context = source.technicalContext, item = source.technical, authority = loaded.authority;
  const person = loaded.principals.get(recipientId), manager = authority ? loaded.principals.get(authority.userId) : null;
  if (!context || !item || !authority?.enabled || !person || !manager) return null;
  const principal = { ...person.ordinary, ...person.technicalScope };
  const allowed = admitsTechnicalRolePermission(principal, context.kind, 'manage_deadlines');
  const managerAllowed = admitsTechnicalAssignmentManager(manager.ordinary, context.kind);
  const selectiveCeilingAllows = !hasSelectiveClientContext(principal, context) && !hasSelectiveContext(principal, context)
    && !(context.kind === 'TechnicalPractice' && isSelectivePractice(principal, context.targetId));
  if (!allowed || !managerAllowed || !selectiveCeilingAllows) return null;
  const target = { kind: context.kind, targetId: context.targetId };
  const record = await lockTechnicalAssignmentRecord(tx, { ...target, recipientId }, 'read');
  if (!record || record.revokedAt !== null) return null;
  const journal = readRetainedTechnicalAssignmentJournal(await loadTechnicalAssignmentJournal(tx, record), key, now);
  if (!journal || journal.decision.operation !== 'ASSIGN') return null;
  const grant = admitTechnicalReminderSelection(journal.assignment.payload, { ...target, taskId: source.task.id,
    assignmentId: record.id, assignmentRevision: record.revision, journalVerified: true, revoked: false,
    authority: { ...authority, managerEpoch: manager.raw.recordUpdateEpoch, managerAllowed },
    recipient: { id: recipientId, epoch: person.raw.recordUpdateEpoch, active: person.raw.active && !person.raw.deletedAt,
      allowed, selectiveCeilingAllows }, contextSha256: context.contextSha256, scopeSha256: item.scopeSha256,
    scopeGeneration: item.epoch.scopeGeneration, keyVersion: key.version, now });
  if (!grant) return null;
  try {
    // Match the current work route: an invalid linked version cannot be avoided
    // by entering from a notification instead of the assigned activity.
    const documents = await assertTechnicalAssignmentDocuments(tx, { authority, recipient: person.raw }, context,
      journal.assignment.payload.selection.documents);
    const accessUntil = Math.min(grant.accessUntil, documents.validUntil);
    if (accessUntil <= now.getTime()) return null;
    return { id: recipientId, epoch: person.raw.recordUpdateEpoch, canReadRecord: true,
      canReadTaskDeadline: true, accessBinding: grant.accessBinding, accessUntil: new Date(accessUntil).toISOString() };
  } catch (error) {
    if (error instanceof TechnicalAssignmentError && ['DENIED', 'STALE'].includes(error.code)) return null;
    if (error instanceof Error && ['SELECTIVE_CLIENT_DOCUMENT_UNAVAILABLE', 'SELECTIVE_PRACTICE_DOCUMENT_UNAVAILABLE'].includes(error.message)) return null;
    throw error;
  }
}

/** Private activities retain the existing personal management boundary. An
 * ordinary Admin role never substitutes for that distinct authority. */
export function reminderAuthorAdmission(loaded: ReminderPrincipals, source: LockedReminderSource) {
  const author = loaded.principals.get(loaded.authorId);
  if (!author || author.raw.role !== 'admin' || !recordUpdatePermission(author.ordinary, 'service.write')
    || !recordUpdatePermission(author.ordinary, source.source.kind === 'PRACTICE' ? 'technical.write'
      : source.source.kind === 'PROJECT' ? 'project.write' : 'client.write')) return null;
  if (!source.task.technicalPrivate) return ordinaryReminderAdmission(source, author.ordinary);
  const a = loaded.authority, context = source.technicalContext;
  if (!a?.enabled || a.userId !== author.raw.id || !context || !admitsTechnicalAssignmentManager(author.ordinary, context.kind)
    || hasSelectiveClientContext(author.ordinary, context) || hasSelectiveContext(author.ordinary, context)
    || (context.kind === 'TechnicalPractice' && isSelectivePractice(author.ordinary, context.targetId))) return null;
  return { id: author.raw.id, epoch: author.raw.recordUpdateEpoch, canReadRecord: true, canReadTaskDeadline: true,
    accessUntil: null, accessBinding: canonicalSha256({ protocol: 'PRIVATE_REMINDER_MANAGER_V1',
      authority: a.id, revision: a.revision, authorId: a.userId, authorEpoch: author.raw.recordUpdateEpoch,
      source: source.source.scopeDigest }) };
}
