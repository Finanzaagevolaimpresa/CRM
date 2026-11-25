import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { assertRegistryActivationReady, revokeAllInternalSessions } from '../../src/lib/internal-session-registry';

const db = new PrismaClient();
async function prepare() {
  assert.equal(process.env.APP_ENV, 'test');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const users = await db.user.findMany({select:{id:true,email:true}});
  assert(users.length >= 4);
  assert(users.every(u => u.email.endsWith('@selective.invalid.test')));
  for (const user of users) {
    await db.$transaction(tx => revokeAllInternalSessions(tx,user.id,'INTERNAL_GLOBAL',null));
  }
  await assertRegistryActivationReady(db);
  console.log('Synthetic accounts ready for ordinary browser login.');
}
prepare().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
