import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';
import {
  createPrismaLeadIntakeConsumerOperations,
  runLeadIntakeConsumer,
  safeLeadIntakeConsumerFailureCode,
  writeLeadIntakeConsumerLog,
} from '../../src/lib/lead-intake-consumer';

// Synthetic process fault injection only. This fixture is never an application entrypoint.
const root = new PrismaClient();
let database: PrismaClient | undefined;
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(root);
  const url = new URL(process.env.VNX05_TEST_SCHEMA_URL!);
  const expected = new URL(process.env.DATABASE_URL!);
  const schema = url.searchParams.get('schema');
  url.searchParams.set('schema', 'public');
  if (url.toString() !== expected.toString() || !/^vnx05_synthetic_[0-9]+$/.test(schema ?? '')) {
    throw new Error('VNX05_SYNTHETIC_TARGET_INVALID');
  }
  database = new PrismaClient({ datasources: { db: { url: process.env.VNX05_TEST_SCHEMA_URL } } });
  const real = createPrismaLeadIntakeConsumerOperations(database, {
    allowedSecretRoot: process.env.VNX05_TEST_SECRET_ROOT,
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await runLeadIntakeConsumer({
      ...real,
      async project(lease, config) {
        if (process.argv[2] === 'crash-after-claim') process.kill(process.pid, 'SIGKILL');
        return real.project(lease, config);
      },
    }, { signal: controller.signal });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

void main().catch((error: unknown) => {
  process.exitCode = 1;
  writeLeadIntakeConsumerLog({
    event: 'VNX01_CONSUMER_REJECTED', status: 'REJECTED',
    failureCode: safeLeadIntakeConsumerFailureCode(error),
  });
}).finally(async () => {
  await database?.$disconnect();
  await root.$disconnect();
});
