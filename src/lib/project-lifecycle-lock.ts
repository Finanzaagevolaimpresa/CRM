import { Prisma } from '@prisma/client';

export class ProjectUnavailableError extends Error {
  constructor() { super('PROJECT_NOT_OPERATIONAL'); }
}

/** Hold these rows until the caller's transaction ends. Lifecycle transitions
 * take the incompatible Project lock, so a stale operation cannot cross them. */
export async function assertProjectOperational(tx: Prisma.TransactionClient, context: {
  projectId?: string | null; clientServiceId?: string | null; clientId?: string | null; companyId?: string | null;
}) {
  // Read the current context under the same locks as the mutation. A form
  // prepared before an administrative move must not create an orphaned child.
  if (context.companyId) {
    const [company] = await tx.$queryRaw<Array<{ clientId: string; deletedAt: Date | null }>>`
      SELECT "clientId","deletedAt" FROM "Company" WHERE id=${context.companyId} FOR SHARE`;
    if (!company || company.deletedAt || context.clientId && company.clientId !== context.clientId) throw new ProjectUnavailableError();
  }
  const ids = new Set(context.projectId ? [context.projectId] : []);
  if (context.clientServiceId) {
    const services = await tx.$queryRaw<Array<{ projectId: string | null; clientId: string; companyId: string | null; deletedAt: Date | null }>>`
      SELECT "projectId","clientId","companyId","deletedAt" FROM "ClientService" WHERE "id"=${context.clientServiceId} FOR SHARE`;
    const service = services[0];
    if (!service || service.deletedAt || context.clientId && service.clientId !== context.clientId
      || context.companyId && service.companyId && service.companyId !== context.companyId
      || context.projectId && service.projectId && service.projectId !== context.projectId) throw new ProjectUnavailableError();
    if (service.projectId) ids.add(service.projectId);
  }
  if (!ids.size) return;
  const rows = await tx.$queryRaw<Array<{ id: string; clientId: string; companyId: string | null; status: string; deletedAt: Date | null }>>(Prisma.sql`
    SELECT "id","clientId","companyId","status","deletedAt" FROM "Project" WHERE "id" IN (${Prisma.join([...ids].sort())}) ORDER BY "id" FOR SHARE`);
  if (rows.length !== ids.size || rows.some(row => row.deletedAt || row.status === 'archiviato'
    || context.clientId && row.clientId !== context.clientId
    || context.companyId && row.companyId && row.companyId !== context.companyId)) throw new ProjectUnavailableError();
}
