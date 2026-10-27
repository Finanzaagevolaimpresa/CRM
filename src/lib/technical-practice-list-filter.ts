import type { Prisma } from '@prisma/client';
import { dashboardPracticeFilter } from './dashboard-selection';

export const technicalPracticeStatuses = ['da_progettare', 'in_progettazione', 'documenti_richiesti',
  'documenti_completi', 'pronta_presentazione', 'presentata', 'integrazione_richiesta', 'in_istruttoria',
  'approvata', 'respinta', 'archiviata'] as const;
export const technicalPracticePriorities = ['bassa', 'media', 'alta', 'urgente'] as const;

type Query = Record<string, string | string[] | undefined>;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
/** A list filter narrows the query only; the caller still checks every current
 * parent and record permission. Invalid or repeated values never broaden it. */
export function technicalPracticeListFilter(query: Query) {
  const keys = ['dashboard', 'status', 'clientId', 'technicalOwnerId', 'commercialOwnerId', 'priority'] as const;
  if (keys.some(key => Array.isArray(query[key]))) return null;
  const { dashboard, status, clientId, technicalOwnerId, commercialOwnerId, priority } = query as Record<string, string | undefined>;
  if ((dashboard && dashboard !== 'attive')
    || (status && !technicalPracticeStatuses.some(item => item === status))
    || (priority && !technicalPracticePriorities.some(item => item === priority))
    || [clientId, technicalOwnerId, commercialOwnerId].some(value => value && !identifier.test(value))) return null;
  return {
    deletedAt: status === 'archiviata' ? { not: null } : null,
    ...(dashboard === 'attive' ? { AND: [dashboardPracticeFilter] } : {}),
    ...(status ? { status: status as typeof technicalPracticeStatuses[number] } : {}),
    ...(priority ? { priority: priority as typeof technicalPracticePriorities[number] } : {}),
    ...(clientId ? { clientId } : {}), ...(technicalOwnerId ? { technicalOwnerId } : {}),
    ...(commercialOwnerId ? { commercialOwnerId } : {}),
  } satisfies Prisma.TechnicalPracticeWhereInput;
}
