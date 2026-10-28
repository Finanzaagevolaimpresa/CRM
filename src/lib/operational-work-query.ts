import { z } from 'zod';
import type { OperationalWorkQuery } from './operational-work-projection';
const field = z.string().max(80).regex(/^[a-z_]*$/).optional();
const identifier = z.string().max(128).regex(/^[A-Za-z0-9_-]*$/).optional();
const schema = z.object({
  q: z.string().trim().max(200).optional(), status: field, priority: field,
  clientId: identifier, technicalOwnerId: identifier, commercialOwnerId: identifier,
  dashboard: z.enum(['', 'attive']).optional(),
  page: z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).refine(n => n <= 600).optional(),
});
export function operationalWorkQuery(raw: Record<string, string | string[] | undefined>): OperationalWorkQuery | null {
  const result = schema.safeParse(raw);
  if (!result.success) return null;
  const { dashboard, ...query } = result.data;
  return { ...query, active: dashboard === 'attive' };
}
export function operationalWorkListPath(path: string, query: OperationalWorkQuery, page = 1, kind?: string) {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  for (const key of ['q', 'status', 'priority', 'clientId', 'technicalOwnerId', 'commercialOwnerId'] as const)
    if (query[key]) params.set(key, query[key]!);
  if (query.active) params.set('dashboard', 'attive');
  if (page > 1) params.set('page', String(page));
  return path + (params.size ? '?' + params.toString() : '');
}
