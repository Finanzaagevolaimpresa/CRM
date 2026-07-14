import { prisma } from '../src/lib/prisma';
import { reconcileExpiredAiRuns } from '../src/lib/ai-run-reliability';

async function main() {
  const reconciledRuns = await reconcileExpiredAiRuns({ batchSize: 100 });
  console.log(JSON.stringify({ reconciledRuns }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'AI run reconciliation failed.');
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
