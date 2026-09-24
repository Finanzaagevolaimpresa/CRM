import type { PrismaClient } from '@prisma/client';
import { createRegistryLoginSession, type RegistryLoginSessionInput } from './internal-session-registry';

// Keep credential handling in authentication, without adding identity or
// credential fields to the registry's stored rows, results or audit events.
export function createAuthenticatedRegistryLoginSession(
  db: PrismaClient,
  input: RegistryLoginSessionInput & { expectedPasswordHash: string; expectedEmail: string },
) {
  return createRegistryLoginSession(db, { userId: input.userId, tokenDigest: input.tokenDigest }, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: input.userId }, select: { passwordHash: true, email: true },
    });
    return Boolean(user && user.passwordHash === input.expectedPasswordHash && user.email === input.expectedEmail);
  });
}
