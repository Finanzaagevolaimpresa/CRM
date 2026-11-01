import type { Prisma } from '@prisma/client';
import { isTechnicalAccount, type TechnicalConfidentialityActor } from './technical-confidentiality';
/** Current canonical ownership is an additional technical function, even when
 * the single role or a preset also grants administrative/commercial permissions.
 * No role, user, grant or responsibility is created by this read. */
export async function currentTechnicalRestriction(db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  id: string, actor: TechnicalConfidentialityActor) {
  if (actor.role === 'admin') return false;
  if (isTechnicalAccount(actor)) return true;
  const [row] = await db.$queryRaw<Array<{ assigned: boolean }>>`
    SELECT (EXISTS(SELECT 1 FROM "Project" WHERE "consultantId"=${id})
      OR EXISTS(SELECT 1 FROM "TechnicalPractice" WHERE "technicalOwnerId"=${id})
      OR EXISTS(SELECT 1 FROM "Client" WHERE "consultantId"=${id})) AS assigned`;
  if (!row || typeof row.assigned !== 'boolean') throw new Error('TECHNICAL_FUNCTION_UNAVAILABLE');
  return row.assigned;
}
