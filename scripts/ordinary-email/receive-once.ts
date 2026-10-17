import { PrismaClient } from '@prisma/client';
import { connect } from 'node:tls';
import { z } from 'zod';
import { loadActivePrivilegedStepUpKey } from '../../src/lib/application-key-registry';
import { receiveOrdinaryRegisterEmailOnce } from '../../src/lib/ordinary-email-inbound-runtime';

// Operational entry point only. No default stream, history policy, credentials,
// qualification writer, scheduler or retry. Deployment does not invoke it.
const db = new PrismaClient({ log: [] });
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--stream' || !z.string().uuid().safeParse(args[1]).success) throw new Error();
  const key = await loadActivePrivilegedStepUpKey(db);
  if (!key) throw new Error();
  const result = await receiveOrdinaryRegisterEmailOnce(db, args[1], key,
    { readEnvironment: () => process.env, connectTls: connect });
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(() => {
  process.stdout.write('{"status":"DENIED"}\n');
  process.exitCode = 1;
}).finally(async () => { await db.$disconnect(); });
