import type { AuthSession } from './auth';
import type { Task } from '@prisma/client';
import { hasPermission } from './permission-evaluator';
import { leadVisibilityWhere } from './core-query-policy';
import { canViewPreAnalysisListRecord } from './business-list-access';
import { prisma } from './prisma';
import { filterAccessibleTasks } from './read-access';
import { dashboardLeadFilter, dashboardReviewFilter, dashboardTodayFilter, type DashboardDetailItem } from './dashboard-selection';

export async function loadDashboardLeadDetail(session: AuthSession): Promise<DashboardDetailItem[]> {
  if (!hasPermission(session, 'lead.read')) return [];
  const rows = await prisma.lead.findMany({
    where: { AND: [dashboardLeadFilter, leadVisibilityWhere(session)] },
    orderBy: [{ nextActionDate: 'asc' }, { updatedAt: 'desc' }, { id: 'desc' }], take: 3,
    select: { id: true, companyName: true, firstName: true, lastName: true, status: true },
  });
  return rows.map(row => ({ id: row.id, title: row.companyName || `${row.firstName} ${row.lastName}`, status: row.status, href: `/leads/${row.id}` }));
}

export async function loadDashboardTodayDetail(session: AuthSession, now: Date): Promise<DashboardDetailItem[]> {
  return (await listDashboardTodayTasks(session, now, 3)).map(row => ({ id: row.id, title: row.title, status: row.status, href: '/tasks?dashboard=oggi' }));
}

export async function listDashboardTodayTasks(session: AuthSession, now: Date, previewLimit?: number): Promise<Task[]> {
  if (!hasPermission(session, 'service.read')) return [];
  // Scan authorized candidates to avoid an empty preview when other people's
  // tasks occupy the first candidate page. The total remains independent.
  return prisma.$transaction(async tx => {
    const result: Task[] = [];
    let afterId: string | undefined;
    while (previewLimit === undefined || result.length < previewLimit) {
      const rows = await tx.task.findMany({ where: { technicalPrivate: false, ...dashboardTodayFilter(now), ...(afterId ? { id: { gt: afterId } } : {}) },
        orderBy: { id: 'asc' }, take: 100 });
      if (!rows.length) break;
      const visible = await filterAccessibleTasks(session, rows, tx);
      result.push(...(previewLimit === undefined ? visible : visible.slice(0, previewLimit - result.length)));
      afterId = rows.at(-1)!.id;
      if (rows.length < 100) break;
    }
    return result;
  }, { isolationLevel: 'RepeatableRead', maxWait: 5_000, timeout: 30_000 });
}

export async function loadDashboardReviewDetail(session: AuthSession): Promise<DashboardDetailItem[]> {
  if (!hasPermission(session, 'dossier.read')) return [];
  return prisma.$transaction(async tx => {
    const result: DashboardDetailItem[] = [];
    let afterId: string | undefined;
    while (result.length < 3) {
      const rows = await tx.preAnalysis.findMany({ where: { ...dashboardReviewFilter, ...(afterId ? { id: { gt: afterId } } : {}) },
        orderBy: { id: 'asc' }, take: 100, select: { id: true, clientId: true, projectId: true, companyId: true, status: true } });
      if (!rows.length) break;
      const [clients, projects, companies] = await Promise.all([
        tx.client.findMany({ where: { id: { in: rows.map(row => row.clientId) }, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } }),
        tx.project.findMany({ where: { id: { in: rows.map(row => row.projectId) }, deletedAt: null }, select: { id: true, title: true, clientId: true, consultantId: true } }),
        tx.company.findMany({ where: { id: { in: rows.flatMap(row => row.companyId ? [row.companyId] : []) }, deletedAt: null }, select: { id: true, clientId: true } }),
      ]);
      const clientById = new Map(clients.map(row => [row.id, row])), projectById = new Map(projects.map(row => [row.id, row])), companyById = new Map(companies.map(row => [row.id, row]));
      for (const row of rows) {
        const project = projectById.get(row.projectId) ?? null;
        if (!canViewPreAnalysisListRecord(session, { preAnalysis: row, client: clientById.get(row.clientId) ?? null, project,
          company: row.companyId ? companyById.get(row.companyId) ?? null : null })) continue;
        result.push({ id: row.id, title: project!.title, status: row.status, href: `/preanalyses/${row.id}` });
        if (result.length === 3) break;
      }
      afterId = rows.at(-1)!.id;
      if (rows.length < 100) break;
    }
    return result;
  }, { isolationLevel: 'RepeatableRead', maxWait: 5_000, timeout: 30_000 });
}
