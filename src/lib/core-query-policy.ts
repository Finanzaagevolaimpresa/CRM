import type { Prisma } from '@prisma/client';
import type { AuthSession } from './auth';

export const CORE_QUERY_PAGE_SIZE = 50;
export const CORE_QUERY_MAX_PAGE = 200;
export const CORE_QUERY_DEFAULT_LIMIT = 50;
export const CORE_QUERY_MAX_LIMIT = 100;
export const CORE_QUERY_MAX_CANDIDATES = 500;
export const CORE_QUERY_REFERENCE_LIMIT = 250;

export type CoreQueryPage<T> = Readonly<{
  items: T[];
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
}>;

export function parseCoreQueryPage(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= CORE_QUERY_MAX_PAGE ? parsed : 1;
}

export function coreQueryOffset(page: number): number {
  if (!Number.isSafeInteger(page) || page < 1 || page > CORE_QUERY_MAX_PAGE) return 0;
  return (page - 1) * CORE_QUERY_PAGE_SIZE;
}

export function coreQueryFetchSize(): number {
  return CORE_QUERY_PAGE_SIZE + 1;
}

export function toCoreQueryPage<T>(rows: readonly T[], page: number): CoreQueryPage<T> {
  const canonicalPage = parseCoreQueryPage(String(page));
  return Object.freeze({
    items: rows.slice(0, CORE_QUERY_PAGE_SIZE),
    page: canonicalPage,
    hasPrevious: canonicalPage > 1,
    hasNext: rows.length > CORE_QUERY_PAGE_SIZE,
  });
}

export function normalizeCoreQueryLimit(value: number | undefined, fallback = CORE_QUERY_DEFAULT_LIMIT): number {
  const requested = value ?? fallback;
  if (!Number.isSafeInteger(requested) || requested < 1) return fallback;
  return Math.min(requested, CORE_QUERY_MAX_LIMIT);
}

export function coreQueryCandidateLimit(limit: number): number {
  const canonicalLimit = normalizeCoreQueryLimit(limit);
  return Math.min(Math.max(canonicalLimit * 5, canonicalLimit), CORE_QUERY_MAX_CANDIDATES);
}

export function clientVisibilityWhere(session: Pick<AuthSession, 'role' | 'userId'>): Prisma.ClientWhereInput {
  if (session.role === 'admin' || session.role === 'direzione'
    || session.role === 'revisore' || session.role === 'backoffice'
    || session.role === 'amministrazione') return {};
  if (session.role === 'commerciale') return { salesOwnerId: session.userId };
  if (session.role === 'consulente') return { consultantId: session.userId };
  if (session.role === 'collaboratore_limitato') {
    return { OR: [{ salesOwnerId: session.userId }, { consultantId: session.userId }] };
  }
  return { id: { in: [] } };
}

export function leadVisibilityWhere(session: Pick<AuthSession, 'role' | 'userId'>): Prisma.LeadWhereInput {
  if (session.role === 'admin' || session.role === 'direzione') return {};
  return { OR: [{ assignedToId: null }, { assignedToId: session.userId }] };
}

export function coreQueryPageHref(
  pathname: string,
  params: Readonly<Record<string, string | undefined>>,
  page: number,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params).sort(([left], [right]) => left.localeCompare(right))) {
    if (key !== 'page' && value) query.set(key, value);
  }
  if (page > 1) query.set('page', String(page));
  const serialized = query.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}
