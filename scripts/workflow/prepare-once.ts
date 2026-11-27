import { PrismaClient } from '@prisma/client';
import { readWorkflowPreparationInput, runWorkflowPreparationCommand } from '../../src/lib/workflow-runner-command';

// An external scheduler is deliberately not installed. Each invocation needs a
// current genuine login token on stdin; never place it in argv, logs or files.
const db = new PrismaClient({ log: [] });
async function main() {
  if (process.argv.slice(2).join(' ') !== '--once') throw new Error();
  const timer = setTimeout(() => process.stdin.destroy(new Error('WORKFLOW_RUNNER_INPUT_DENIED')), 10_000);
  let raw: unknown;
  try { raw = await readWorkflowPreparationInput(process.stdin); }
  finally { clearTimeout(timer); }
  process.stdout.write(JSON.stringify(await runWorkflowPreparationCommand(db, raw)) + '\n');
}
main().catch(() => {
  // A lost result is not evidence of rollback; the durable native runner will
  // reconcile it on a later authorized invocation, without resending anything.
  process.stdout.write('{"status":"DENIED_OR_UNCONFIRMED","providerCalls":0}\n');
  process.exitCode = 1;
}).finally(async () => { await db.$disconnect(); });
