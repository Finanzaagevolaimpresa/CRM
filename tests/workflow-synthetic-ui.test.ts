import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../src/lib/auth';
import { enrollSyntheticWorkflowReceipt, readSyntheticWorkflowLeadSetup } from '../src/lib/workflow-executions';

const admin = { userId: 'synthetic-admin', role: 'admin', active: true, permissionOverrides: [], expiresAt: 2_000_000_000 } satisfies AuthSession;
const input = { automationId: '11111111-1111-4111-8111-111111111111', receiptId: '22222222-2222-4222-8222-222222222222' };
const keys = ['APP_ENV', 'NODE_ENV', 'DATABASE_URL', 'RUN_DB_TESTS', 'AI_ORCHESTRATOR_DB_TESTS_CONFIRMED', 'AI_ORCHESTRATOR_DB_TEST_SENTINEL'] as const;
async function environment(operation: () => Promise<void>) {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { APP_ENV: 'test', NODE_ENV: 'development', DATABASE_URL: 'postgresql://postgres@ordinary-browser-db:5432/fai_crm_test?schema=public' });
  for (const key of keys.slice(3)) delete process.env[key];
  try { await operation(); } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else Object.assign(process.env, { [key]: previous[key] }); }
  }
}
function optIn() {
  Object.assign(process.env, { RUN_DB_TESTS: '1', AI_ORCHESTRATOR_DB_TESTS_CONFIRMED: '1', AI_ORCHESTRATOR_DB_TEST_SENTINEL: 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1' });
}

test('optional synthetic forms are absent in an unqualified test app while execution stays denied', async () => {
  await environment(async () => {
    const db = { $queryRaw: async () => { throw new Error('UNEXPECTED_DATABASE_ACCESS'); },
      $transaction: async () => { throw new Error('UNEXPECTED_TRANSACTION'); } } as unknown as PrismaClient;
    assert.equal(await readSyntheticWorkflowLeadSetup(db, admin, 'synthetic-lead'), null);
    await assert.rejects(enrollSyntheticWorkflowReceipt(db, admin, input), /SERVICE_CATALOG_SYNTHETIC_CONFIGURATION_DENIED/);
    optIn(); // Explicit flags do not authorize a non-loopback database host.
    assert.equal(await readSyntheticWorkflowLeadSetup(db, admin, 'synthetic-lead'), null);
    await assert.rejects(enrollSyntheticWorkflowReceipt(db, admin, input), /SERVICE_CATALOG_SYNTHETIC_CONFIGURATION_DENIED/);
  });
});

test('a qualified form does not hide failed database identity or unavailable persistence', async () => {
  await environment(async () => {
    optIn(); process.env.DATABASE_URL = 'postgresql://postgres@127.0.0.1:5432/fai_crm_test?schema=public';
    const mismatched = { $queryRaw: async () => [] } as unknown as PrismaClient;
    await assert.rejects(readSyntheticWorkflowLeadSetup(mismatched, admin, 'synthetic-lead'), /SERVICE_CATALOG_SYNTHETIC_DATABASE_DENIED/);
    const unavailable = { $queryRaw: async () => { throw new Error('SYNTHETIC_DB_UNAVAILABLE'); } } as unknown as PrismaClient;
    await assert.rejects(readSyntheticWorkflowLeadSetup(unavailable, admin, 'synthetic-lead'), /SYNTHETIC_DB_UNAVAILABLE/);
  });
});
