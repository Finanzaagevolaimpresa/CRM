import { Prisma, type PrismaClient } from '@prisma/client';

export const serializableOptions = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

export class SerializableConflictError extends Error {
  readonly code = 'SERIALIZABLE_CONFLICT' as const;

  constructor(options?: ErrorOptions) {
    super('Operazione concorrente rilevata: riprovare.', options);
    this.name = 'SerializableConflictError';
  }
}

export function mapSerializableConflict(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // SELECT ... FOR UPDATE uses Prisma's raw-query error envelope. PostgreSQL
    // serialization failures and deadlocks have the same retryable boundary.
    const rawConflict = error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code));
    if (error.code === 'P2034' || rawConflict) return new SerializableConflictError({ cause: error });
  }
  return error;
}

export async function withSerializableTransaction<T>(prisma: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  try { return await prisma.$transaction(fn, serializableOptions); }
  catch (error) { throw mapSerializableConflict(error); }
}
