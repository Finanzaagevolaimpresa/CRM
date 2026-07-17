import { Prisma, type PrismaClient } from '@prisma/client';

export const serializableOptions = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

export function mapSerializableConflict(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    return new Error('Operazione concorrente rilevata: riprovare.');
  }
  return error;
}

export async function withSerializableTransaction<T>(prisma: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  try { return await prisma.$transaction(fn, serializableOptions); }
  catch (error) { throw mapSerializableConflict(error); }
}
