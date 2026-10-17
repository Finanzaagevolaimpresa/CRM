import type { Prisma } from '@prisma/client';

/** Directory membership is part of an exact email approval. Readers hold the
 * shared lock through admission/DATA; canonical profile/privilege writers take
 * the exclusive lock before any actor or target row lock, including inserts.
 * Session login timestamps are not directory membership and need no such lock. */
export async function lockCommunicationDirectory(tx: Prisma.TransactionClient, write = false) {
  if (write) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('FAI_COMMUNICATION_DIRECTORY_V1', 0))`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('FAI_COMMUNICATION_DIRECTORY_V1', 0))`;
}
