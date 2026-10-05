import type { Prisma } from '@prisma/client';
import { UserFacingActionError } from './action-errors';
import { clientHasOperationalHold, CLIENT_OPERATIONAL_HOLD_MESSAGE } from './contract-operational-state';

// Called inside the existing mutation transaction. Holds can be reconciled only
// by an explicit client decision; changing a service label cannot bypass them.
export async function lockClientOperationalAdmission(db: Prisma.TransactionClient, clientId: string) {
  const rows = await db.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "Client" WHERE "id"=${clientId} AND "deletedAt" IS NULL FOR SHARE`;
  const client = rows[0];
  return Boolean(client && !clientHasOperationalHold(client.status));
}
export async function assertClientOperational(db: Prisma.TransactionClient, clientId: string) {
  if (!await lockClientOperationalAdmission(db, clientId)) throw new UserFacingActionError(CLIENT_OPERATIONAL_HOLD_MESSAGE);
}
