import type { Prisma } from '@prisma/client';
import { UserFacingActionError } from './action-errors';

/** Shared by initial creation routes. Serialize on the canonical project; a
 * purchased service remains a distinct context and keeps its own service lock. */
export async function lockPracticeCreationProject(tx: Prisma.TransactionClient, projectId?: string | null) {
  if (projectId) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${projectId} FOR UPDATE`;
}
export async function assertPracticeCreationSlot(tx: Prisma.TransactionClient, projectId?: string | null, clientServiceId?: string | null) {
  if (!projectId) return;
  await lockPracticeCreationProject(tx, projectId);
  const serviceIds = (await tx.clientService.findMany({ where: { projectId }, select: { id: true } })).map(row => row.id);
  const existing = await tx.technicalPractice.findFirst({ where: clientServiceId ? { clientServiceId }
    : { OR: [{ projectId }, { clientServiceId: { in: serviceIds } }] }, select: { id: true } });
  if (existing) throw new UserFacingActionError('Una pratica è già collegata al contesto scelto. Aprila dal progetto; non ripetere la creazione.');
}
