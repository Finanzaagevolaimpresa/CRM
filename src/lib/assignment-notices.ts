import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { prisma } from './prisma';
import { leadVisibilityWhere } from './core-query-policy';
import { practiceOutsideSelection } from './selective-practice-policy';
import { isTechnicalAccount } from './technical-confidentiality';
import { technicalWorkPath } from './technical-assignment-display';
import { responsibilityDecision } from './responsibility-contract';

/** Current relationships bound the query before any notice or record link is returned. */
export async function currentAssignmentNotices(session: AuthSession, limit = 100) {
  const technical = isTechnicalAccount(session);
  const [leads, practices] = await Promise.all([
    !technical && hasPermission(session,'lead.read') ? prisma.lead.findMany({ where: { assignedToId: session.userId,
      deletedAt: null, clientId: null, status: { notIn: ['archiviato','cliente_acquisito','vinto','perso','non_qualificato'] },
      AND: [leadVisibilityWhere(session)], NOT: { commercialInboxItem: { is: { state: 'CLOSED' } } } }, select: { id: true } }) : [],
    hasPermission(session,'technical.read') ? prisma.technicalPractice.findMany({ where: { deletedAt: null,
      status: { notIn: ['archiviata','approvata','respinta'] }, AND: [practiceOutsideSelection(session)],
      OR: [{ commercialOwnerId: session.userId }, { technicalOwnerId: session.userId }] },
      select: { id: true, commercialOwnerId: true, technicalOwnerId: true, clientId:true, projectId:true, clientServiceId:true } }) : [],
  ]);
  const activeClients = practices.length ? await prisma.client.findMany({
    where: { id: { in: practices.map(p => p.clientId) }, deletedAt: null }, select: { id: true },
  }) : [];
  const clientIds = new Set(activeClients.map(c => c.id));
  const currentPractices = practices.filter(p => clientIds.has(p.clientId));
  const rows = await prisma.auditLog.findMany({ where: { event: 'responsibility_assigned', OR: [
    { entityType: 'Lead', entityId: { in: leads.map(l => l.id) } }, { entityType: 'TechnicalPractice', entityId: { in: currentPractices.map(p => p.id) } },
  ] }, distinct: ['entityType','entityId'], orderBy: [{ createdAt:'desc' },{ id:'desc' }],
    select: { id:true,entityType:true,entityId:true,createdAt:true,after:true } });
  const byPractice = new Map(currentPractices.map(row => [row.id,row]));
  return rows.flatMap(row => {
    const d = responsibilityDecision.safeParse(row.after);
    if (!d.success || !d.data.allowed || !row.entityId) return [];
    const state = d.data.state, practice = byPractice.get(row.entityId);
    if (row.entityType === 'Lead' ? state.commercialOwnerId !== session.userId
      : !practice || state.technicalOwnerId !== practice.technicalOwnerId || state.commercialOwnerId !== practice.commercialOwnerId
        || state.clientId !== practice.clientId || state.projectId !== practice.projectId || state.clientServiceId !== practice.clientServiceId) return [];
    return [{ id: 'responsibility-' + row.id, title: row.entityType === 'Lead' ? 'Lead assegnato a te' : 'Pratica assegnata a te',
      category: 'Assegnazione interna', priority: 'media' as const, date: row.createdAt, related: null,
      href: row.entityType === 'Lead' ? '/leads/' + row.entityId : technical
        ? technicalWorkPath({ kind: 'TechnicalPractice', targetId: row.entityId }) : '/technical-office/practices/' + row.entityId }];
  }).slice(0,limit);
}
