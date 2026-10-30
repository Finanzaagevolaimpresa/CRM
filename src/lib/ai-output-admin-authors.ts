import { Prisma } from '@prisma/client';

/** A content correction has an author even when the original AI run is kept.
 * Status changes and annotations alone do not change content authorship. */
export async function aiOutputAdminAuthors(tx: Prisma.TransactionClient, outputIds: string[]) {
  if (!outputIds.length) return new Map<string, string[]>();
  const rows = await tx.$queryRaw<Array<{ recordId: string; actorId: string }>>(Prisma.sql`
    SELECT DISTINCT "recordId", "actorId" FROM "AdminRecordRevision"
    WHERE model='AiOutput' AND "recordId" IN (${Prisma.join(outputIds)}) AND operation IN ('UPDATE','RESTORE')
      AND (before->'title' IS DISTINCT FROM after->'title' OR before->'content' IS DISTINCT FROM after->'content')`);
  const authors = new Map<string, string[]>();
  for (const row of rows) authors.set(row.recordId, [...(authors.get(row.recordId) ?? []), row.actorId]);
  return authors;
}
