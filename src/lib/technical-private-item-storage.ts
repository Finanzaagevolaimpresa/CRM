import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { readTechnicalPrivateItemOriginProof } from './technical-private-item-proof';

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const kind = z.enum(['Task', 'ChecklistItem']);
const reference = z.object({ kind, itemId: id }).strict();
const excludedRow = reference;
const originRow = reference.extend({ origin: z.unknown(), originProof: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const batchSize = 256;

function unavailable(): never { throw new Error('TECHNICAL_PRIVATE_ITEM_ORIGIN_UNAVAILABLE'); }

/** Retained exact target constraints for the private creation path. No read
 * repairs, creates or removes an origin; missing storage fails closed. */
export async function readTechnicalPrivateItemOrigin(db: Db, key: PrivilegedStepUpKey,
  raw: { kind: 'Task' | 'ChecklistItem'; itemId: string }) {
  const ref = reference.parse(raw);
  const rows = await db.$queryRaw<unknown[]>`SELECT kind,"itemId",origin,"originProof"
    FROM "TechnicalPrivateItemOrigin" WHERE kind=${ref.kind} AND "itemId"=${ref.itemId} FOR SHARE`;
  if (!Array.isArray(rows) || rows.length > 1) unavailable();
  if (rows.length === 0) return null;
  const parsed = originRow.safeParse(rows[0]);
  if (!parsed.success || parsed.data.kind !== ref.kind || parsed.data.itemId !== ref.itemId) unavailable();
  const origin = readTechnicalPrivateItemOriginProof(key, parsed.data.origin, parsed.data.originProof, ref);
  if (!origin) unavailable();
  return origin;
}

/** Ordinary paths exclude private items for every role, including Admin. The
 * personal management route and explicit recipient assignment use their own
 * current capability. A stale session-level ID list cannot replace this query.
 *
 * Call after the canonical rows are loaded, within the same snapshot when a
 * transaction is used, before projection, limits, counters, notifications or
 * mutation. Creation must retain row+origin atomically and origins cannot later
 * be removed or attached to a historical row. Those are required DB invariants.
 * Even an invalid origin proof never restores ordinary access. */
export async function filterOrdinaryTechnicalWorkItems<T extends { id: string }>(db: Db,
  rawKind: 'Task' | 'ChecklistItem', items: readonly T[]): Promise<T[]> {
  const selectedKind = kind.parse(rawKind);
  const identities = [...new Set(items.map(item => id.parse(item.id)))].sort();
  const exclusions = new Set<string>();
  for (let offset = 0; offset < identities.length; offset += batchSize) {
    const batch = identities.slice(offset, offset + batchSize), requested = new Set(batch);
    const rows = await db.$queryRaw<unknown[]>(Prisma.sql`SELECT kind,"itemId" FROM "TechnicalPrivateItemOrigin"
      WHERE kind=${selectedKind} AND "itemId" IN (${Prisma.join(batch)}) ORDER BY "itemId"`);
    if (!Array.isArray(rows) || rows.length > batch.length) unavailable();
    for (const raw of rows) {
      const parsed = excludedRow.safeParse(raw);
      if (!parsed.success || parsed.data.kind !== selectedKind || !requested.has(parsed.data.itemId)
        || exclusions.has(parsed.data.itemId)) unavailable();
      exclusions.add(parsed.data.itemId);
    }
  }
  return items.filter(item => !exclusions.has(item.id));
}
