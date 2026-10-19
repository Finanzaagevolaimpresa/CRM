import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { purchasedFixture } from '../purchased-service-fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

export async function registrationFixture(db: PrismaClient, passwordHash?: string) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const f = await purchasedFixture(db, passwordHash);
  // Convert only this synthetic purchase into an empty dossier with existing
  // contract/payment evidence; no production or external provider is involved.
  await db.document.updateMany({ where: { clientId: f.client.id }, data: { clientServiceId: null } });
  await db.clientService.delete({ where: { id: f.service.id } });
  await db.serviceCatalog.update({ where: { id: f.catalog.id }, data: { active: true } });
  const session: AuthSession = { userId: f.admin.id, sessionId: f.admin.sessionId, role: 'admin', active: true,
    permissionOverrides: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const command = { operation: 'REGISTER' as const, commandId: randomUUID(), clientId: f.client.id, catalogId: f.catalog.id,
    contractId: f.contract.id, paymentId: f.payment.id as string | null, purchasedOn: new Date(Date.now() - 86400_000).toISOString().slice(0, 10) };
  return { ...f, session, command };
}
