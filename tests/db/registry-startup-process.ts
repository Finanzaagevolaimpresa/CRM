import { prisma } from '../../src/lib/prisma';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';
import { register } from '../../src/instrumentation';
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(prisma);
  await register();
  process.stdout.write('PRELAUNCH_REGISTRY_STARTUP_ADMITTED\n');
}
void main().catch(() => { process.stderr.write('PRELAUNCH_REGISTRY_STARTUP_DENIED\n'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
