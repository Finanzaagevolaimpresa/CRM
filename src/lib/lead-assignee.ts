import { Prisma, type RoleCode } from '@prisma/client';
import { isTechnicalAccount } from './technical-confidentiality';
import { recordUpdatePermission } from './record-update-context';

type Db = Pick<Prisma.TransactionClient, 'user' | '$queryRaw'>;
export function eligibleLeadAssignee(user: { role: RoleCode; active: boolean; technicalRestricted: boolean; permissionOverrides: { permission: string; allowed: boolean }[] }) {
  return user.active && ['admin','direzione','commerciale'].includes(user.role) && !isTechnicalAccount(user)
    && recordUpdatePermission(user,'lead.read') && recordUpdatePermission(user,'lead.write');
}
export async function leadAssignees(db: Db, id?: string) {
  const users = await db.user.findMany({ where: { id, active: true, deletedAt: null, role: { in: ['admin','direzione','commerciale'] } },
    select: { id: true, role: true, active: true, name: true, email: true, permissionOverrides: { select: { permission: true, allowed: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  if (!users.length) return [];
  const owners = await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT u.id FROM "User" u WHERE u.id IN (${Prisma.join(users.map(u => u.id))})
    AND u.role <> 'admin' AND (EXISTS(SELECT 1 FROM "Project" p WHERE p."consultantId"=u.id)
      OR EXISTS(SELECT 1 FROM "TechnicalPractice" p WHERE p."technicalOwnerId"=u.id)
      OR EXISTS(SELECT 1 FROM "Client" c WHERE c."consultantId"=u.id))`);
  const technical = new Set(owners.map(row => row.id));
  return users.filter(user => eligibleLeadAssignee({ ...user, technicalRestricted: technical.has(user.id) }))
    .map(({ id, name, email, role }) => ({ id, name, email, role }));
}
