import { assertProjectOperational } from './project-lifecycle-lock';
import type { Prisma } from '@prisma/client';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { contextOutsideSelection } from './selective-project-policy';
import { companyClientContextOutsideSelection } from './selective-client-policy';
import { authorizeManualAssignment, denyManualAssignment, type AssignmentActor } from './manual-assignment-guard';

export async function loadExceptionTask(tx: Prisma.TransactionClient, actor: AssignmentActor, id: string) {
  await authorizeManualAssignment(tx, actor, []);
  const scope = await loadSelectiveProjectScope(tx, actor.userId);
  return tx.task.findFirst({ where: { technicalPrivate: false, id, deletedAt: null, AND: [contextOutsideSelection(scope), companyClientContextOutsideSelection(scope)] }, select: {
    id: true, title: true, status: true, clientId: true, assignedToId: true, updatedAt: true,
  } });
}
export async function reassignExceptionTask(tx: Prisma.TransactionClient, actor: AssignmentActor,
  input: { id: string; updatedAt: Date; assignedToId: string }, privilegedAdmission: boolean,
) {
  if (!privilegedAdmission || !input.assignedToId) denyManualAssignment();
  await authorizeManualAssignment(tx, actor, [{ userId: input.assignedToId }]);
  await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${input.id} FOR UPDATE`;
  const scope = await loadSelectiveProjectScope(tx, actor.userId);
  const before = await tx.task.findFirst({ where: { technicalPrivate: false, id: input.id, deletedAt: null, updatedAt: input.updatedAt, AND: [contextOutsideSelection(scope), companyClientContextOutsideSelection(scope)] } });
  if (!before || before.assignedToId === input.assignedToId) denyManualAssignment();
  await assertProjectOperational(tx, before);
  const after = await tx.task.update({ where: { id: before.id, updatedAt: before.updatedAt, deletedAt: null },
    data: { assignedToId: input.assignedToId } });
  await tx.auditLog.create({ data: { actorId: actor.userId, event: 'exception_task_reassigned', entityType: 'Task',
    entityId: after.id, before: { assignedToId: before.assignedToId }, after: { assignedToId: after.assignedToId } } });
  return after;
}
