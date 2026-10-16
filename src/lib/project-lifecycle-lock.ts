import { Prisma } from '@prisma/client';

export class ProjectUnavailableError extends Error {
  constructor() { super('PROJECT_NOT_OPERATIONAL'); }
}

/** Hold these rows until the caller's transaction ends. Lifecycle transitions
 * take the incompatible Project lock, so a stale operation cannot cross them. */
export async function assertProjectOperational(tx: Prisma.TransactionClient, context: {
  projectId?: string | null; clientServiceId?: string | null;
}) {
  const ids = new Set(context.projectId ? [context.projectId] : []);
  if (context.clientServiceId) {
    const services = await tx.$queryRaw<Array<{ projectId: string | null; deletedAt: Date | null }>>`
      SELECT "projectId","deletedAt" FROM "ClientService" WHERE "id"=${context.clientServiceId} FOR SHARE`;
    const service = services[0];
    if (!service || service.deletedAt) throw new ProjectUnavailableError();
    if (service.projectId) ids.add(service.projectId);
  }
  if (!ids.size) return;
  const rows = await tx.$queryRaw<Array<{ id: string; status: string; deletedAt: Date | null }>>(Prisma.sql`
    SELECT "id","status","deletedAt" FROM "Project" WHERE "id" IN (${Prisma.join([...ids].sort())}) ORDER BY "id" FOR SHARE`);
  if (rows.length !== ids.size || rows.some(row => row.deletedAt || row.status === 'archiviato')) throw new ProjectUnavailableError();
}
