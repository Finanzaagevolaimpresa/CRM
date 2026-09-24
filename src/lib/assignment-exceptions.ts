import type { Prisma } from '@prisma/client';
import { authorizeManualAssignment, type AssignmentActor } from './manual-assignment-guard';

export const exceptionKinds = ['leads', 'clients', 'projects', 'tasks', 'services', 'practices'] as const;
export type ExceptionKind = typeof exceptionKinds[number];
export type AssignmentException = { id: string; title: string; href: string; ownerIds: string[]; status: string; historical: boolean };
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
      select: { id: true, firstName: true, lastName: true, assignedToId: true, status: true } }))
      .map(row => ({ id: row.id, title: `${row.firstName} ${row.lastName}`, href: `/leads/${row.id}`, status: row.status, historical: ['vinto', 'perso', 'cliente_acquisito', 'archiviato'].includes(row.status), ownerIds: owners(row.assignedToId) })); break;
    case 'clients': rows = (await tx.client.findMany({ where: { ...clientWhere, ...page }, ...window,
      select: { id: true, displayName: true, salesOwnerId: true, consultantId: true, status: true } }))
      .map(row => ({ id: row.id, title: row.displayName, href: `/clients/${row.id}`, status: row.status, historical: ['chiuso', 'archiviato'].includes(row.status), ownerIds: owners(row.salesOwnerId, row.consultantId) })); break;
    case 'projects': rows = (await tx.project.findMany({ where: { ...projectWhere, ...page }, ...window,
      select: { id: true, title: true, consultantId: true, status: true } }))
      .map(row => ({ id: row.id, title: row.title, href: `/projects/${row.id}`, status: row.status, historical: ['chiuso', 'archiviato'].includes(row.status), ownerIds: owners(row.consultantId) })); break;
    case 'tasks': rows = (await tx.task.findMany({ where: { ...leadWhere, ...page }, ...window,
      select: { id: true, title: true, assignedToId: true, clientId: true, status: true } }))
      .map(row => ({ id: row.id, title: row.title, href: `/settings/assignment-exceptions/tasks/${row.id}`, status: row.status, historical: ['completata', 'annullata'].includes(row.status), ownerIds: owners(row.assignedToId) })); break;
    case 'services': rows = (await tx.clientService.findMany({ where: { ...leadWhere, ...page }, ...window,
      select: { id: true, clientId: true, assignedToId: true, status: true, operationalStatus: true } }))
      .map(row => ({ id: row.id, title: `Servizio ${row.id}`, href: `/clients/${row.clientId}`, status: `${row.status} / ${row.operationalStatus}`, historical: ['consegnato', 'chiuso', 'archiviato'].includes(row.status) || ['chiusa', 'archiviata'].includes(row.operationalStatus), ownerIds: owners(row.assignedToId) })); break;
    case 'practices': rows = (await tx.technicalPractice.findMany({ where: { ...practiceWhere, ...page }, ...window,
      select: { id: true, title: true, commercialOwnerId: true, technicalOwnerId: true, status: true } }))
      .map(row => ({ id: row.id, title: row.title, href: `/technical-office/practices/${row.id}`, status: row.status, historical: ['approvata', 'respinta', 'archiviata'].includes(row.status), ownerIds: owners(row.commercialOwnerId, row.technicalOwnerId) })); break;
  }
  return { kind, counts, users, rows: rows.slice(0, pageSize), next: rows.length > pageSize ? rows[pageSize - 1]!.id : null };
}
