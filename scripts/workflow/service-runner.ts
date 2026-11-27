import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:tls';
import { PrismaClient } from '@prisma/client';
import { loadActivePrivilegedStepUpKey } from '../../src/lib/application-key-registry';
import { assertWorkflowServiceEnabled,readWorkflowServiceCredential } from '../../src/lib/workflow-service-authority';
import { serviceFingerprint } from '../../src/lib/workflow-service-contract';
import { createWorkflowServiceCommand,dispatchWorkflowServiceGrants,runWorkflowServiceOnce } from '../../src/lib/workflow-service-runner';

/** Explicit process entry. Importing this file starts no loop, provider or DB.
 * Deployment must separately authorize installation and process supervision. */
export async function workflowServiceMain(args: string[]) {
  assertWorkflowServiceEnabled();
  if (args.length !== 1 || !['--once','--poll'].includes(args[0])) throw new Error('WORKFLOW_SERVICE_USAGE_ONCE_OR_POLL');
  const credential = await readWorkflowServiceCredential(), db = new PrismaClient(), stop = new AbortController();
  const abort = () => stop.abort(); process.once('SIGINT',abort); process.once('SIGTERM',abort);
  let cursor: string|undefined;
  try {
    do {
      assertWorkflowServiceEnabled();
      const nativeKey = await loadActivePrivilegedStepUpKey(db); if (!nativeKey) throw new Error('WORKFLOW_NATIVE_KEY_UNAVAILABLE');
      const runtime = { credential,nativeKey,assertCredentialCurrent: async () => {
        const current = await readWorkflowServiceCredential().catch(() => { throw new Error('WORKFLOW_SERVICE_CREDENTIAL_DENIED'); });
        if (current.id !== credential.id || serviceFingerprint(current.key) !== serviceFingerprint(credential.key)) throw new Error('WORKFLOW_SERVICE_CREDENTIAL_CHANGED');
      } };
      await runtime.assertCredentialCurrent();
      const currentCredential = await db.workflowServiceCredential.findUnique({ where: { id: credential.id } });
      if (!currentCredential || currentCredential.state !== 'ACTIVE' || currentCredential.validUntil <= new Date()
        || currentCredential.keyFingerprint !== serviceFingerprint(credential.key)) throw new Error('WORKFLOW_SERVICE_CREDENTIAL_DENIED');
      const select = (after?: string) => db.workflowServiceGrant.findMany({ where: { credentialId: credential.id,state: 'ACTIVE',
        validFrom: { lte: new Date() },validUntil: { gt: new Date() },...(after ? { id: { gt: after } } : {}) },select: { id: true },orderBy: { id: 'asc' },take: 50 });
      let grants = await select(cursor);
      if (!grants.length && cursor) grants=await select();
      cursor=grants.at(-1)?.id;
      await dispatchWorkflowServiceGrants(grants,async id => {
        if (stop.signal.aborted) throw new Error('WORKFLOW_SERVICE_STOPPED');
        const command = createWorkflowServiceCommand(id,runtime);
        return runWorkflowServiceOnce(db,command.invocation,command.proof,runtime,{ readEnvironment: () => process.env,connectTls: connect },stop.signal);
      },value => process.stdout.write(JSON.stringify(value)+'\n'));
      if (args[0] === '--once' || stop.signal.aborted) break;
      await delay(10000,undefined,{ signal: stop.signal });
    } while (!stop.signal.aborted);
  } finally {
    process.removeListener('SIGINT',abort); process.removeListener('SIGTERM',abort); await db.$disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  workflowServiceMain(process.argv.slice(2)).catch(error => {
    const code = error instanceof Error && /^WORKFLOW_[A-Z_]+$/.test(error.message) ? error.message : 'WORKFLOW_SERVICE_FAILED';
    process.stderr.write(code+'\n'); process.exitCode = 1;
  });
}
