import type { Prisma } from '@prisma/client';
import { authorizeManualAssignment, type AssignmentActor } from './manual-assignment-guard';

export const exceptionKinds = ['leads', 'clients', 'projects', 'tasks', 'services', 'practices'] as const;
export type ExceptionKind = typeof exceptionKinds[number];
export type AssignmentException = { id: string; title: string; href: string; ownerIds: string[] };
const pageSize = 50;

export async function loadAssignmentExceptions(
  tx: Prisma.TransactionClient, actor: AssignmentActor, kind: ExceptionKind, after?: string,
) {
  await authorizeManualAssignment(tx, actor, []);
  if (!exceptionKinds.includes(kind) || (after && !/^[A-Za-z0-9_-]{1,128}$/u.test(after))) throw new Error('INVALID_EXCEPTION_CURSOR');
  const users = await tx.user.findMany({
    where: { OR: [{ active: false }, { deletedAt: { not: null } }] },
    select: { id: true, name: true, active: true, deletedAt: true }, orderBy: { id: 'asc' },
  });
  const invalidIds = users.map(user => user.id);
  const active = { deletedAt: null };
  const leadWhere = { ...active, assignedToId: { in: invalidIds } };
  const clientWhere = { ...active, OR: [{ salesOwnerId: { in: invalidIds } }, { consultantId: { in: invalidIds } }] };
  const projectWhere = { ...active, consultantId: { in: invalidIds } };
  const practiceWhere = { ...active, OR: [{ commercialOwnerId: { in: invalidIds } }, { technicalOwnerId: { in: invalidIds } }] };
  const values = await Promise.all([
    tx.lead.count({ where: leadWhere }), tx.client.count({ where: clientWhere }),
    tx.project.count({ where: projectWhere }), tx.task.count({ where: leadWhere }),
    tx.clientService.count({ where: leadWhere }), tx.technicalPractice.count({ where: practiceWhere }),
  ]);
  const counts = Object.fromEntries(exceptionKinds.map((key, index) => [key, values[index]!])) as Record<ExceptionKind, number>;
  const page = { ...(after ? { id: { gt: after } } : {}), deletedAt: null };
  const window = { take: pageSize + 1, orderBy: { id: 'asc' as const } };
  const owners = (...ids: (string | null)[]) => ids.filter((id): id is string => Boolean(id && invalidIds.includes(id)));
  let rows: AssignmentException[];
  switch (kind) {
    case 'leads': rows = (await tx.lead.findMany({ where: { ...leadWhere, ...page }, ...window,
      select: { id: true, firstName: true, lastName: true, assignedToId: true } }))
      .map(row => ({ id: row.id, title: `${row.firstName} ${row.lastName}`, href: `/leads/${row.id}`, ownerIds: owners(row.assignedToId) })); break;
    case 'clients': rows = (await tx.client.findMany({ where: { ...clientWhere, ...page }, ...window,
      select: { id: true, displayName: true, salesOwnerId: true, consultantId: true } }))
      .map(row => ({ id: row.id, title: row.displayName, href: `/clients/${row.id}`, ownerIds: owners(row.salesOwnerId, row.consultantId) })); break;
    case 'projects': rows = (await tx.project.findMany({ where: { ...projectWhere, ...page }, ...window,
      select: { id: true, title: true, consultantId: true } }))
      .map(row => ({ id: row.id, title: row.title, href: `/projects/${row.id}`, ownerIds: owners(row.consultantId) })); break;
    case 'tasks': rows = (await tx.task.findMany({ where: { ...leadWhere, ...page }, ...window,
      select: { id: true, title: true, assignedToId: true, clientId: true } }))
      .map(row => ({ id: row.id, title: row.title, href: row.clientId ? `/clients/${row.clientId}` : '/tasks', ownerIds: owners(row.assignedToId) })); break;
    case 'services': rows = (await tx.clientService.findMany({ where: { ...leadWhere, ...page }, ...window,
      select: { id: true, clientId: true, assignedToId: true } }))
      .map(row => ({ id: row.id, title: `Servizio ${row.id}`, href: `/clients/${row.clientId}`, ownerIds: owners(row.assignedToId) })); break;
    case 'practices': rows = (await tx.technicalPractice.findMany({ where: { ...practiceWhere, ...page }, ...window,
      select: { id: true, title: true, commercialOwnerId: true, technicalOwnerId: true } }))
      .map(row => ({ id: row.id, title: row.title, href: `/technical-office/practices/${row.id}`, ownerIds: owners(row.commercialOwnerId, row.technicalOwnerId) })); break;
  }
  return { kind, counts, users, rows: rows.slice(0, pageSize), next: rows.length > pageSize ? rows[pageSize - 1]!.id : null };
}
