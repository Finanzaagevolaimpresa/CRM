import { PrismaClient } from '@prisma/client';
import { canonicalSha256 } from '../../src/lib/canonical-json';
import { loadActivePrivilegedStepUpKey } from '../../src/lib/application-key-registry';
import { activateOrdinaryEmail } from '../../src/lib/ordinary-email-activation';

// Reviewed operator input over stdin only. No default binding, self-approval,
// provider call, environment mutation or automatic retry.
const db = new PrismaClient({ log: [] });
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--plan-sha256' || !/^[a-f0-9]{64}$/.test(args[1])) throw new Error();
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 16_384) throw new Error();
    chunks.push(bytes);
  }
  const plan: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (canonicalSha256(plan) !== args[1]) throw new Error();
  const key = await loadActivePrivilegedStepUpKey(db);
  if (!key) throw new Error();
  const result = await activateOrdinaryEmail(db, plan, args[1], key, process.env);
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(() => {
  process.stdout.write('{"status":"DENIED"}\n'); process.exitCode = 1;
}).finally(async () => { await db.$disconnect(); });
