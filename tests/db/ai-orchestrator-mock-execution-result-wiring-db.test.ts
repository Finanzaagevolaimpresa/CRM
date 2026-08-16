import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from './ai-orchestrator-db-test-guard';

const runDbTests = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const prisma = runDbTests ? new PrismaClient() : null;

function db() {
  if (!prisma) throw new Error('DB tests disabled');
  return prisma;
}

test.before(async () => {
  if (!runDbTests) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db());
});

test.after(async () => {
  await prisma?.$disconnect();
});

test('PostgreSQL preserva i record global canonici PR85 nella catena additiva di 34 migration', { skip: !runDbTests }, async () => {
  const [orchestrator, control, migrations] = await Promise.all([
    db().aiOrchestratorSetting.findUnique({ where: { id: 'global' } }),
    db().aiControlSetting.findUnique({ where: { id: 'global' } }),
    db().$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  ]);
  assert.ok(orchestrator, 'AiOrchestratorSetting/global deve esistere');
  assert.ok(control, 'AiControlSetting/global deve esistere');
  assert.equal(control.externalProvidersEnabled, false);
  assert.equal(orchestrator.provider, 'mock');
  assert.equal(orchestrator.syntheticDataOnly, true);
  assert.equal(Number(migrations[0]?.count), 34);
  assert.equal(await db().aiOrchestratorSetting.count({ where: { id: 'singleton' } }), 0);
});
