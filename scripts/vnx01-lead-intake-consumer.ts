import { prisma } from '../src/lib/prisma';
import {
  createPrismaLeadIntakeConsumerOperations,
  runLeadIntakeConsumer,
  safeLeadIntakeConsumerFailureCode,
  writeLeadIntakeConsumerLog,
} from '../src/lib/lead-intake-consumer';

async function main() {
  // VNX-05 selection is parsed and frozen by runLeadIntakeConsumer before preflight.
  // This same manual entrypoint serves both explicitly scoped and ordinary runs.
  const controller = new AbortController();
  const requestShutdown = () => controller.abort();
  process.on('SIGINT', requestShutdown);
  process.on('SIGTERM', requestShutdown);
  try {
    await runLeadIntakeConsumer(
      createPrismaLeadIntakeConsumerOperations(prisma),
      { signal: controller.signal },
    );
  } finally {
    process.removeListener('SIGINT', requestShutdown);
    process.removeListener('SIGTERM', requestShutdown);
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.exitCode = 1;
  writeLeadIntakeConsumerLog({
    event: 'VNX01_CONSUMER_REJECTED',
    status: 'REJECTED',
    failureCode: safeLeadIntakeConsumerFailureCode(error),
  }, process.stderr);
});
