import { Prisma } from '@prisma/client';
import { SerializableConflictError } from './serializable';

/** Read-only transactions may restart after a confirmed PostgreSQL rollback.
 * The caller must put the whole transaction, including fresh admission, here.
 * This helper must never wrap a write, provider call or uncertain outcome. */
export async function confirmedReadRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await read(); }
    catch (error) {
      const cause = error instanceof SerializableConflictError ? error.cause : error;
      const aborted = cause instanceof Prisma.PrismaClientKnownRequestError &&
        (cause.code === 'P2034' || (cause.code === 'P2010' &&
          (cause.meta?.code === '40001' || cause.meta?.code === '40P01')));
      if (!aborted || attempt === 3) throw error;
    }
  }
}
