import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { TechnicalAssignmentError } from './technical-assignment-transaction';

// Preparation only. The caller must first lock the canonical parent/item and
// authorize the current person through the retained personal decision.
// A generation is an optimistic concurrency boundary, never an access grant.
const identity = z.object({ kind: z.enum(['ChecklistItem', 'Task']),
  itemId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const epoch = z.number().int().positive().max(2_147_483_647);
const generation = identity.extend({ generation: epoch, scopeGeneration: epoch }).strict()
  .refine(row => row.scopeGeneration <= row.generation);
export type TechnicalWorkItemIdentity = z.infer<typeof identity>;

export function decodeTechnicalWorkItemGeneration(rows: unknown, expected: TechnicalWorkItemIdentity) {
  const reference = identity.safeParse(expected);
  if (!reference.success || !Array.isArray(rows) || rows.length !== 1) return null;
  const row = generation.safeParse(rows[0]);
  return row.success && row.data.kind === reference.data.kind && row.data.itemId === reference.data.itemId
    ? row.data : null;
}

/** No INSERT/upsert on a read or missing row. Fail closed on absent, malformed or
 * ambiguous generations. The transaction must hold the same canonical row lock
 * through the final epoch check and the atomic item/receipt/audit commit. */
export async function lockTechnicalWorkItemGeneration(tx: Prisma.TransactionClient,
  expected: TechnicalWorkItemIdentity, intent: 'read' | 'write') {
  const reference = identity.parse(expected);
  if (intent !== 'read' && intent !== 'write') throw new TechnicalAssignmentError('DENIED');
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`
    SELECT kind,"itemId",generation,"scopeGeneration" FROM "TechnicalWorkItemGeneration"
    WHERE kind=${reference.kind} AND "itemId"=${reference.itemId}
    ${Prisma.raw(intent === 'write' ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const row = decodeTechnicalWorkItemGeneration(rows, reference);
  if (!row) throw new TechnicalAssignmentError('UNAVAILABLE');
  return row;
}
