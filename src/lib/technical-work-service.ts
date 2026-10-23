import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { lockAuthorizedTechnicalAssignment } from './technical-assignment-access';
import { assertTechnicalAssignmentDocuments } from './technical-assignment-documents';
import { technicalFieldPreview, technicalTargetReference, type TechnicalTargetReference } from './technical-assignment-display';
import { readRetainedTechnicalAssignmentJournal, readTechnicalAssignmentJournal } from './technical-assignment-journal';
import { admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { technicalAssignmentProof } from './technical-assignment-proof';
import { loadTechnicalAssignmentDecisionJournal } from './technical-assignment-storage';
import { technicalAssignmentTargetFields, technicalWorkTargetDigest } from './technical-assignment-target';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentRecipient, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { createTechnicalWorkPreview, readTechnicalWorkPreview, technicalWorkCommand, technicalWorkReceipt,
  technicalWorkRequestDigest, validateTechnicalWorkPatch, verifyTechnicalWorkReceipt,
  type TechnicalWorkAdmission } from './technical-work-contract';

type Tx = Prisma.TransactionClient;
function denied(): never { throw new TechnicalAssignmentError('DENIED'); }
function stale(): never { throw new TechnicalAssignmentError('STALE'); }
function unavailable(): never { throw new TechnicalAssignmentError('UNAVAILABLE'); }

async function lockedWork(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference, write: boolean) {
  const assignment = await lockAuthorizedTechnicalAssignment(tx, state, target, write);
  const row = await technicalAssignmentTargetFields(tx, target);
  const documents = await assertTechnicalAssignmentDocuments(tx, state, assignment.context, assignment.payload.selection.documents);
  const admission: TechnicalWorkAdmission = { target, actorId: state.current.userId, sessionId: state.current.sessionId!,
    assignmentId: assignment.record.id, assignmentRevision: assignment.record.revision,
    assignmentStateSha256: assignment.record.stateSha256, authorityRevision: state.authority.revision,
    actorEpoch: state.actor.recordUpdateEpoch, authorEpoch: state.author.recordUpdateEpoch, keyVersion: state.key.version,
    contextSha256: assignment.context.contextSha256, targetSha256: technicalWorkTargetDigest(target, row.updatedAt),
    validUntil: Math.min(state.current.expiresAt * 1000, state.current.registryExpiresAt.getTime(),
      Date.parse(assignment.payload.selection.expiresAt), documents.validUntil) };
  return { assignment, row, admission };
}

async function outcome(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference,
  commandId: string, requestDigest?: string) {
  const rows = await tx.$queryRaw<Array<{ receipt: unknown; proof: string; assignmentId: string; assignmentRevision: number }>>`
    SELECT receipt,proof,"assignmentId","assignmentRevision" FROM "TechnicalWorkCommand" WHERE id=${commandId}::uuid FOR SHARE`;
  if (!rows.length) return null;
  if (rows.length !== 1) unavailable();
  const row = rows[0], now = await technicalAssignmentClock(tx);
  const receipt = verifyTechnicalWorkReceipt(row.receipt, row.proof, state.key, { commandId,
    actorId: state.current.userId, sessionId: state.current.sessionId!, target, requestDigest }, now);
  if (!receipt || receipt.assignmentId !== row.assignmentId || receipt.assignmentRevision !== row.assignmentRevision) stale();
  const revisions = await tx.$queryRaw<Array<{ commandId: string }>>`SELECT "commandId" FROM "TechnicalAssignmentRevision"
    WHERE "assignmentId"=${receipt.assignmentId}::uuid AND revision=${receipt.assignmentRevision}`;
  if (revisions.length !== 1) unavailable();
  const journal = readRetainedTechnicalAssignmentJournal(await loadTechnicalAssignmentDecisionJournal(tx, revisions[0].commandId), state.key, now);
  if (!journal || journal.decision.operation !== 'ASSIGN' || journal.assignment.payload.selection.userId !== receipt.actorId
    || journal.assignment.payload.targetId !== target.targetId || journal.assignment.payload.selection.kind !== target.kind
    || !journal.assignment.payload.selection.actions.includes(receipt.action)) unavailable();
  const audit = await tx.auditLog.findUnique({ where: { id: commandId }, select: { actorId: true, entityType: true,
    entityId: true, event: true, before: true, after: true } });
  if (!audit || audit.actorId !== receipt.actorId || audit.event !== 'technical_work_recorded'
    || audit.entityType !== 'TechnicalWorkCommand' || audit.entityId !== commandId
    || canonicalSha256(audit.before) !== canonicalSha256({})
    || canonicalSha256(audit.after) !== canonicalSha256({ action: receipt.action, fieldCount: receipt.fieldCount })) unavailable();
  return receipt;
}

/** Read-only POST preview: no field value, permission or admission is trusted
 * from a form. The exact normalized patch must be seen before confirmation. */
export async function previewTechnicalWork(db: PrismaClient, claimed: AuthSession, rawTarget: TechnicalTargetReference, raw: unknown) {
  const target = technicalTargetReference.parse(rawTarget), input = technicalWorkCommand.parse(raw);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const locked = await lockedWork(tx, state, target, false);
    if (!admitsTechnicalRolePermission(state.current, target.kind, input.action)) denied();
    const patch = validateTechnicalWorkPatch(locked.assignment.payload.selection, input);
    const command = { ...input, patch };
    const fields = technicalFieldPreview(target.kind, Object.keys(patch), patch);
    const before = technicalFieldPreview(target.kind, Object.keys(patch), locked.row);
    if (fields.every(field => field.value === before.find(item => item.key === field.key)?.value)) stale();
    return { target, command, before, fields,
      token: createTechnicalWorkPreview(state.key, command, locked.admission, (await technicalAssignmentClock(tx)).getTime()) };
  });
}

function sqlPatch(patch: Record<string, string | null>) {
  // Only called after validateTechnicalWorkPatch. Column names come from the
  // closed field contract, never an unchecked user identifier.
  const dates = new Set(['dueDate', 'submittedAt', 'nextClientUpdateAt']);
  return Object.entries(patch).map(([field, value]) => {
    if (!/^[a-zA-Z]+$/.test(field)) denied();
    const column = Prisma.raw(`"${field}"`);
    return dates.has(field) ? Prisma.sql`${column}=${value === null ? null : new Date(value)}` : Prisma.sql`${column}=${value}`;
  });
}

/** One exact command changes one target, records its receipt and minimized audit
 * in the same transaction. No owner, commercial attribution, file or grant write.
 * Existing explicitly configured update rules retain their own trigger/admission. */
export async function confirmTechnicalWork(db: PrismaClient, claimed: AuthSession, rawTarget: TechnicalTargetReference,
  raw: unknown, token: string, confirmed: boolean) {
  if (confirmed !== true || typeof token !== 'string' || token.length > 96_000) denied();
  const target = technicalTargetReference.parse(rawTarget), command = technicalWorkCommand.parse(raw);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const digest = technicalWorkRequestDigest(target, command);
    const previous = await outcome(tx, state, target, command.commandId, digest);
    if (previous) return previous;
    const locked = await lockedWork(tx, state, target, true);
    if (!admitsTechnicalRolePermission(state.current, target.kind, command.action)) denied();
    const patch = validateTechnicalWorkPatch(locked.assignment.payload.selection, command);
    if (canonicalJson(patch) !== canonicalJson(command.patch)) stale();
    const now = await technicalAssignmentClock(tx), exact = readTechnicalWorkPreview(state.key, token, locked.admission, now.getTime());
    if (!exact || canonicalJson(exact) !== canonicalJson(command)) stale();
    const before = technicalFieldPreview(target.kind, Object.keys(patch), locked.row);
    const fields = technicalFieldPreview(target.kind, Object.keys(patch), patch);
    if (fields.every(field => field.value === before.find(item => item.key === field.key)?.value)) stale();
    // Ensure a distinct optimistic version even with millisecond timestamps.
    const version = new Date(Math.max(now.getTime(), locked.row.updatedAt.getTime() + 1));
    const table = Prisma.raw(target.kind === 'Project' ? '"Project"' : '"TechnicalPractice"');
    const statements = sqlPatch(patch);
    // PostgreSQL enums require their canonical enum casts for the status/priority
    // assignments. All other columns are strings or bounded instants.
    if ('status' in patch) statements[0] = Prisma.sql`status=${patch.status}::${Prisma.raw(target.kind === 'Project' ? '"ProjectStatus"' : '"TechnicalPracticeStatus"')}`;
    const priority = Object.keys(patch).indexOf('priority');
    if (priority >= 0) statements[priority] = Prisma.sql`priority=${patch.priority}::"TechnicalPracticePriority"`;
    const changed = await tx.$executeRaw(Prisma.sql`UPDATE ${table} SET ${Prisma.join(statements)},"updatedAt"=${version}
      WHERE id=${target.targetId} AND "updatedAt"=${locked.row.updatedAt}`);
    if (changed !== 1) stale();
    const recordedAt = await technicalAssignmentClock(tx);
    if (!readTechnicalWorkPreview(state.key, token, locked.admission, recordedAt.getTime())
      || !readTechnicalAssignmentJournal(locked.assignment.journal, state.key, locked.assignment.current, recordedAt)) stale();
    await assertTechnicalAssignmentDocuments(tx, state, locked.assignment.context, locked.assignment.payload.selection.documents);
    const receipt = technicalWorkReceipt.parse({ protocol: 'TECHNICAL_WORK_RECEIPT_V1', commandId: command.commandId,
      actorId: state.current.userId, sessionId: state.current.sessionId!, target, assignmentId: command.assignmentId,
      assignmentRevision: command.assignmentRevision, action: command.action, fieldCount: fields.length,
      requestDigest: digest, targetVersion: version.toISOString(), recordedAt: recordedAt.toISOString(), keyVersion: state.key.version });
    const proof = technicalAssignmentProof(state.key, 'work-receipt', receipt);
    await tx.$executeRaw`INSERT INTO "TechnicalWorkCommand" (id,"assignmentId","assignmentRevision","actorId","sessionId",kind,"targetId",action,"requestDigest",receipt,proof)
      VALUES (${command.commandId}::uuid,${command.assignmentId}::uuid,${command.assignmentRevision},${state.current.userId},
      ${state.current.sessionId}::uuid,${target.kind},${target.targetId},${command.action},${digest},${JSON.stringify(receipt)}::jsonb,${proof})`;
    await tx.auditLog.create({ data: { id: command.commandId, actorId: state.current.userId, event: 'technical_work_recorded',
      entityType: 'TechnicalWorkCommand', entityId: command.commandId, before: {}, after: { action: command.action, fieldCount: fields.length } } });
    const saved = await outcome(tx, state, target, command.commandId, digest);
    if (!saved) unavailable();
    return saved;
  });
}

/** Read-only recovery survives assignment revocation without renewing access or
 * disclosing past field values. Current registry session/role remains required. */
export async function readTechnicalWorkOutcome(db: PrismaClient, claimed: AuthSession, rawTarget: TechnicalTargetReference, commandId: string) {
  const target = technicalTargetReference.parse(rawTarget);
  z.string().uuid().parse(commandId);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const receipt = await outcome(tx, state, target, commandId);
    return receipt ? { status: 'RECORDED' as const, receipt } : { status: 'NOT_OBSERVED' as const };
  });
}
