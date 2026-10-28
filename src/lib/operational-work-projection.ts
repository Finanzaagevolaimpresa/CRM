import type { TechnicalTargetReference } from './technical-assignment-display';

export type OperationalWorkRow = {
  id: string; kind: TechnicalTargetReference['kind']; admission: 'ORDINARY' | 'SELECTIVE';
  href: string; title: string | null; status: string | null; priority: string | null; dueDate: string | null;
  client: { id: string; name: string } | null;
  technicalOwner: { id: string; name: string } | null;
  commercialOwner: { id: string; name: string } | null;
  responsibility: string | null; expiresAt: string | null;
};
export type OperationalWorkQuery = {
  q?: string; status?: string; active?: boolean; priority?: string; clientId?: string;
  technicalOwnerId?: string; commercialOwnerId?: string; page?: number;
};
export const operationalWorkPageSize = 20;

/** Inputs are already admitted projections. No raw record can supply search,
 * ordering, filters, counters or the label of an omitted field. */
export function selectOperationalWork(rows: readonly OperationalWorkRow[], query: OperationalWorkQuery = {}) {
  const unique = new Map<string, OperationalWorkRow>();
  for (const row of rows) {
    const key = row.kind + ':' + row.id, existing = unique.get(key);
    if (!existing || (existing.admission === 'SELECTIVE' && row.admission === 'ORDINARY')) unique.set(key, row);
  }
  const q = (query.q ?? '').trim().toLocaleLowerCase('it-IT');
  const admitted = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
  const filtered = admitted.filter(row => (!q || (row.title !== null && row.title.toLocaleLowerCase('it-IT').includes(q)))
    && (!query.status || row.status === query.status)
    && (!query.active || (row.status !== null && !['approvata', 'respinta', 'archiviata', 'archiviato'].includes(row.status)))
    && (!query.priority || row.priority === query.priority)
    && (!query.clientId || row.client?.id === query.clientId)
    && (!query.technicalOwnerId || row.technicalOwner?.id === query.technicalOwnerId)
    && (!query.commercialOwnerId || row.commercialOwner?.id === query.commercialOwnerId));
  const page = query.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 600) throw new Error('OPERATIONAL_WORK_INVALID_PAGE');
  const offset = (page - 1) * operationalWorkPageSize;
  return { records: filtered.slice(offset, offset + operationalWorkPageSize), total: filtered.length,
    hasNext: filtered.length > offset + operationalWorkPageSize, page,
    hiddenStatus: admitted.filter(row => row.status === null).length,
    stateCounts: Object.fromEntries([...new Set(admitted.flatMap(row => row.status ? [row.status] : []))]
      .map(status => [status, admitted.filter(row => row.status === status).length])) };
}
