import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from './ai-orchestrator-db-test-guard';

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
  if (runDbTests) await assertAiOrchestratorEphemeralDatabaseIdentity(db());
});

test.after(async () => {
  await prisma?.$disconnect();
});

test('PostgreSQL applies migration 36 and all N07 query indexes', { skip: !runDbTests }, async () => {
  const [migrations, indexes] = await Promise.all([
    db().$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `,
    db().$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname LIKE ANY (ARRAY['Lead_%_cursor_idx', 'Client_%_cursor_idx', 'ClientService_client_status_cursor_idx', 'Document_client_active_idx', 'Task_%_cursor_idx', 'AiRun_created_cursor_idx', 'AiOutput_created_cursor_idx'])
      ORDER BY indexname
    `,
  ]);
  assert.equal(Number(migrations[0]?.count), 40);
  assert.deepEqual(indexes.map((row) => row.indexname), [
    'AiOutput_created_cursor_idx',
    'AiRun_created_cursor_idx',
    'ClientService_client_status_cursor_idx',
    'Client_active_cursor_idx',
    'Client_consultant_cursor_idx',
    'Client_sales_owner_cursor_idx',
    'Document_client_active_idx',
    'Lead_assignee_pipeline_cursor_idx',
    'Lead_pipeline_cursor_idx',
    'Task_active_due_cursor_idx',
    'Task_assignee_due_cursor_idx',
  ]);
});
