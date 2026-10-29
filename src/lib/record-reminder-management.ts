import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { confirmedReadRetry } from './confirmed-read-retry';
import { canonicalSha256 } from './canonical-json';
import { RecordUpdateError } from './record-update-contract';
import { recordUpdateContext, recordUpdatePermission, recordWritePermissions } from './record-update-context';
import { updateActor, updateDirectory } from './record-updates';
import { lockReminderPrincipals, reminderAuthorAdmission, ordinaryReminderAdmission, technicalReminderAdmission } from './record-reminder-principal';
import { lockRecordReminderSource } from './record-reminder-source';
import { readRecordReminderWorkJournal } from './record-reminder-delivery';
import { readRetainedReminderCancellation } from './record-reminder-revocation';
import { recordReminderAvailability, type ReminderAvailability } from './record-reminder-contract';
import { recordUpdateWorkInclude } from './record-update-admission';
import { TechnicalAssignmentError } from './technical-assignment-errors';

const identifier = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const reminderTargetSchema = z.object({ kind: z.enum(['CLIENT', 'PROJECT', 'PRACTICE']), recordId: identifier }).strict();
export type ReminderTarget = z.infer<typeof reminderTargetSchema>;
const catalogueQuery = z.object({ query: z.string().trim().max(120).default(''),
  page: z.number().int().min(1).max(100).default(1) }).strict();
const pageSize = 25;
function denied(): never { throw new RecordUpdateError('DENIED'); }
function unavailable(error: unknown) {
  return (error instanceof RecordUpdateError || error instanceof TechnicalAssignmentError)
    && ['DENIED', 'STALE'].includes(error.code);
}
const transaction = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 };

/** Admin-only catalogue. Parent, Task and personal authority are admitted before
 * pagination; inaccessible titles, IDs and counts are not returned. No GET writes. */
export async function readRecordReminderSetup(db: PrismaClient, claimed: AuthSession, key: PrivilegedStepUpKey,
  raw: unknown, query: unknown = {}) {
  const target = reminderTargetSchema.parse(raw), search = catalogueQuery.parse(query);
  return confirmedReadRetry(() => db.$transaction(async tx => {
    if (!await lockRegisteredPrivilegedStepUpKey(tx, key)) denied();
    await lockCommunicationDirectory(tx);
    const principals = await lockReminderPrincipals(tx, claimed.userId, []);
    const auth = await updateActor(tx, claimed), author = principals.principals.get(auth.actor.id);
    if (auth.actor.role !== 'admin' || !author || !recordUpdatePermission(auth.actor, 'service.write')
      || !recordUpdatePermission(auth.actor, recordWritePermissions[target.kind])) denied();
    const context = await recordUpdateContext(tx, target.kind, target.recordId);
    if (!context.canRead(auth.actor) || !context.clientId) denied();
    const candidates: Array<{ id: string; title: string; dueAt: string; status: string }> = [];
    let cursor: string | undefined;
    while (candidates.length <= search.page * pageSize) {
      const batch = await tx.task.findMany({ where: { clientId: context.clientId, deletedAt: null,
        status: { in: ['aperta', 'in_lavorazione'] }, dueAt: { not: null },
        ...(search.query ? { title: { contains: search.query, mode: 'insensitive' } } : {}) },
        select: { id: true }, orderBy: { id: 'asc' }, take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      for (const candidate of batch) {
        try {
          const source = await lockRecordReminderSource(tx, { key, recipient: author.raw }, { ...target, taskId: candidate.id });
          if (reminderAuthorAdmission(principals, source)) candidates.push({ id: source.task.id,
            title: source.task.title, dueAt: source.source.dueAt, status: source.task.status });
        } catch (error) { if (!unavailable(error)) throw error; }
        if (candidates.length > search.page * pageSize) break;
      }
      if (batch.length < 100) break;
      cursor = batch.at(-1)!.id;
    }
    const people = (await updateDirectory(tx)).filter(person => person.active && !person.deleted)
      .map(({ id, name, email, role }) => ({ id, name, email, role }));
    await auth.finish();
    return { target, label: context.label, href: context.href, people, query: search.query, page: search.page,
      hasNext: candidates.length > search.page * pageSize,
      tasks: candidates.slice((search.page - 1) * pageSize, search.page * pageSize) };
  }, transaction));
}

type State = ReminderAvailability['state'] | 'CANCELED';
/** Retained management is confined to the command's current Admin author.
 * Source/people labels are omitted when its current source authority is absent.
 * Read receipts remain historical facts even if later availability is suppressed. */
export async function readRecordReminderManagement(db: PrismaClient, claimed: AuthSession,
  key: PrivilegedStepUpKey, commandId: string) {
  z.string().uuid().parse(commandId);
  return confirmedReadRetry(() => db.$transaction(async tx => {
    if (!await lockRegisteredPrivilegedStepUpKey(tx, key)) denied();
    await lockCommunicationDirectory(tx);
    const works = await tx.recordUpdateDelivery.findMany({ where: { commandId,
      command: { actorId: claimed.userId, operation: 'REMINDER' } }, include: recordUpdateWorkInclude, orderBy: { id: 'asc' } });
    const journal = works[0] ? await readRecordReminderWorkJournal(tx, key, works[0]) : null;
    const principals = await lockReminderPrincipals(tx, claimed.userId, journal?.prepared.recipients.map(row => row.id) ?? []);
    const auth = await updateActor(tx, claimed);
    if (auth.actor.role !== 'admin') denied();
    if (!journal || journal.prepared.authorId !== auth.actor.id) { await auth.finish(); return null; }
    const p = journal.prepared, author = principals.principals.get(auth.actor.id);
    if (!author || works.length !== p.recipients.length) denied();
    for (const work of works) if (!await readRecordReminderWorkJournal(tx, key, work)) denied();
    const canceled = await readRetainedReminderCancellation(tx, key, commandId);
    if (canceled && (canceled.actorId !== auth.actor.id || canceled.reminderDigest !== journal.commandDigest)) denied();
    let source: Awaited<ReturnType<typeof lockRecordReminderSource>> | null = null;
    try { source = await lockRecordReminderSource(tx, { key, recipient: author.raw }, p.input); }
    catch (error) { if (!unavailable(error)) throw error; }
    const authorAccess = source ? reminderAuthorAdmission(principals, source) : null;
    const sourceCurrent = Boolean(authorAccess && source && canonicalSha256({ kind: source.source.kind,
      recordId: source.source.recordId, taskId: source.source.taskId, generation: source.source.generation,
      scopeGeneration: source.source.scopeGeneration, dueAt: source.source.dueAt, scopeDigest: source.source.scopeDigest }) === canonicalSha256(p.source));
    const directory = await updateDirectory(tx), now = await auth.finish();
    const admissions = new Map<string, Awaited<ReturnType<typeof technicalReminderAdmission>>>();
    if (source && authorAccess) for (const work of works) {
      const person = principals.principals.get(work.recipientId);
      if (!person) continue;
      admissions.set(person.raw.id, (person.raw.id === author.raw.id ? authorAccess : null)
        ?? ordinaryReminderAdmission(source, person.ordinary)
        ?? await technicalReminderAdmission(tx, key, principals, source, person.raw.id, now));
    }
    const finishedAt = await auth.finish();
    const recipients = works.map(work => {
      const admission = admissions.get(work.recipientId);
      let status: ReminderAvailability = { state: 'SUPPRESSED', reason: 'NO_CURRENT_ACCESS' };
      if (source && authorAccess && admission) status = recordReminderAvailability(p, { now: finishedAt.toISOString(),
        source: source.source, authorId: author.raw.id, authorEpoch: author.raw.recordUpdateEpoch,
        authorAuthorized: true, authorAccessBinding: authorAccess.accessBinding, policyRevoked: Boolean(canceled),
        directory, recipient: admission, readAt: work.readAt?.toISOString() ?? null });
      const state: State = canceled ? 'CANCELED' : status.state;
      return { name: sourceCurrent ? directory.find(person => person.id === work.recipientId)?.name ?? 'Persona non disponibile' : null,
        state, readAt: work.readAt?.toISOString() ?? null };
    });
    return { commandId, kind: p.input.kind, registeredAt: journal.confirmedAt, remindAt: p.input.remindAt,
      dueAt: sourceCurrent ? p.source.dueAt : null, taskTitle: sourceCurrent ? source!.task.title : null,
      recordHref: sourceCurrent ? (p.input.kind === 'CLIENT' ? '/clients/' : p.input.kind === 'PROJECT' ? '/projects/' : '/technical-office/practices/') + p.input.recordId : null,
      canceledAt: canceled?.canceledAt ?? null, recipients, emailSent: false as const };
  }, transaction));
}

export async function listRecordReminderManagement(db: PrismaClient, claimed: AuthSession,
  key: PrivilegedStepUpKey, page = 1) {
  catalogueQuery.shape.page.parse(page);
  const ids = await confirmedReadRetry(() => db.$transaction(async tx => {
    if (!await lockRegisteredPrivilegedStepUpKey(tx, key)) denied();
    const auth = await updateActor(tx, claimed);
    if (auth.actor.role !== 'admin') denied();
    const commands = await tx.recordUpdateCommand.findMany({ where: { actorId: auth.actor.id, operation: 'REMINDER' },
      select: { id: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize + 1 });
    await auth.finish(); return commands;
  }, transaction));
  const rows = [];
  for (const command of ids.slice(0, pageSize)) {
    const row = await readRecordReminderManagement(db, claimed, key, command.id);
    if (row) rows.push(row);
  }
  await confirmedReadRetry(() => db.$transaction(async tx => { const auth = await updateActor(tx, claimed); await auth.finish(); }, transaction));
  return { rows, page, hasNext: ids.length > pageSize };
}
