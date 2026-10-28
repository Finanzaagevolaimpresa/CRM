import { signRecordReminderPreview } from './record-reminder-preview-token';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { RecordUpdateError, resolveUpdateSelection } from './record-update-contract';
import { parseRecordReminder, prepareRecordReminder } from './record-reminder-contract';
import { updateActor, updateDirectory, type UpdateCredentials } from './record-updates';
import { lockRecordReminderSource } from './record-reminder-source';
import { lockReminderPrincipals, reminderAuthorAdmission, ordinaryReminderAdmission, technicalReminderAdmission } from './record-reminder-principal';
import { confirmedReadRetry } from './confirmed-read-retry';

/** Read-only, personally authenticated preview. No Task, record-update event,
 * delivery, receipt, audit, scheduler or grant is written by this service. */
export async function previewRecordReminder(db: PrismaClient, claimed: AuthSession, credentials: UpdateCredentials, raw: unknown) {
  const input = parseRecordReminder(raw);
  return confirmedReadRetry(() => db.$transaction(async tx => {
    if (!await lockRegisteredPrivilegedStepUpKey(tx, credentials.key)) throw new RecordUpdateError('DENIED');
    await lockCommunicationDirectory(tx);
    const directory = await updateDirectory(tx), resolved = resolveUpdateSelection(input.selection, directory);
    const principals = await lockReminderPrincipals(tx, claimed.userId, resolved.people.map(person => person.id));
    const auth = await updateActor(tx, claimed, credentials);
    const author = principals.principals.get(auth.actor.id);
    if (auth.actor.role !== 'admin' || !author) throw new RecordUpdateError('DENIED');
    const locked = await lockRecordReminderSource(tx, { key: credentials.key, recipient: author.raw }, input);
    const authorAccess = reminderAuthorAdmission(principals, locked);
    if (!authorAccess) throw new RecordUpdateError('DENIED');
    const now = await auth.finish();
    const recipients = [];
    for (const person of resolved.people) {
      const current = principals.principals.get(person.id);
      if (!current) continue;
      // A private source is not read through the legacy path. In every other
      // case the same principal must pass the current existing policy.
      const admission = (person.id === author.raw.id ? authorAccess : null)
        ?? ordinaryReminderAdmission(locked, current.ordinary)
        ?? await technicalReminderAdmission(tx, credentials.key, principals, locked, person.id, now);
      if (admission) recipients.push(admission);
    }
    const prepared = prepareRecordReminder(input, { now: now.toISOString(), source: locked.source, directory, recipients,
      actor: { id: auth.actor.id, epoch: auth.actor.recordUpdateEpoch, sessionId: auth.registry.id, role: auth.actor.role,
        active: auth.actor.active, sessionLive: true, canWriteRecord: true, canReadTaskDeadline: true,
        accessBinding: authorAccess.accessBinding }, policyExpiresAt: null });
    const finishedAt = await auth.finish();
    const accessUntil = Math.min(claimed.expiresAt * 1000, auth.registry.expiresAt.getTime(),
      ...prepared.recipients.flatMap(person => person.accessUntil ? [Date.parse(person.accessUntil)] : []));
    return { prepared, signed: signRecordReminderPreview(credentials.key, prepared, finishedAt, accessUntil),
      recipients: resolved.people.map(person => ({ id: person.id, name: person.name,
        admitted: prepared.recipients.some(row => row.id === person.id),
        reason: prepared.excluded.find(row => row.id === person.id)?.reason ?? null })) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }));
}
