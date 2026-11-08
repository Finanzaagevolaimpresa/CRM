import { Prisma, type PrismaClient, type SharedOperationalUpdate, type ProjectStatus, type TechnicalPracticeStatus } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { updateActor, type UpdateCredentials } from './record-updates';
import { currentRecordUpdateUser, recordUpdatePermission, recordWritePermissions } from './record-update-context';
import { withSerializableTransaction } from './serializable';
import { confirmedReadRetry } from './confirmed-read-retry';
import { RecordUpdateError } from './record-update-contract';
import { assertTechnicalPracticeOperational } from './client-operational-hold';
import { lockAuthorizedTechnicalAssignment } from './technical-assignment-admission';
import { admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { readTechnicalAssignmentJournal } from './technical-assignment-journal';
import { withTechnicalAssignmentRecipient, technicalAssignmentClock, TechnicalAssignmentError,
  type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { sharedUpdateCommand, sharedUpdateTarget, sharedUpdateRequestDigest, sharedUpdateTransition,
  sharedUpdateStates, SharedOperationalUpdateError, type SharedUpdateCommand, type SharedUpdateTarget } from './shared-operational-update-contract';
import { sharedOperationalContext, sharedOperationalRecipients, canReadSharedOperational,
  sharedOperationalHref, sharedOperationalLinksMatch, type SharedOperationalContext, type SharedUpdatePerson } from './shared-operational-context';
import { sharedOperationalContacts } from './shared-operational-contacts';
import { sharedOperationalWritesEnabled } from './shared-operational-mode';

type Tx = Prisma.TransactionClient;
function deny(): never { throw new SharedOperationalUpdateError('DENIED'); }
function stale(): never { throw new SharedOperationalUpdateError('STALE'); }
function technicalTarget(target: SharedUpdateTarget) {
  if (target.kind === 'CLIENT') deny();
  return { kind: target.kind === 'PROJECT' ? 'Project' as const : 'TechnicalPractice' as const, targetId: target.id };
}
type Admission = { actor: SharedUpdatePerson; sessionId: string; context: SharedOperationalContext;
  assignmentRevisionId: string | null; canWrite: boolean; canChangeState: boolean;
  title: string; canReadState: boolean; tech?: TechnicalAssignmentTransaction; finish: () => Promise<Date>; binding: string };
async function technicalAdmission(tx: Tx, state: TechnicalAssignmentTransaction, target: SharedUpdateTarget, write: boolean): Promise<Admission> {
  const ref = technicalTarget(target);
  const found = await lockAuthorizedTechnicalAssignment(tx, state, ref, write);
  if (!found.journal || !found.payload.selection.actions.includes('share_update')
    || !admitsTechnicalRolePermission(state.current, ref.kind, 'share_update')) deny();
  const actor = await currentRecordUpdateUser(tx, state.current.userId);
  if (!actor) deny();
  const context = await sharedOperationalContext(tx, target, write);
  if (context.client.id !== found.context.clientId || context.projectId !== found.context.projectId) deny();
  const finish = async () => {
    const now = await technicalAssignmentClock(tx);
    if (!readTechnicalAssignmentJournal(found.journal, state.key, found.current, now)) deny();
    return now;
  };
  const binding = canonicalSha256({ context: context.binding, assignment: found.journal.revision.id,
    actorEpoch: actor.recordUpdateEpoch });
  return { actor, sessionId: state.current.sessionId!, context, assignmentRevisionId: found.journal.revision.id,
    title: found.payload.selection.readableFields.includes('title') ? context.base.label : 'Incarico tecnico',
    canReadState: found.payload.selection.readableFields.includes('status'),
    canWrite: sharedOperationalWritesEnabled, canChangeState: sharedOperationalWritesEnabled && found.payload.selection.actions.includes('update_status')
      && found.payload.selection.readableFields.includes('status')
      && admitsTechnicalRolePermission(state.current, ref.kind, 'update_status'),
    tech: state, finish, binding };
}
function admittedTransaction<T>(db: PrismaClient, claimed: AuthSession, target: SharedUpdateTarget, write: boolean,
  proof: UpdateCredentials | undefined, work: (tx: Tx, admission: Admission) => Promise<T>) {
  // The branch does not trust cached permissions: both paths reload registry,
  // account, directory and exact current context under their native locks.
  if (claimed.role !== 'admin' && claimed.role !== 'commerciale') {
    const ref = technicalTarget(target);
    return withTechnicalAssignmentRecipient(db, claimed, ref.kind, async (tx, state) =>
      work(tx, await technicalAdmission(tx, state, target, write)), { timeout: 30_000 });
  }
  return withSerializableTransaction(db, async tx => {
    if (write && !proof) deny();
    const auth = await updateActor(tx, claimed, write ? proof : undefined, { readOnly: !write });
    if (auth.actor.role !== claimed.role) deny();
    const context = await sharedOperationalContext(tx, target, write);
    if (!canReadSharedOperational(auth.actor, context)) deny();
    const canWrite = sharedOperationalWritesEnabled && auth.actor.role === 'admin' && recordUpdatePermission(auth.actor, recordWritePermissions[target.kind]);
    if (write && !canWrite) deny();
    const result = await work(tx, { actor: auth.actor, sessionId: auth.registry.id, context,
      title: context.base.label, canReadState: true,
      assignmentRevisionId: null, canWrite, canChangeState: canWrite && (target.kind !== 'PRACTICE'
        || recordUpdatePermission(auth.actor, 'technical.status')), finish: auth.finish,
      binding: canonicalSha256({ context: context.binding, actorEpoch: auth.actor.recordUpdateEpoch }) });
    await auth.finish();
    return result;
  }, { timeout: 30_000 });
}
async function commandLock(tx: Tx, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'shared-update:' + id},0))`;
}
const receipt = (row: Pick<SharedOperationalUpdate, 'id' | 'eventId' | 'createdAt'>, replayed: boolean) => ({
  commandId: row.id, updateId: row.id, eventId: row.eventId, recordedAt: row.createdAt.toISOString(), replayed,
});
async function priorReceipt(tx: Tx, actorId: string, input: SharedUpdateCommand) {
  const old = await tx.recordUpdateCommand.findUnique({ where: { id: input.commandId }, include: { operationalUpdate: true } });
  if (!old) return null;
  if (old.actorId !== actorId || old.digest !== sharedUpdateRequestDigest(input) || !old.operationalUpdate) stale();
  return receipt(old.operationalUpdate, true);
}
export async function saveSharedOperationalUpdate(db: PrismaClient, claimed: AuthSession, raw: unknown, proof?: UpdateCredentials) {
  if (!sharedOperationalWritesEnabled) deny();
  const input = sharedUpdateCommand.parse(raw);
  const saved = await admittedTransaction(db, claimed, input.target, true, proof, async (tx, a) => {
    await commandLock(tx, input.commandId);
    const prior = await priorReceipt(tx, a.actor.id, input);
    if (prior) { await a.finish(); return prior; }
    if (!a.canWrite || input.expectedContext !== a.binding || input.expectedVersion !== a.context.base.version.toISOString()) stale();
    const change = sharedUpdateTransition(input.target.kind, a.context.state, input.state);
    if (input.state !== null && !a.canChangeState) deny();
    if (input.correctionOfId) {
      const source = await tx.sharedOperationalUpdate.findUnique({ where: { id: input.correctionOfId }, include: { correction: true } });
      if (!source || source.kind !== input.target.kind || source.recordId !== input.target.id
        || !sharedOperationalLinksMatch(source, a.context) || source.correction
        || (a.actor.role !== 'admin' && source.authorId !== a.actor.id)) stale();
    }
    const recipients = await sharedOperationalRecipients(tx, a.context);
    // Never report a notified Admin if no current eligible Admin exists.
    if (!recipients.some(person => person.role === 'admin')) throw new SharedOperationalUpdateError('NOT_AVAILABLE');
    const now = await a.finish();
    const [transaction] = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT txid_current() AS id`;
    const recipientIds = recipients.map(person => ({ id: person.id, epoch: person.epoch, communication: false }));
    await tx.recordUpdateCommand.create({ data: {
      id: input.commandId, actorId: a.actor.id, actorEpoch: a.actor.recordUpdateEpoch, kind: input.target.kind,
      recordId: input.target.id, digest: sharedUpdateRequestDigest(input), operation: 'UPDATE', mode: 'CRM',
      scope: a.context.base.scope as Prisma.InputJsonValue, selection: { people: recipients.map(p => p.id), groups: [] },
      directoryBinding: canonicalSha256(recipientIds), recipients: recipientIds, transactionId: transaction.id, createdAt: now,
    } });
    await tx.recordUpdateEvent.create({ data: { id: input.commandId, kind: input.target.kind, recordId: input.target.id,
      event: 'RECORD_CHANGED', changed: ['profile'], scope: a.context.base.scope as Prisma.InputJsonValue,
      sourceKey: 'shared-update:' + input.commandId, occurredAt: now } });
    const row = await tx.sharedOperationalUpdate.create({ data: {
      id: input.commandId, eventId: input.commandId, kind: input.target.kind, recordId: input.target.id,
      clientId: a.context.client.id, projectId: a.context.projectId, practiceId: a.context.practiceId,
      authorId: a.actor.id, authorName: a.actor.name, sessionId: a.sessionId, assignmentRevisionId: a.assignmentRevisionId,
      classification: 'SHARED_OPERATIONAL', text: input.text, stateBefore: change.before, stateAfter: change.after,
      stateChanged: change.changed, nextAction: input.nextAction,
      nextActionDueOn: input.nextActionDueOn ? new Date(input.nextActionDueOn + 'T00:00:00.000Z') : null,
      correctionOfId: input.correctionOfId, createdAt: now,
    } });
    // The migration's narrow wrapper coalesces ONLY this exact status event.
    // Other records, fields, rule events and channels retain their native path.
    await tx.$queryRaw`SELECT set_config('fai.shared_operational_command',${input.commandId},true)`;
    const updatedAt = new Date(Math.max(now.getTime(), a.context.base.version.getTime() + 1));
    const where = { id: input.target.id, updatedAt: a.context.base.version };
    if (input.target.kind === 'CLIENT') await tx.client.update({ where,
      data: { ...(change.changed ? { operationalState: change.after } : {}), updatedAt } });
    else if (input.target.kind === 'PROJECT') await tx.project.update({ where,
      data: { ...(change.changed ? { status: change.after! as ProjectStatus } : {}), updatedAt } });
    else {
      if (change.changed) await assertTechnicalPracticeOperational(tx, [a.context.client.id], change.after!);
      await tx.technicalPractice.update({ where, data: { ...(change.changed ? { status: change.after! as TechnicalPracticeStatus } : {}), updatedAt } });
    }
    for (const person of recipients) await tx.recordUpdateDelivery.create({ data: {
      eventId: row.eventId, commandId: row.id, recipientId: person.id, recipientEpoch: person.epoch, mode: 'CRM',
    } });
    await tx.auditLog.create({ data: { id: 'shared-operational:' + row.id, actorId: a.actor.id, entityType: 'SharedOperationalUpdate', entityId: row.id,
      event: input.correctionOfId ? 'shared_operational_update_corrected' : 'shared_operational_update_recorded',
      before: { state: change.before, correctionOfId: input.correctionOfId },
      after: { state: change.after, stateChanged: change.changed, source: 'EXPLICIT_OPERATIONAL_UPDATE',
        commandId: row.id, eventId: row.eventId, requestHash: sharedUpdateRequestDigest(input),
        sessionId: a.sessionId, assignmentRevisionId: a.assignmentRevisionId,
        recipientCount: recipients.length, mode: 'CRM_ONLY' } } });
    // Surface deferred invariant failures inside the callback; never return a
    // successful receipt for a transaction whose COMMIT is rejected.
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    await a.finish();
    return receipt(row, false);
  });
  const persisted = await db.sharedOperationalUpdate.findUnique({ where: { id: input.commandId },
    select: { id: true, eventId: true, createdAt: true, authorId: true } });
  if (!persisted || persisted.authorId !== claimed.userId || persisted.eventId !== saved.eventId)
    throw new Error('SHARED_OPERATIONAL_RESULT_NOT_PERSISTED');
  return receipt(persisted, saved.replayed);
}

/** Opaque outcome reconciliation remains possible after reassignment/revocation.
 * A current registry session and the same author+request are still necessary.
 * ReadCommitted + command lock observes a commit that finished while waiting. */
export async function settleSharedOperationalReceipt(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  if (!sharedOperationalWritesEnabled) deny();
  const input = z.object({ commandId: z.string().uuid(), target: sharedUpdateTarget }).strict().parse(raw);
  return db.$transaction(async tx => {
    const auth = await updateActor(tx, claimed);
    await commandLock(tx, input.commandId);
    const old = await tx.recordUpdateCommand.findUnique({ where: { id: input.commandId }, include: { operationalUpdate: true } });
    if (old && (old.actorId !== auth.actor.id || old.kind !== input.target.kind || old.recordId !== input.target.id)) deny();
    if (old?.operationalUpdate) {
      await auth.finish();
      return { status: 'RECORDED' as const, receipt: receipt(old.operationalUpdate, true) };
    }
    if (old && old.operation !== 'CLOSE_ATTEMPT') deny();
    if (!old) {
      // The same immutable command PK closes even a request arriving late,
      // after a lost response. A negative result is durable, not a snapshot.
      const now = await auth.finish(), digest = canonicalSha256({ protocol: 'FAI_SHARED_OPERATIONAL_CLOSED_V1', ...input, actorId: auth.actor.id });
      const [transaction] = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT txid_current() AS id`;
      await tx.recordUpdateCommand.create({ data: { id: input.commandId, actorId: auth.actor.id,
        actorEpoch: auth.actor.recordUpdateEpoch, kind: input.target.kind, recordId: input.target.id, digest,
        operation: 'CLOSE_ATTEMPT', mode: 'CRM', scope: { protocol: 'FAI_SHARED_OPERATIONAL_CLOSED_V1' },
        selection: { people: [], groups: [] }, directoryBinding: digest, recipients: [],
        transactionId: transaction.id, createdAt: now } });
      await tx.auditLog.create({ data: { id: 'shared-operational:' + input.commandId, actorId: auth.actor.id, entityType: 'RecordUpdateCommand', entityId: input.commandId,
        event: 'shared_operational_attempt_closed', after: { commandId: input.commandId, sessionId: auth.registry.id,
          status: 'CLOSED_WITHOUT_UPDATE', mode: 'CRM_ONLY' } } });
    }
    await auth.finish();
    return { status: 'CLOSED_WITHOUT_UPDATE' as const, receipt: null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
}

async function admittedHistory(tx: Tx, a: Admission) {
  const target = a.context.target;
  const where = target.kind === 'CLIENT' ? { clientId: target.id }
    : target.kind === 'PROJECT' ? { projectId: target.id } : { practiceId: target.id };
  const result = [];
  const finalAdmissions = new Map<string, () => Promise<Date>>();
  let cursor: string | undefined, scanned = 0;
  // Filter before returning any title/body/count. Bounded scanning fails closed
  // instead of returning a silently incomplete history.
  while (true) {
    const rows = await tx.sharedOperationalUpdate.findMany({ where, take: 100,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { correction: { select: { id: true } } } });
    for (const row of rows) {
      if (++scanned > 2000) throw new SharedOperationalUpdateError('NOT_AVAILABLE');
      const source = sharedUpdateTarget.parse({ kind: row.kind, id: row.recordId });
      let context: SharedOperationalContext, sourceLabel: string, stateVisible = true;
      try {
        context = source.kind === target.kind && source.id === target.id ? a.context : await sharedOperationalContext(tx, source);
        if (!sharedOperationalLinksMatch(row, context)) continue;
        if (a.tech) {
          const access = await technicalAdmission(tx, a.tech, source, false);
          await access.finish();
          finalAdmissions.set(source.kind + ':' + source.id, access.finish);
          sourceLabel = access.title;
          stateVisible = access.canReadState;
        } else if (!canReadSharedOperational(a.actor, context)) continue;
        else sourceLabel = context.base.label;
      } catch (error) {
        if (error instanceof SharedOperationalUpdateError || error instanceof TechnicalAssignmentError || error instanceof RecordUpdateError) continue;
        throw error;
      }
      result.push({ id: row.id, eventId: row.eventId, source, sourceLabel,
        href: sharedOperationalHref(source), authorName: row.authorName, createdAt: row.createdAt.toISOString(),
        text: row.text, stateBefore: stateVisible ? row.stateBefore : null, stateAfter: stateVisible ? row.stateAfter : null,
        stateChanged: stateVisible && row.stateChanged,
        nextAction: row.nextAction, nextActionDueOn: row.nextActionDueOn?.toISOString().slice(0, 10) ?? null,
        correctionOfId: row.correctionOfId, correctedById: row.correction?.id ?? null,
        canCorrect: a.canWrite && !row.correction && row.kind === target.kind && row.recordId === target.id
          && (a.actor.role === 'admin' || row.authorId === a.actor.id) });
    }
    if (rows.length < 100) break;
    cursor = rows.at(-1)!.id;
  }
  return { rows: result, finish: async () => { for (const check of finalAdmissions.values()) await check(); } };
}
export async function readSharedOperationalPanel(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const target = sharedUpdateTarget.parse(raw);
  return confirmedReadRetry(() => admittedTransaction(db, claimed, target, false, undefined, async (tx, a) => {
    const history = await admittedHistory(tx, a);
    const contacts = await sharedOperationalContacts(tx, a.context);
    const recipients = a.canWrite ? await sharedOperationalRecipients(tx, a.context) : [];
    await history.finish();
    const now = await a.finish();
    return { target, title: a.title, expectedContext: a.binding,
      expectedVersion: a.context.base.version.toISOString(), currentState: a.canReadState ? a.context.state : null,
      stateVisible: a.canReadState,
      canWrite: a.canWrite, writesAvailable: sharedOperationalWritesEnabled,
      states: a.canChangeState ? [...sharedUpdateStates(target.kind)] : [],
      recipients: recipients.map(({ name, role }) => ({ name, role })),
      missingCommercial: a.canWrite && !recipients.some(person => person.role === 'commerciale'),
      history: history.rows, contacts, serverTime: now.toISOString() };
  }));
}
export type SharedOperationalPanel = Awaited<ReturnType<typeof readSharedOperationalPanel>>;
