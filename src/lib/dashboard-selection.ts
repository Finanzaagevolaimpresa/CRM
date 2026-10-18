import type { Prisma } from '@prisma/client';

export const dashboardViews = ['lead', 'pratiche', 'revisioni', 'oggi'] as const;
export type DashboardView = typeof dashboardViews[number];
export type DashboardDetailItem = { id: string; title: string; status: string; href: string };

export function selectDashboardView(value: unknown, allowed: readonly DashboardView[]): DashboardView | null {
  if (typeof value === 'string' && allowed.includes(value as DashboardView)) return value as DashboardView;
  return allowed.includes('pratiche') ? 'pratiche' : allowed[0] ?? null;
}

// These predicates mirror the existing complete counters. The same predicates
// are used by the new detail and destination lists; they grant no visibility.
export const dashboardLeadFilter = { deletedAt: null, status: 'da_contattare' } satisfies Prisma.LeadWhereInput;
export const dashboardPracticeFilter = { deletedAt: null, status: { notIn: ['approvata', 'respinta', 'archiviata'] } } satisfies Prisma.TechnicalPracticeWhereInput;
export const dashboardReviewFilter = { status: { in: ['bozza_generata', 'da_revisionare'] } } satisfies Prisma.PreAnalysisWhereInput;
export function dashboardTodayWindow(now: Date) {
  const startOfToday = new Date(now), endOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0); endOfToday.setHours(23, 59, 59, 999);
  return { startOfToday, endOfToday };
}
export function dashboardTodayFilter(now: Date): Prisma.TaskWhereInput {
  const { startOfToday, endOfToday } = dashboardTodayWindow(now);
  return { deletedAt: null, status: { in: ['aperta', 'in_lavorazione'] }, dueAt: { gte: startOfToday, lte: endOfToday } };
}

export const dashboardDestinations: Record<DashboardView, string> = {
  lead: '/leads?status=da_contattare', pratiche: '/technical-office/practices?dashboard=attive',
  revisioni: '/preanalyses?dashboard=revisioni', oggi: '/tasks?dashboard=oggi',
};
