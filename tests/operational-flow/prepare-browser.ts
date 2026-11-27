import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { assertRegistryActivationReady, revokeAllInternalSessions, REGISTRY_ACTIVATION_ENTITY, REGISTRY_ACTIVATION_RECEIPT } from '../../src/lib/internal-session-registry';

const db = new PrismaClient();
async function prepare() {
  assert.equal(process.env.APP_ENV, 'test');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const users = await db.user.findMany({ select: { id: true, email: true, role: true } });
  assert(users.length > 0 && users.every(user => /(?:\.test|\.invalid)$/u.test(user.email)));
  const admin = users.find(user => user.role === 'admin'); assert(admin);
  for (const user of users) await db.$transaction(tx => revokeAllInternalSessions(tx, user.id, 'INTERNAL_GLOBAL', admin.id));
  await assertRegistryActivationReady(db);
  await db.auditLog.create({ data: { actorId: admin.id, entityType: REGISTRY_ACTIVATION_ENTITY, entityId: 'registry',
    event: REGISTRY_ACTIVATION_RECEIPT, after: { version: 1, mode: 'registry', enabled: true, synthetic: true } } });
  console.log('SYNTHETIC_BROWSER_REGISTRY_READY');
}
prepare().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
