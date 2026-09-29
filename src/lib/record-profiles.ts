import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession, Permission } from './auth';
import { canEditClient, canEditLead } from './access-control';
import { hasPermission } from './permission-evaluator';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { RecordProfileError, personProfileVersion, profileCommandSchema } from './record-profile-contract';

async function actor(tx: Prisma.TransactionClient, session: AuthSession, permission: Permission) {
  if (!session.active || session.expiresAt * 1000 <= Date.now()) throw new RecordProfileError('DENIED');
  if (session.sessionId) {
    const current = await lockAuthoritativeInternalSession(tx, { userId: session.userId, sessionId: session.sessionId });
    if (!current?.active || current.deletedAt || current.revokedAt || !current.live) throw new RecordProfileError('DENIED');
    const fresh = { ...session, role: current.role, permissionOverrides: [...current.permissionOverrides] };
    if (!hasPermission(fresh, permission)) throw new RecordProfileError('DENIED');
    return fresh;
  }
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${session.userId} FOR UPDATE`;
  const current = await tx.user.findUnique({ where: { id: session.userId }, include: { permissionOverrides: true } });
  if (!current?.active || current.deletedAt) throw new RecordProfileError('DENIED');
  const fresh = { ...session, role: current.role, permissionOverrides: current.permissionOverrides };
  if (!hasPermission(fresh, permission)) throw new RecordProfileError('DENIED');
  return fresh;
}
async function client(tx: Prisma.TransactionClient, session: AuthSession, id: string) {
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${id} FOR UPDATE`;
  const row = await tx.client.findFirst({ where: { id, deletedAt: null } });
  if (!row || !canEditClient(session, row)) throw new RecordProfileError('DENIED');
  return row;
}
async function company(tx: Prisma.TransactionClient, session: AuthSession, id: string) {
  const first = await tx.company.findFirst({ where: { id, deletedAt: null }, select: { clientId: true } });
  if (!first) throw new RecordProfileError('DENIED');
  await client(tx, session, first.clientId);
  await tx.$queryRaw`SELECT id FROM "Company" WHERE id=${id} FOR UPDATE`;
  const row = await tx.company.findFirst({ where: { id, clientId: first.clientId, deletedAt: null } });
  if (!row) throw new RecordProfileError('DENIED');
  return row;
}
function version(current: Date, expected: string) {
  if (current.toISOString() !== expected) throw new RecordProfileError('STALE');
}
export async function saveRecordProfile(db: Pick<PrismaClient, '$transaction'>, session: AuthSession, input: unknown) {
  const command = profileCommandSchema.parse(input);
  return db.$transaction(async tx => {
    const permission = command.kind === 'lead' ? 'lead.write' : command.kind === 'client' ? 'client.write' : 'company.write';
    const fresh = await actor(tx, session, permission);
    let entityType: string, resultId: string, destination: string;
    if (command.kind === 'lead') {
      await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${command.id} FOR UPDATE`;
      const row = await tx.lead.findFirst({ where: { id: command.id, deletedAt: null } });
      if (!row || !canEditLead(fresh, row)) throw new RecordProfileError('DENIED');
      version(row.updatedAt, command.expectedVersion);
      await tx.lead.update({ where: { id: row.id }, data: command.data });
      entityType = 'Lead'; resultId = row.id; destination = `/leads/${row.id}`;
    } else if (command.kind === 'client') {
      const row = await client(tx, fresh, command.id); version(row.updatedAt, command.expectedVersion);
      await tx.client.update({ where: { id: row.id }, data: command.data });
      entityType = 'Client'; resultId = row.id; destination = `/clients/${row.id}#anagrafica-completa`;
    } else if (command.kind === 'company' || command.kind === 'new-company') {
      if (command.kind === 'company') {
        const row = await company(tx, fresh, command.id); version(row.updatedAt, command.expectedVersion);
        await tx.company.update({ where: { id: row.id }, data: command.data });
      } else {
        await client(tx, fresh, command.clientId);
        const existing = await tx.company.findUnique({ where: { id: command.id } });
        if (existing) {
          if (existing.clientId !== command.clientId || existing.deletedAt) throw new RecordProfileError('DENIED');
          return `/companies/${existing.id}`;
        }
        await tx.company.create({ data: { id: command.id, clientId: command.clientId, ...command.data } });
      }
      entityType = 'Company'; resultId = command.id; destination = `/companies/${command.id}`;
    } else {
      const parent = await company(tx, fresh, command.companyId);
      const { role, ownershipPercent, ...personData } = command.data;
      if (command.kind === 'person') {
        await tx.$queryRaw`SELECT id FROM "CompanyPerson" WHERE id=${command.id} FOR UPDATE`;
        const link = await tx.companyPerson.findFirst({ where: { id: command.id, companyId: parent.id } });
        if (!link) throw new RecordProfileError('DENIED');
        await tx.$queryRaw`SELECT id FROM "Person" WHERE id=${link.personId} FOR UPDATE`;
        const person = await tx.person.findFirst({ where: { id: link.personId, deletedAt: null } });
        if (!person) throw new RecordProfileError('DENIED');
        if (personProfileVersion(person, link) !== command.expectedVersion) throw new RecordProfileError('STALE');
        // A change in this form must not modify another company's shared person.
        if (await tx.companyPerson.count({ where: { personId: person.id } }) !== 1) throw new RecordProfileError('SHARED_PERSON');
        await tx.person.update({ where: { id: person.id }, data: personData });
        await tx.companyPerson.update({ where: { id: link.id }, data: { role, ownershipPercent } });
      } else {
        const existing = await tx.companyPerson.findUnique({ where: { id: command.id } });
        if (existing) {
          if (existing.companyId !== parent.id) throw new RecordProfileError('DENIED');
          return `/companies/${parent.id}#referenti`;
        }
        const person = await tx.person.create({ data: personData });
        await tx.companyPerson.create({ data: { id: command.id, companyId: parent.id, personId: person.id, role, ownershipPercent } });
      }
      entityType = 'CompanyPerson'; resultId = command.id; destination = `/companies/${parent.id}#referenti`;
    }
    await tx.auditLog.create({ data: { actorId: fresh.userId, entityType, entityId: resultId, event: 'record_profile_saved',
      after: { action: command.kind, changedPaths: Object.keys(command.data).sort() } } });
    return destination;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
