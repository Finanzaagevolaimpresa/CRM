import { Prisma } from '@prisma/client';
import { SerializableConflictError } from './serializable';

/** Only the fully transactional shared update, before its persisted receipt read.
 * Reuse the immutable command; rerun all live admission/version/expiry checks.
 * Prisma P2034 and PostgreSQL 40001 confirm transaction rollback. A transport
 * failure, timeout, unknown COMMIT or domain rejection is never retried. No
 * provider call or other external side effect may be placed in this callback. */
export async function confirmedSharedWriteRetry<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await write(); }
    catch (error) {
      const cause = error instanceof SerializableConflictError ? error.cause : error;
      const aborted = cause instanceof Prisma.PrismaClientKnownRequestError &&
        (cause.code === 'P2034' || (cause.code === 'P2010' && cause.meta?.code === '40001'));
      if (!aborted || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 20));
    }
  }
}
