import { PrismaClient } from '@prisma/client';
import {
  BusinessEventBackboneError,
  type BusinessQueueLeaseIdentity,
} from '../../src/lib/business-event-backbone';
import {
  acquireLeadIdentityWriteLock,
  hasStrongRawLeadIdentityDuplicate,
} from '../../src/lib/lead-identity';
import {
  LeadDuplicateResolutionError,
  resolveLeadDuplicateCase,
} from '../../src/lib/lead-duplicate-resolution';
import {
  LeadProjectionError,
  projectClaimedLeadInboxEvent,
} from '../../src/lib/lead-projection';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';

const [operation, encodedInput] = process.argv.slice(2);
const allowedOperations = new Set(['project', 'resolve', 'manual-create']);
const schemaUrl = process.env.N13_DB_TEST_SCHEMA_URL;
if (!allowedOperations.has(operation ?? '') || !encodedInput || !schemaUrl) process.exit(2);

let input: Record<string, unknown>;
try {
  input = JSON.parse(Buffer.from(encodedInput, 'base64url').toString('utf8')) as Record<string, unknown>;
} catch {
  process.exit(2);
}

const rootDb = new PrismaClient();
const db = new PrismaClient({ datasources: { db: { url: schemaUrl } } });

function requiredString(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_000) process.exit(2);
  return value;
}

function leaseFrom(value: unknown): BusinessQueueLeaseIdentity {
  if (!value || typeof value !== 'object') process.exit(2);
  const lease = value as Record<string, unknown>;
  if (lease.queueKind !== 'INBOX') process.exit(2);
  return {
    queueKind: 'INBOX',
    eventRowId: requiredString(lease.eventRowId),
    attemptId: requiredString(lease.attemptId),
    fencingToken: BigInt(requiredString(lease.fencingToken)),
    leaseOwnerId: requiredString(lease.leaseOwnerId),
    leaseToken: requiredString(lease.leaseToken),
  };
}

function writeOutcome(outcome: string) {
  process.stdout.write(JSON.stringify({ outcome }));
}

async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(rootDb);
  if (operation === 'project') {
    try {
      const result = await projectClaimedLeadInboxEvent(db, leaseFrom(input.lease), {
        keyFilePath: requiredString(input.keyFilePath),
        allowedSecretRoot: requiredString(input.allowedSecretRoot),
      });
      writeOutcome(result.result.state);
    } catch (error) {
      if (error instanceof BusinessEventBackboneError || error instanceof LeadProjectionError) {
        writeOutcome(error.code);
        return;
      }
      throw error;
    }
    return;
  }
  if (operation === 'manual-create') {
    const email = requiredString(input.email);
    const phone = input.phone === null ? null : requiredString(input.phone);
    const outcome = await db.$transaction(async (tx) => {
      await acquireLeadIdentityWriteLock(tx);
      if (await hasStrongRawLeadIdentityDuplicate(tx, { email, phone })) return 'DUPLICATE';
      await tx.lead.create({
        data: {
          firstName: 'Synthetic',
          lastName: 'MultiprocessManual',
          email,
          phone,
          source: 'N13_MULTIPROCESS_MANUAL',
        },
      });
      return 'CREATED';
    });
    writeOutcome(outcome);
    return;
  }
  try {
    const outcome = requiredString(input.outcome);
    if (outcome !== 'LINK_EXISTING_NO_OVERWRITE') process.exit(2);
    const result = await resolveLeadDuplicateCase(db, {
      caseId: requiredString(input.caseId),
      expectedCaseVersion: Number(input.expectedCaseVersion),
      outcome,
      selectedLeadId: requiredString(input.selectedLeadId),
      reasonCode: requiredString(input.reasonCode),
      actorUserId: requiredString(input.actorUserId),
      actorSessionId: requiredString(input.actorSessionId),
    }, {
      keyFilePath: requiredString(input.keyFilePath),
      allowedSecretRoot: requiredString(input.allowedSecretRoot),
    });
    writeOutcome(result.state);
  } catch (error) {
    if (error instanceof LeadDuplicateResolutionError) {
      writeOutcome(error.code);
      return;
    }
    throw error;
  }
}

void main()
  .catch(() => { process.exitCode = 1; })
  .finally(async () => {
    await Promise.all([db.$disconnect(), rootDb.$disconnect()]);
  });
