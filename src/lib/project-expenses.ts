import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { projectExpenseSchema } from './validation';
import { requireProjectEditAccess } from './write-access';
import { withProjectResources } from './project-resource-guard';
import { assertLeadActorLive, lockLeadWriteActor } from './lead-lifecycle-lock';
import { redactAuditPayload } from './data-classification';

/** Bind the initial context, then admit the current actor again under the same
 * locks as the insert. A previous client's authority cannot follow a move. */
export async function createProjectExpenseRecord(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const data = projectExpenseSchema.parse(raw);
  const before = await requireProjectEditAccess(claimed, data.projectId, db);
  return withProjectResources(db, claimed.userId,
    [{ projectId: before.id, clientId: before.clientId, companyId: before.companyId }], async tx => {
      const current = await lockLeadWriteActor(tx, claimed, ['project.write']);
      await requireProjectEditAccess(current, data.projectId, tx);
      const expense = await tx.projectExpense.create({ data });
      await tx.auditLog.create({ data: { actorId: current.userId, event: 'project_expense_create',
        entityType: 'ProjectExpense', entityId: expense.id, after: redactAuditPayload(expense) as Prisma.InputJsonValue } });
      await assertLeadActorLive(tx, current);
      return expense;
    });
}
