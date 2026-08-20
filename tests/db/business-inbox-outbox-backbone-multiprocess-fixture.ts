import { PrismaClient } from '@prisma/client';
import {
  BusinessEventBackboneError,
  admitBusinessInboxEvent,
  claimBusinessQueueEvent,
} from '../../src/lib/business-event-backbone';
import { createLeadSubmittedEventV1 } from '../../src/lib/lead-event-contract';
import { syntheticLeadEventInputV1 } from '../fixtures/n10-lead-event-v1';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';

const [scenario, rawWorker] = process.argv.slice(2);
const worker = Number(rawWorker);
const allowedScenarios = new Set([
  'admit-same',
  'admit-conflict',
  'claim-inbox',
  'claim-outbox',
]);
if (!allowedScenarios.has(scenario ?? '') || !Number.isInteger(worker) || worker < 0 || worker > 31) {
  process.exit(2);
}

const db = new PrismaClient();

function commonEvent(conflicting: boolean) {
  const input = syntheticLeadEventInputV1();
  return createLeadSubmittedEventV1({
    ...input,
    eventId: '00000000-0000-4000-8000-000000009001',
    businessCorrelationId: '00000000-0000-4000-8000-000000009002',
    source: { ...input.source, submissionId: 'N11-MULTIPROCESS-COMMON' },
    payload: {
      ...input.payload,
      email: 'multiprocess@n11.invalid',
      message: conflicting && worker % 2 === 1
        ? 'Synthetic multiprocess divergent payload.'
        : 'Synthetic multiprocess common payload.',
    },
  });
}

async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  if (scenario === 'admit-same' || scenario === 'admit-conflict') {
    try {
      const result = await admitBusinessInboxEvent(db, commonEvent(scenario === 'admit-conflict'));
      process.stdout.write(JSON.stringify({ [result.outcome]: 1 }));
    } catch (error) {
      if (
        error instanceof BusinessEventBackboneError
        && error.code === 'BUSINESS_INBOX_IDEMPOTENCY_CONFLICT'
      ) {
        process.stdout.write(JSON.stringify({ CONFLICT: 1 }));
        return;
      }
      throw error;
    }
    return;
  }
  const queueKind = scenario === 'claim-inbox' ? 'INBOX' : 'OUTBOX';
  const lease = await claimBusinessQueueEvent(db, {
    queueKind,
    leaseOwnerId: `00000000-0000-4000-8000-${(9_100 + worker).toString().padStart(12, '0')}`,
  });
  process.stdout.write(JSON.stringify({ [lease ? 'LEASED' : 'EMPTY']: 1 }));
}

void main()
  .catch(() => { process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
