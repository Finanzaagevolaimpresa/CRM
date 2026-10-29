import { timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { technicalAssignmentProof } from './technical-assignment-proof';
import { TechnicalAssignmentError, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import type { TechnicalTargetReference } from './technical-assignment-display';
const schema = z.object({ type: z.literal('TECHNICAL_PRIVATE_ITEM_ATTEMPT_CLOSED_V1'), commandId: z.string().uuid(),
  actorId: z.string(), sessionId: z.string().uuid(), kind: z.enum(['Project', 'TechnicalPractice']), targetId: z.string(),
  keyVersion: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const auditId = (id: string) => 'technical-private-attempt:' + z.string().uuid().parse(id);
export async function lockPrivateItemAttempt(tx: Prisma.TransactionClient, commandId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${auditId(commandId)},0))::text`;
}
export async function readPrivateItemClosure(tx: Prisma.TransactionClient, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference, commandId: string) {
  const row = await tx.auditLog.findUnique({ where: { id: auditId(commandId) } }); if (!row) return null;
  const parsed = schema.safeParse(row.after);
  if (!parsed.success || row.event !== 'technical_private_item_attempt_closed' || row.entityType !== 'TechnicalPrivateItemAttempt'
    || row.entityId !== commandId || row.actorId !== state.current.userId) throw new TechnicalAssignmentError('UNAVAILABLE');
  const { hash, ...payload } = parsed.data;
  if (payload.actorId !== state.current.userId || payload.commandId !== commandId || payload.kind !== target.kind
    || payload.targetId !== target.targetId || payload.keyVersion !== state.key.version
    || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(technicalAssignmentProof(state.key, 'attempt-closure', payload), 'hex')))
    throw new TechnicalAssignmentError('UNAVAILABLE');
  return { status: 'CLOSED_WITHOUT_RECEIPT' as const, commandId };
}
export async function persistPrivateItemClosure(tx: Prisma.TransactionClient, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference, commandId: string) {
  const previous = await readPrivateItemClosure(tx, state, target, commandId); if (previous) return previous;
  const payload = { type: 'TECHNICAL_PRIVATE_ITEM_ATTEMPT_CLOSED_V1' as const, commandId, actorId: state.current.userId,
    sessionId: state.current.sessionId!, ...target, keyVersion: state.key.version };
  await tx.auditLog.create({ data: { id: auditId(commandId), actorId: state.current.userId, event: 'technical_private_item_attempt_closed',
    entityType: 'TechnicalPrivateItemAttempt', entityId: commandId, after: { ...payload, hash: technicalAssignmentProof(state.key, 'attempt-closure', payload) } } });
  const saved = await readPrivateItemClosure(tx, state, target, commandId); if (!saved) throw new TechnicalAssignmentError('UNAVAILABLE'); return saved;
}
