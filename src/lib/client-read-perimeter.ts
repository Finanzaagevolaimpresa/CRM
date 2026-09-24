import { Prisma, type PrismaClient } from '@prisma/client';
import { UserFacingActionError } from './action-errors';
import { authorizeManualAssignment, type AssignmentActor } from './manual-assignment-guard';
import { lockInternalUser } from './internal-session-registry';
import { perimeterRoles } from './client-read-perimeter-policy';

export async function loadClientReadScope(db: PrismaClient | Prisma.TransactionClient, userId: string) {
  const rows = await db.clientReadGrant.findMany({
    where: { userId, active: true, user: { active: true, deletedAt: null }, client: { deletedAt: null } }, select: { clientId: true },
  });
  return rows.map(row => row.clientId);
}

export async function changeClientReadGrant(
  tx: Prisma.TransactionClient, actor: AssignmentActor,
  input: { userId: string; clientId: string; expectedVersion: number; active: boolean }, privilegedAdmission: boolean,
) {
  if (!privilegedAdmission) throw new UserFacingActionError('Conferma amministrativa richiesta.');
  await authorizeManualAssignment(tx, actor, []);
  const target = await lockInternalUser(tx, input.userId);
  const targetRole = target && await tx.user.findUnique({ where: { id: input.userId }, select: { role: true } });
  if (!target || !targetRole || (input.active && (!target.active || target.deletedAt || !perimeterRoles.includes(targetRole.role)))) {
    throw new UserFacingActionError('Destinatario non disponibile per la consultazione.');
  }
  const clients = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Client" WHERE "id" = ${input.clientId} AND (${!input.active} OR "deletedAt" IS NULL) FOR SHARE`);
  if (!clients[0]) throw new UserFacingActionError('Cliente non disponibile.');
  const before = await tx.clientReadGrant.findUnique({ where: { userId_clientId: { userId: input.userId, clientId: input.clientId } } });
  if ((before?.version ?? 0) !== input.expectedVersion || (!before && !input.active) || before?.active === input.active) {
    throw new UserFacingActionError('Perimetro già modificato. Aggiorna la pagina.');
  }
  const after = before
    ? await tx.clientReadGrant.update({ where: { id: before.id, version: input.expectedVersion }, data: { active: input.active, version: { increment: 1 }, updatedById: actor.userId } })
    : await tx.clientReadGrant.create({ data: { userId: input.userId, clientId: input.clientId, active: true, createdById: actor.userId, updatedById: actor.userId } });
  await tx.auditLog.create({ data: {
    actorId: actor.userId, entityType: 'ClientReadGrant', entityId: after.id,
    event: input.active ? 'client_read_grant_activated' : 'client_read_grant_revoked',
    before: { active: before?.active ?? false, version: before?.version ?? 0 },
    after: { userId: after.userId, clientId: after.clientId, active: after.active, version: after.version },
  } });
  return after;
}
