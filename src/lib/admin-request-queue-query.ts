import { z } from 'zod';

export const adminRequestQueueKind = z.enum(['DOCUMENT', 'INTEGRATION']);
export type AdminRequestQueueKind = z.infer<typeof adminRequestQueueKind>;
export type AdminRequestQueueSearch = Record<string, string | string[] | undefined>;
const querySchema = z.object({
  page: z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(200)).default(1),
  q: z.string().max(160).trim().default(''),
  kind: z.union([z.literal(''), adminRequestQueueKind]).optional(),
  recover: z.string().uuid().optional(),
  result: z.string().optional(),
});

export function parseAdminRequestQueueSearch(raw: AdminRequestQueueSearch, fixedKind?: AdminRequestQueueKind) {
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success || fixedKind && parsed.data.kind && parsed.data.kind !== fixedKind) return null;
  return { ...parsed.data, kind: fixedKind ?? (parsed.data.kind || undefined) };
}

export function adminRequestQueueHref(base: '/admin-requests' | '/technical-office/integrations',
  query: { page: number; q: string; kind?: AdminRequestQueueKind }) {
  const params = new URLSearchParams({ page: String(query.page) });
  if (query.q) params.set('q', query.q);
  if (query.kind) params.set('kind', query.kind);
  return `${base}?${params}`;
}
