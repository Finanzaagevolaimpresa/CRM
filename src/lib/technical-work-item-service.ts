import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { isFinancialDocument } from './financial-privacy-policy';
import { lockAuthorizedTechnicalAssignment } from './technical-assignment-admission';
import { assertTechnicalAssignmentDocuments } from './technical-assignment-documents';
import { technicalTargetReference, type TechnicalTargetReference } from './technical-assignment-display';
import { readRetainedTechnicalAssignmentJournal, readTechnicalAssignmentJournal } from './technical-assignment-journal';
import { admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { loadTechnicalAssignmentDecisionJournal } from './technical-assignment-storage';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentRecipient, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { technicalWorkItemCommand, technicalWorkItemReceipt, readTechnicalWorkItemReceipt,
  signTechnicalWorkItemReceipt, technicalWorkItemRequestDigest, readTechnicalWorkItemPreview } from './technical-work-item-command';
import { technicalWorkItemContext } from './technical-work-item-context';
import { projectTechnicalWorkItem, technicalWorkItemSelection } from './technical-work-item-contract';
import type { TechnicalWorkItemIdentity } from './technical-work-item-generation';
import { previewTechnicalWorkItemChange, confirmTechnicalWorkItemChange, type LockedTechnicalWorkItemSnapshot } from './technical-work-item-plan';
import { lockTechnicalWorkItemSource } from './technical-work-item-source';

type Tx = Prisma.TransactionClient;
function denied(): never { throw new TechnicalAssignmentError('DENIED'); }
function stale(): never { throw new TechnicalAssignmentError('STALE'); }
function unavailable(): never { throw new TechnicalAssignmentError('UNAVAILABLE'); }
const referenceSchema = z.object({ kind: z.enum(['Task', 'ChecklistItem']), itemId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();

async function lockedSnapshot(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference,
  reference: TechnicalWorkItemIdentity, write = false) {
  const found = await lockAuthorizedTechnicalAssignment(tx, state, target);
  const choice = found.payload.selection.workItems?.find(item => item.kind === reference.kind && item.itemId === reference.itemId);
  const action = reference.kind === 'Task' ? 'manage_deadlines' : 'manage_checklist';
  if (!choice || !found.payload.selection.actions.includes(action) || !admitsTechnicalRolePermission(state.current, target.kind, action)) denied();
  const source = await lockTechnicalWorkItemSource(tx, state, found.context, reference, found.payload.selection.documents, write);
  if (source.scopeSha256 !== choice.scopeSha256 || source.epoch.scopeGeneration !== choice.scopeGeneration) stale();
  const documents = await assertTechnicalAssignmentDocuments(tx, state, found.context, found.payload.selection.documents);
  const link = { bindingId: found.record.id, target, itemId: choice.itemId, kind: choice.kind,
    revision: found.record.revision, retainedPersonalDecision: true, itemScopeGeneration: choice.scopeGeneration };
  const context = technicalWorkItemContext(source.parent, source.item, link);
  if (!context) denied();
  const selection = technicalWorkItemSelection.parse({ kind: choice.kind, itemId: choice.itemId, target,
    recipientId: state.current.userId, contextSha256: context.contextSha256,
    readableFields: choice.readableFields, editableFields: choice.editableFields });
  const snapshot: LockedTechnicalWorkItemSnapshot = { current: found.current, assignment: found.payload.selection,
    parent: source.parent, item: source.item, link, selection,
    row: { id: choice.itemId, version: source.epoch.generation, values: source.values },
    admission: { target, actorId: state.current.userId, sessionId: state.current.sessionId!,
      assignmentId: found.record.id, assignmentRevision: found.record.revision, assignmentStateSha256: found.record.stateSha256,
      authorityRevision: state.authority.revision, actorEpoch: state.actor.recordUpdateEpoch, authorEpoch: state.author.recordUpdateEpoch,
      keyVersion: state.key.version, bindingId: found.record.id, bindingRevision: found.record.revision,
      kind: choice.kind, itemId: choice.itemId, contextSha256: context.contextSha256, selectionSha256: canonicalSha256(selection),
      itemVersion: source.epoch.generation, validUntil: Math.min(state.current.expiresAt * 1000,
        state.current.registryExpiresAt.getTime(), Date.parse(found.payload.selection.expiresAt), documents.validUntil) } };
  return { found, source, snapshot };
}

async function outcome(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference, commandId: string, requestDigest?: string) {
  const rows = await tx.$queryRaw<Array<{ receipt: unknown; proof: string; assignmentId: string; assignmentRevision: number }>>`
    SELECT receipt,proof,"assignmentId","assignmentRevision" FROM "TechnicalWorkItemCommand" WHERE id=${commandId}::uuid FOR SHARE`;
  if (!rows.length) return null;
  if (rows.length !== 1) unavailable();
  const row = rows[0], now = await technicalAssignmentClock(tx);
  const receipt = readTechnicalWorkItemReceipt(state.key, row.receipt, row.proof,
    { commandId, actorId: state.current.userId, sessionId: state.current.sessionId!, target, requestDigest }, now);
  if (!receipt || receipt.assignmentId !== row.assignmentId || receipt.assignmentRevision !== row.assignmentRevision
    || receipt.bindingId !== row.assignmentId || receipt.bindingRevision !== row.assignmentRevision) stale();
  const revisions = await tx.$queryRaw<Array<{ commandId: string }>>`SELECT "commandId" FROM "TechnicalAssignmentRevision"
    WHERE "assignmentId"=${receipt.assignmentId}::uuid AND revision=${receipt.assignmentRevision}`;
  if (revisions.length !== 1) unavailable();
  const retained = readRetainedTechnicalAssignmentJournal(await loadTechnicalAssignmentDecisionJournal(tx, revisions[0].commandId), state.key, now);
  const selection = retained?.assignment.payload.selection;
  const item = selection?.workItems?.find(picked => picked.kind === receipt.kind && picked.itemId === receipt.itemId);
  if (!retained || retained.decision.operation !== 'ASSIGN' || selection?.userId !== receipt.actorId || !item
    || retained.assignment.payload.targetId !== target.targetId || selection.kind !== target.kind
    || !selection.actions.includes(receipt.kind === 'Task' ? 'manage_deadlines' : 'manage_checklist')
    || item.editableFields.length < receipt.fieldCount) unavailable();
  const audit = await tx.auditLog.findUnique({ where: { id: commandId }, select: { actorId: true, entityType: true,
    entityId: true, event: true, before: true, after: true } });
  if (!audit || audit.actorId !== receipt.actorId || audit.event !== 'technical_work_item_recorded'
    || audit.entityType !== 'TechnicalWorkItemCommand' || audit.entityId !== commandId
    || canonicalSha256(audit.before) !== canonicalSha256({})
    || canonicalSha256(audit.after) !== canonicalSha256({ action: 'update_fields', fieldCount: receipt.fieldCount })) unavailable();
  return receipt;
}

function project(locked: Awaited<ReturnType<typeof lockedSnapshot>>, now: Date) {
  const s = locked.snapshot;
  const fields = projectTechnicalWorkItem(s.current, s.assignment, s.selection, { target: s.parent.target,
    kind: s.item.kind, itemId: s.item.id, contextSha256: s.selection.contextSha256,
    active: s.item.active, archived: !s.parent.operational, financialRestricted: s.item.financialRestricted }, s.row.values, now);
  if (!fields) denied();
  return { kind: s.item.kind, itemId: s.item.id, fields, editableFields: s.selection.editableFields,
    assignmentId: s.admission.assignmentId, assignmentRevision: s.admission.assignmentRevision,
    bindingId: s.admission.bindingId, bindingRevision: s.admission.bindingRevision,
    expectedContextSha256: s.admission.contextSha256, expectedItemVersion: s.admission.itemVersion };
}

/** GET never repairs generations, creates receipts or writes an acknowledgement. */
export async function readTechnicalWorkItem(db: PrismaClient, claimed: AuthSession, rawTarget: TechnicalTargetReference, raw: TechnicalWorkItemIdentity) {
  const target = technicalTargetReference.parse(rawTarget), reference = referenceSchema.parse(raw);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const locked = await lockedSnapshot(tx, state, target, reference), now = await technicalAssignmentClock(tx);
    if (!readTechnicalAssignmentJournal(locked.found.journal, state.key, locked.found.current, now)) denied();
    return project(locked, now);
  });
}

export async function listTechnicalWorkItemsInTransaction(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference) {
    const assignment = await lockAuthorizedTechnicalAssignment(tx, state, target);
    const records = [];
    for (const choice of [...(assignment.payload.selection.workItems ?? [])].sort((a, b) => `${a.kind}:${a.itemId}`.localeCompare(`${b.kind}:${b.itemId}`))) {
      try {
        const locked = await lockedSnapshot(tx, state, target, choice);
        records.push(project(locked, await technicalAssignmentClock(tx)));
      } catch (error) { if (!(error instanceof TechnicalAssignmentError && ['DENIED', 'STALE'].includes(error.code))) throw error; }
    }
    if (!readTechnicalAssignmentJournal(assignment.journal, state.key, assignment.current, await technicalAssignmentClock(tx))) denied();
    return records;
}

export async function previewTechnicalWorkItem(db: PrismaClient, claimed: AuthSession, rawTarget: TechnicalTargetReference, raw: unknown) {
  const target = technicalTargetReference.parse(rawTarget), command = technicalWorkItemCommand.parse(raw);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const locked = await lockedSnapshot(tx, state, target, command);
    const prepared = previewTechnicalWorkItemChange(state.key, locked.snapshot, command, await technicalAssignmentClock(tx));
    if (!prepared || isFinancialDocument({ title: prepared.after.title ?? locked.source.values.title })) denied();
    return { target, ...prepared };
  });
}

export async function confirmTechnicalWorkItem(db: PrismaClient, claimed: AuthSession, rawTarget: TechnicalTargetReference,
  raw: unknown, token: string, confirmed: boolean) {
  if (confirmed !== true || typeof token !== 'string' || token.length > 48_000) denied();
  const target = technicalTargetReference.parse(rawTarget), command = technicalWorkItemCommand.parse(raw);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const digest = technicalWorkItemRequestDigest(target, command);
    const previous = await outcome(tx, state, target, command.commandId, digest);
    if (previous) return previous;
    const locked = await lockedSnapshot(tx, state, target, command, true);
    const plan = confirmTechnicalWorkItemChange(state.key, locked.snapshot, command, token, confirmed, await technicalAssignmentClock(tx));
    if (!plan || isFinancialDocument({ title: plan.after.title ?? locked.source.values.title })) stale();
    const assignments = Object.entries(plan.after).map(([field, value]) => {
      // Closed field names already validated by the pure plan; explicit switch
      // also protects this SQL boundary from accidental future contract widening.
      if (!['title', 'notes', 'description', 'priority', 'dueAt'].includes(field)) denied();
      const column = Prisma.raw(`"${field}"`);
      if (field === 'priority') return Prisma.sql`${column}=${value}::"TaskPriority"`;
      if (field === 'dueAt') return Prisma.sql`${column}=${value === null ? null : new Date(value)}`;
      return Prisma.sql`${column}=${value}`;
    });
    const table = command.kind === 'Task' ? 'Task' : 'DocumentChecklistItem';
    const updated = await tx.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET ${Prisma.join(assignments)},
      "updatedAt"=GREATEST(clock_timestamp(),"updatedAt"+interval '1 millisecond') WHERE id=${command.itemId}`);
    if (updated !== 1) stale();
    const current = await lockTechnicalWorkItemSource(tx, state, locked.found.context, command, locked.found.payload.selection.documents, true);
    if (current.epoch.generation !== plan.itemVersion || current.scopeSha256 !== locked.source.scopeSha256) stale();
    await assertTechnicalAssignmentDocuments(tx, state, locked.found.context, locked.found.payload.selection.documents);
    const now = await technicalAssignmentClock(tx);
    if (!readTechnicalAssignmentJournal(locked.found.journal, state.key, locked.found.current, now)
      || !readTechnicalWorkItemPreview(state.key, token, locked.snapshot.admission, now.getTime())) stale();
    const receipt = technicalWorkItemReceipt.parse({ protocol: 'TECHNICAL_WORK_ITEM_RECEIPT_V1', commandId: command.commandId,
      actorId: state.current.userId, sessionId: state.current.sessionId!, target, assignmentId: command.assignmentId,
      assignmentRevision: command.assignmentRevision, bindingId: command.bindingId, bindingRevision: command.bindingRevision,
      kind: command.kind, itemId: command.itemId, action: command.action, fieldCount: Object.keys(plan.after).length,
      requestDigest: digest, previousItemVersion: plan.previousItemVersion, itemVersion: plan.itemVersion,
      recordedAt: now.toISOString(), keyVersion: state.key.version });
    const proof = signTechnicalWorkItemReceipt(state.key, receipt);
    await tx.$executeRaw`INSERT INTO "TechnicalWorkItemCommand" (id,"assignmentId","assignmentRevision","actorId","sessionId",
      "targetKind","targetId",kind,"itemId","requestDigest",receipt,proof)
      VALUES (${command.commandId}::uuid,${command.assignmentId}::uuid,${command.assignmentRevision},${state.current.userId},
      ${state.current.sessionId}::uuid,${target.kind},${target.targetId},${command.kind},${command.itemId},${digest},${JSON.stringify(receipt)}::jsonb,${proof})`;
    await tx.auditLog.create({ data: { id: command.commandId, actorId: state.current.userId, event: 'technical_work_item_recorded',
      entityType: 'TechnicalWorkItemCommand', entityId: command.commandId, before: {}, after: { action: 'update_fields', fieldCount: receipt.fieldCount } } });
    const saved = await outcome(tx, state, target, command.commandId, digest);
    if (!saved) unavailable();
    return saved;
  });
}

/** The retained outcome survives revocation but reveals no old field content. */
export async function readTechnicalWorkItemOutcome(db: PrismaClient, claimed: AuthSession, rawTarget: TechnicalTargetReference, commandId: string) {
  const target = technicalTargetReference.parse(rawTarget);
  z.string().uuid().parse(commandId);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const receipt = await outcome(tx, state, target, commandId);
    return receipt ? { status: 'RECORDED' as const, receipt } : { status: 'NOT_OBSERVED' as const };
  });
}
