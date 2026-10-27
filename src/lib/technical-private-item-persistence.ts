import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import { technicalAssignmentClock, TechnicalAssignmentError, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { technicalPrivateItemInitialRow } from './technical-private-item-contract';
import { readTechnicalPrivateItemRecord, type TechnicalPrivateItemRecord } from './technical-private-item-journal';

type Tx = Prisma.TransactionClient;
function unavailable(): never { throw new TechnicalAssignmentError('UNAVAILABLE'); }

export async function loadTechnicalPrivateItemRecord(tx: Tx, state: Pick<TechnicalAssignmentTransaction, 'key'>, commandId: string) {
  z.string().uuid().parse(commandId);
  const rows = await tx.$queryRaw<Array<TechnicalPrivateItemRecord & {
    kind: string; itemId: string; actorId: string; sessionId: string; createdAt: Date;
  }>>`SELECT command,admission,origin,"originProof",receipt,"receiptProof",kind,"itemId","actorId","sessionId","createdAt"
    FROM "TechnicalPrivateItemOrigin" WHERE "commandId"=${commandId}::uuid FOR SHARE`;
  if (rows.length === 0) return null;
  if (rows.length !== 1) unavailable();
  const { kind, itemId, actorId, sessionId, createdAt, ...record } = rows[0];
  const saved = readTechnicalPrivateItemRecord(state.key, record, await technicalAssignmentClock(tx));
  if (!saved || saved.command.commandId !== commandId || saved.command.kind !== kind || saved.command.itemId !== itemId
    || saved.receipt.actorId !== actorId || saved.receipt.sessionId !== sessionId
    || saved.receipt.recordedAt !== createdAt.toISOString()) unavailable();
  const audit = await tx.auditLog.findUnique({ where: { id: commandId }, select: {
    actorId: true, event: true, entityType: true, entityId: true, before: true, after: true, createdAt: true } });
  if (!audit || audit.actorId !== actorId || audit.event !== 'technical_item_created_private'
    || audit.entityType !== 'TechnicalPrivateItemOrigin' || audit.entityId !== commandId
    || canonicalJson(audit.before) !== '{}' || canonicalJson(audit.after) !== canonicalJson({ action: 'create_private_item', type: kind })
    || audit.createdAt.toISOString() !== saved.receipt.recordedAt) unavailable();
  // Content may have advanced through a separate explicit work command. The
  // permanent origin/marker and canonical identity must still exist unchanged.
  const item = kind === 'Task' ? await tx.task.findUnique({ where: { id: itemId } })
    : await tx.documentChecklistItem.findUnique({ where: { id: itemId } });
  if (!item || !item.technicalPrivate || item.clientId !== saved.origin.clientId
    || item.projectId !== saved.origin.projectId || item.clientServiceId !== saved.origin.serviceId
    || item.createdById !== actorId || item.createdAt.toISOString() !== saved.receipt.recordedAt
    || ('companyId' in item && item.companyId !== saved.origin.companyId)) unavailable();
  return saved;
}

export async function persistTechnicalPrivateItem(tx: Tx, state: TechnicalAssignmentTransaction, record: TechnicalPrivateItemRecord) {
  const saved = readTechnicalPrivateItemRecord(state.key, record, await technicalAssignmentClock(tx));
  if (!saved || saved.receipt.actorId !== state.current.userId || saved.receipt.sessionId !== state.current.sessionId
    || saved.admission.authorityRevision !== state.authority.revision || state.recipient) unavailable();
  const { command: c, receipt: r } = saved, time = new Date(r.recordedAt);
  const initial = technicalPrivateItemInitialRow(c, saved.admission, time.getTime());
  if (!initial) unavailable();
  if ('priority' in initial) {
    await tx.task.create({ data: { ...initial, dueAt: initial.dueAt ? new Date(initial.dueAt) : null, createdAt: time, updatedAt: time } });
  } else {
    await tx.documentChecklistItem.create({ data: { ...initial, createdAt: time, updatedAt: time } });
  }
  await tx.$executeRaw`INSERT INTO "TechnicalPrivateItemOrigin"
    (kind,"itemId","commandId","actorId","sessionId",command,admission,origin,"originProof",receipt,"receiptProof","createdAt")
    VALUES (${c.kind},${c.itemId},${c.commandId}::uuid,${r.actorId},${r.sessionId}::uuid,
      ${JSON.stringify(c)}::jsonb,${JSON.stringify(saved.admission)}::jsonb,${JSON.stringify(saved.origin)}::jsonb,
      ${saved.originProof},${JSON.stringify(r)}::jsonb,${saved.receiptProof},${time})`;
  await tx.auditLog.create({ data: { id: c.commandId, actorId: r.actorId, event: 'technical_item_created_private',
    entityType: 'TechnicalPrivateItemOrigin', entityId: c.commandId, before: {},
    after: { action: 'create_private_item', type: c.kind }, createdAt: time } });
  const retained = await loadTechnicalPrivateItemRecord(tx, state, c.commandId);
  if (!retained || canonicalJson(retained) !== canonicalJson(saved)) unavailable();
  // Surface deferred failures inside the transaction callback; do not depend
  // on the adapter propagating a constraint error from COMMIT.
  await tx.$executeRaw`SET CONSTRAINTS task_private_origin_required, checklist_private_origin_required, technical_private_creation_atomic IMMEDIATE`;
  return retained.receipt;
}
