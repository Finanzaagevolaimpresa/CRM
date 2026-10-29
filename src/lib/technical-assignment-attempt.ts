import { timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { technicalAssignmentProof } from './technical-assignment-proof';
import type { TechnicalAssignmentReference } from './technical-assignment-decision';
import type { TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { TechnicalAssignmentError } from './technical-assignment-errors';

const closure = z.object({ type: z.literal('TECHNICAL_ASSIGNMENT_ATTEMPT_CLOSED_V1'),
  commandId: z.string().uuid(), actorId: z.string(), sessionId: z.string().uuid(),
  kind: z.enum(['Project', 'TechnicalPractice']), targetId: z.string(), recipientId: z.string(),
  keyVersion: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const auditId = (commandId: string) => `technical-attempt:${z.string().uuid().parse(commandId)}`;

/** Call only under the same actor/recipient/target locks as confirmation.
 * This is a new audit fact about a closed attempt, never a fabricated grant,
 * acceptance or delivery receipt. Payload keys survive audit minimization. */
export async function readTechnicalAttemptClosure(tx: Prisma.TransactionClient,
  state: TechnicalAssignmentTransaction, reference: TechnicalAssignmentReference, commandId: string) {
  const row = await tx.auditLog.findUnique({ where: { id: auditId(commandId) } });
  if (!row) return null;
  const parsed = closure.safeParse(row.after);
  if (!parsed.success || row.event !== 'technical_assignment_attempt_closed'
    || row.entityType !== 'TechnicalAssignmentAttempt' || row.entityId !== commandId
    || row.actorId !== state.current.userId) throw new TechnicalAssignmentError('UNAVAILABLE');
  const { hash, ...payload } = parsed.data;
  if (payload.actorId !== state.current.userId || payload.sessionId !== state.current.sessionId
    || payload.commandId !== commandId || payload.kind !== reference.kind
    || payload.targetId !== reference.targetId || payload.recipientId !== reference.recipientId
    || payload.keyVersion !== state.key.version
    || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(technicalAssignmentProof(state.key, 'attempt-closure', payload), 'hex')))
    throw new TechnicalAssignmentError('UNAVAILABLE');
  return { status: 'CLOSED_WITHOUT_RECEIPT' as const, commandId };
}

export async function persistTechnicalAttemptClosure(tx: Prisma.TransactionClient,
  state: TechnicalAssignmentTransaction, reference: TechnicalAssignmentReference, commandId: string) {
  const existing = await readTechnicalAttemptClosure(tx, state, reference, commandId);
  if (existing) return existing;
  const payload = { type: 'TECHNICAL_ASSIGNMENT_ATTEMPT_CLOSED_V1' as const,
    commandId, actorId: state.current.userId, sessionId: state.current.sessionId!,
    ...reference, keyVersion: state.key.version };
  await tx.auditLog.create({ data: { id: auditId(commandId), actorId: state.current.userId,
    event: 'technical_assignment_attempt_closed', entityType: 'TechnicalAssignmentAttempt', entityId: commandId,
    after: { ...payload, hash: technicalAssignmentProof(state.key, 'attempt-closure', payload) } } });
  const stored = await readTechnicalAttemptClosure(tx, state, reference, commandId);
  if (!stored) throw new TechnicalAssignmentError('UNAVAILABLE');
  return stored;
}
