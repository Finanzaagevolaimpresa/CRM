import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { canonicalJson, canonicalSha256 } from '../src/lib/canonical-json';
import { parseServiceInvocation, serviceMac, serviceFingerprint, verifyServiceMac, serviceGrantInput,
  serviceCredentialInput, type ServiceInvocation } from '../src/lib/workflow-service-contract';
import { assertWorkflowServiceEnabled, readWorkflowServiceCredential, type WorkflowServiceRuntime } from '../src/lib/workflow-service-authority';
import { createWorkflowServiceCommand,dispatchWorkflowServiceGrants } from '../src/lib/workflow-service-runner';
import { workflowServiceMain } from '../scripts/workflow/service-runner';

const key = Buffer.alloc(32, 0x42), now = new Date('2030-01-07T09:00:00.000Z');
const invocation = (patch: Partial<ServiceInvocation> = {}): ServiceInvocation => ({ protocol: 'FAI_WORKFLOW_SERVICE_INVOCATION_V1',
  id: '00000000-0000-4000-8000-000000000001', grantId: '00000000-0000-4000-8000-000000000002',
  issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300000).toISOString(), limit: 20, ...patch });
const parse = (value: ServiceInvocation, at = now) => parseServiceInvocation(value, serviceMac('invocation', value, key), key, at);
async function environment(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

test('service MAC binds the exact command, key and protocol domain using canonical JSON', () => {
  const command = invocation(), proof = serviceMac('invocation', command, key);
  assert.equal(proof, createHmac('sha256', key).update('FAI_WORKFLOW_SERVICE_V1\0invocation\0' + canonicalJson(command)).digest('hex'));
  assert.equal(serviceMac('invocation', Object.fromEntries(Object.entries(command).reverse()), key), proof);
  assert.notEqual(serviceMac('decision', command, key), proof);
  assert.doesNotThrow(() => verifyServiceMac('invocation', command, proof, key));
  for (const patch of [{ id: randomUUID() }, { grantId: randomUUID() }, { issuedAt: '2030-01-07T09:00:00.001Z' },
    { expiresAt: '2030-01-07T09:04:59.999Z' }, { limit: 21 }, { protocol: 'OTHER_PROTOCOL' }]) {
    assert.throws(() => verifyServiceMac('invocation', { ...command, ...patch }, proof, key), /WORKFLOW_SERVICE_PROOF_INVALID/);
  }
  assert.throws(() => verifyServiceMac('decision', command, proof, key), /WORKFLOW_SERVICE_PROOF_INVALID/);
  assert.throws(() => verifyServiceMac('invocation', command, proof, Buffer.alloc(32, 0x43)), /WORKFLOW_SERVICE_PROOF_INVALID/);
  for (const malformed of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), proof.toUpperCase()])
    assert.throws(() => verifyServiceMac('invocation', command, malformed, key), /WORKFLOW_SERVICE_PROOF_INVALID/);
  for (const length of [0, 31, 33]) assert.throws(() => serviceMac('invocation', command, Buffer.alloc(length)), /WORKFLOW_SERVICE_KEY_INVALID/);
});

test('service invocation enforces its five-minute lifetime, exact fields and bounded work', () => {
  const command = invocation(), result = parse(command);
  assert.deepEqual(result.input, command); assert.equal(result.requestHash, canonicalSha256(command));
  assert.doesNotThrow(() => parse(command, new Date(now.getTime() + 299999)));
  for (const at of [new Date(now.getTime() - 1), new Date(now.getTime() + 300000)])
    assert.throws(() => parse(command, at), /WORKFLOW_SERVICE_INVOCATION_EXPIRED/);
  for (const duration of [-1, 0, 300001])
    assert.throws(() => parse(invocation({ expiresAt: new Date(now.getTime() + duration).toISOString() })), /WORKFLOW_SERVICE_INVOCATION_EXPIRED/);
  for (const limit of [1, 50]) assert.equal(parse(invocation({ limit })).input.limit, limit);
  for (const limit of [0, 51, 1.5, NaN, Infinity]) assert.throws(() => parse(invocation({ limit })));
  for (const field of ['recipient', 'body', 'provider', 'sessionId', 'sql']) {
    const widened = { ...command, [field]: 'synthetic-only' };
    assert.throws(() => parseServiceInvocation(widened, serviceMac('invocation', widened, key), key, now));
  }
  assert.throws(() => parse({ ...command, grantId: 'not-a-grant' }));
});

test('service registration and grant contracts require explicit approval and finite positive quotas', () => {
  const credential = { id: randomUUID(), keyFingerprint: serviceFingerprint(key), validUntil: '2030-01-08T09:00:00.000Z',
    qualificationReference: 'SYNTHETIC-QUALIFICATION', approved: true };
  const grant = { id: randomUUID(), automationId: randomUUID(), expectedVersion: 1, credentialId: credential.id,
    validFrom: now.toISOString(), validUntil: credential.validUntil, maxMessages: 100000, maxPerDay: 1,
    approvalReference: 'SYNTHETIC-APPROVAL', approved: true };
  assert.deepEqual(serviceCredentialInput.parse(credential), credential); assert.deepEqual(serviceGrantInput.parse(grant), grant);
  for (const approved of [false, undefined]) {
    assert.throws(() => serviceCredentialInput.parse({ ...credential, approved }));
    assert.throws(() => serviceGrantInput.parse({ ...grant, approved }));
  }
  for (const limit of [0, 100001, 1.5]) for (const field of ['maxMessages', 'maxPerDay'])
    assert.throws(() => serviceGrantInput.parse({ ...grant, [field]: limit }));
  assert.throws(() => serviceCredentialInput.parse({ ...credential, key: key.toString('base64') }));
  assert.throws(() => serviceGrantInput.parse({ ...grant, recipients: ['synthetic@invalid.test'] }));
});

test('service constructor signs a fresh bounded grant command without reading files or credentials', () => {
  let reads = 0;
  const runtime: WorkflowServiceRuntime = { credential: { id: randomUUID(), key }, nativeKey: { version: 1, secret: 'synthetic-not-used' },
    assertCredentialCurrent: async () => { reads++; throw new Error('UNEXPECTED_CREDENTIAL_READ'); } };
  const first = createWorkflowServiceCommand(invocation().grantId, runtime, now), second = createWorkflowServiceCommand(invocation().grantId, runtime, now, 50);
  assert.notEqual(first.invocation.id, second.invocation.id); assert.equal(first.invocation.limit, 20);
  assert.equal(Date.parse(first.invocation.expiresAt) - Date.parse(first.invocation.issuedAt), 300000);
  assert.equal(parseServiceInvocation(second.invocation, second.proof, key, now).input.limit, 50); assert.equal(reads, 0);
});

test('service dispatch isolates expected individual grant denials and continues once without retry', async () => {
  for (const reason of ['WORKFLOW_SERVICE_DENIED','WORKFLOW_SOURCE_CHANGED','WORKFLOW_RULE_PAUSED','WORKFLOW_SERVICE_QUOTA',
    'NEWSLETTER_POLICY_UNAVAILABLE','NEWSLETTER_NATIVE_ADMISSION_DENIED','ORDINARY_EMAIL_TRANSPORT_UNAVAILABLE']) {
    const calls: string[] = [],reports: unknown[] = [];
    await dispatchWorkflowServiceGrants([{ id: 'stale' },{ id: 'valid' }],async id => {
      calls.push(id); if (id === 'stale') throw new Error(reason);
      return { accepted: 1,uncertain: 0 };
    },value => reports.push(value));
    assert.deepEqual(calls,['stale','valid']);
    assert.deepEqual(reports,[{ held: reason },{ result: { accepted: 1,uncertain: 0 } }]);
  }
});

test('service dispatch stops on global gate, credentials, native keys and unknown database failures', async () => {
  for (const reason of ['WORKFLOW_SERVICE_DISABLED','WORKFLOW_SERVICE_CREDENTIAL_DENIED','WORKFLOW_SERVICE_CREDENTIAL_CHANGED',
    'WORKFLOW_NATIVE_KEY_UNAVAILABLE','WORKFLOW_SERVICE_PROOF_INVALID','WORKFLOW_SERVICE_STOPPED','SYNTHETIC_DATABASE_FAILURE']) {
    const failure = new Error(reason),calls: string[] = [],reports: unknown[] = [];
    await assert.rejects(dispatchWorkflowServiceGrants([{ id: 'first' },{ id: 'must-not-run' }],async id => {
      calls.push(id); throw failure;
    },value => reports.push(value)),error => error === failure);
    assert.deepEqual(calls,['first']); assert.deepEqual(reports,[]);
  }
});

test('service and native gates must both be explicitly enabled before CLI or credential admission', async () => {
  for (const [service, native] of [[undefined, undefined], ['enabled', undefined], [undefined, 'enabled'], ['disabled', 'enabled'],
    ['enabled', 'disabled'], ['', 'enabled'], ['ENABLED', 'enabled'], ['enabled', 'true']]) {
    await environment({ WORKFLOW_SERVICE_EXECUTION_MODE: service, WORKFLOW_NATIVE_PREPARATION_MODE: native,
      WORKFLOW_SERVICE_CREDENTIAL_ID: 'invalid-and-must-not-be-parsed', WORKFLOW_SERVICE_KEY_FILE: 'not-an-absolute-file' }, async () => {
      assert.throws(assertWorkflowServiceEnabled, /WORKFLOW_SERVICE_DISABLED/);
      await assert.rejects(readWorkflowServiceCredential(), /WORKFLOW_SERVICE_DISABLED/);
      await assert.rejects(workflowServiceMain(['--once']), /WORKFLOW_SERVICE_DISABLED/);
    });
  }
  await environment({ WORKFLOW_SERVICE_EXECUTION_MODE: 'enabled', WORKFLOW_NATIVE_PREPARATION_MODE: 'enabled' }, async () => {
    assert.doesNotThrow(assertWorkflowServiceEnabled);
    for (const args of [[], ['--invalid'], ['--once', '--poll']])
      await assert.rejects(workflowServiceMain(args), /WORKFLOW_SERVICE_USAGE_ONCE_OR_POLL/);
  });
});

test('credential reader refuses a platform without POSIX identity, including actual Windows', async context => {
  const folder = await mkdtemp(join(tmpdir(), 'fai-workflow-service-command-'));
  const path = join(folder, 'synthetic-only.key');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  try {
    await writeFile(path, key.toString('base64'), { mode: 0o600 });
    if (typeof process.getuid === 'function') {
      Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
      context.diagnostic('POSIX host: only the unavailable identity API is simulated; the temporary file is real.');
    } else context.diagnostic('Windows host: native absence of POSIX identity is exercised.');
    await environment({ WORKFLOW_SERVICE_EXECUTION_MODE: 'enabled', WORKFLOW_NATIVE_PREPARATION_MODE: 'enabled',
      WORKFLOW_SERVICE_CREDENTIAL_ID: randomUUID(), WORKFLOW_SERVICE_KEY_FILE: path }, async () => {
      await assert.rejects(readWorkflowServiceCredential(), /WORKFLOW_SERVICE_DENIED/);
    });
  } finally {
    if (descriptor) Object.defineProperty(process, 'getuid', descriptor); else Reflect.deleteProperty(process, 'getuid');
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.match(folder, /fai-workflow-service-command-[^/\\]+$/);
    await rm(folder, { recursive: true, force: true });
  }
});

test('importing the actual service CLI starts no loop; direct CLI failures emit only sanitized codes', () => {
  const script = resolve('scripts/workflow/service-runner.ts');
  const env = { ...process.env, DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/never_connect',
    WORKFLOW_SERVICE_EXECUTION_MODE: 'enabled', WORKFLOW_NATIVE_PREPARATION_MODE: 'enabled',
    WORKFLOW_SERVICE_CREDENTIAL_ID: 'SYNTHETIC_SECRET_SENTINEL', WORKFLOW_SERVICE_KEY_FILE: resolve('synthetic-not-present-SENTINEL.key') };
  const source = `const before = process.listenerCount('SIGINT'); await import(${JSON.stringify(pathToFileURL(script).href)}); if (process.listenerCount('SIGINT') !== before) throw new Error('UNEXPECTED_PROCESS_START'); process.stdout.write('IMPORTED_WITHOUT_START\\n');`;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source],
    { cwd: process.cwd(), env, encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(output, 'IMPORTED_WITHOUT_START\n');
  for (const [args, expected, selected] of [
    [['--once'], 'WORKFLOW_SERVICE_FAILED', env],
    [['--invalid'], 'WORKFLOW_SERVICE_USAGE_ONCE_OR_POLL', env],
    [['--poll'], 'WORKFLOW_SERVICE_DISABLED', { ...env, WORKFLOW_SERVICE_EXECUTION_MODE: 'disabled' }],
  ] as const) {
    assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', script, ...args],
      { cwd: process.cwd(), env: selected, encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), (error: unknown) => {
        const failure = error as { status?: number; stdout?: string; stderr?: string; signal?: unknown };
        assert.equal(failure.status, 1); assert.equal(failure.signal, null);
        assert.equal(failure.stdout, ''); assert.equal(failure.stderr, expected + '\n');
        assert.doesNotMatch(failure.stderr!, /SENTINEL|synthetic:|postgresql|Error:|\bat\b/);
        return true;
      });
  }
});
