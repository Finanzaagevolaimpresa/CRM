import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fileSystem } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { readWorkflowServiceCredential } from '../../src/lib/workflow-service-authority';
import { serviceFingerprint, serviceMac, verifyServiceMac } from '../../src/lib/workflow-service-contract';

const syntheticKey = Buffer.alloc(32, 0x43), encoded = syntheticKey.toString('base64');
const names = ['WORKFLOW_SERVICE_EXECUTION_MODE', 'WORKFLOW_NATIVE_PREPARATION_MODE', 'WORKFLOW_SERVICE_CREDENTIAL_ID',
  'WORKFLOW_SERVICE_KEY_FILE', 'WORKFLOW_SERVICE_KEY_BASE64'] as const;
async function fixture(run: (value: { folder: string; path: string; id: string }) => Promise<void>) {
  assert.equal(typeof process.getuid, 'function', 'This suite requires real POSIX filesystem semantics.');
  const parent = await realpath(tmpdir()), folder = await mkdtemp(join(parent, 'fai-workflow-service-posix-'));
  const path = join(folder, 'synthetic-only.key'), id = randomUUID();
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    await writeFile(path, encoded + '\n', { mode: 0o600 }); await chmod(path, 0o600);
    process.env.WORKFLOW_SERVICE_EXECUTION_MODE = 'enabled'; process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'enabled';
    process.env.WORKFLOW_SERVICE_CREDENTIAL_ID = id; process.env.WORKFLOW_SERVICE_KEY_FILE = path;
    await run({ folder, path, id });
  } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    assert.equal(dirname(folder), parent); assert.match(folder, /fai-workflow-service-posix-[^/]+$/);
    await rm(folder, { recursive: true, force: true });
  }
}

test('service reader accepts a real private owned POSIX file and returns independent key material', async () => {
  await fixture(async ({ path, id }) => {
    const metadata = await lstat(path);
    assert.equal(metadata.uid, process.getuid!()); assert.equal(metadata.mode & 0o777, 0o600); assert.equal(metadata.nlink, 1);
    const first = await readWorkflowServiceCredential(); assert.equal(first.id, id); assert.deepEqual(first.key, syntheticKey);
    first.key.fill(0);
    assert.deepEqual((await readWorkflowServiceCredential()).key, syntheticKey);
  });
});

test('service reader rejects incorrect POSIX modes and a mismatching caller UID', async context => {
  await fixture(async ({ path }) => {
    for (const mode of [0o400, 0o644, 0o660, 0o604, 0o700]) {
      await chmod(path, mode); await assert.rejects(readWorkflowServiceCredential(), /WORKFLOW_SERVICE_DENIED/);
    }
    await chmod(path, 0o600);
    const posixProcess = process as NodeJS.Process & { getuid: () => number };
    const uid = posixProcess.getuid(), current = context.mock.method(posixProcess, 'getuid', () => uid + 1);
    try {
      context.diagnostic('File ownership and mode are real; only the mismatching caller UID is simulated. No chown or elevated privilege.');
      await assert.rejects(readWorkflowServiceCredential(), /WORKFLOW_SERVICE_DENIED/);
    } finally { current.mock.restore(); }
    assert.deepEqual((await readWorkflowServiceCredential()).key, syntheticKey);
  });
});

test('service reader rejects file and parent symlinks, hard links, relative paths and nonfiles', async () => {
  await fixture(async ({ folder, path }) => {
    const fileLink = join(folder, 'file-link.key'), parentLink = join(folder, 'parent-link');
    await symlink(path, fileLink); await symlink(folder, parentLink);
    const directory = join(folder, 'directory'); await mkdir(directory);
    for (const candidate of [fileLink, join(parentLink, 'synthetic-only.key'), relative(process.cwd(), path), directory]) {
      process.env.WORKFLOW_SERVICE_KEY_FILE = candidate;
      await assert.rejects(readWorkflowServiceCredential(), /WORKFLOW_SERVICE_DENIED/);
    }
    const hardLink = join(folder, 'hard-link.key'); await link(path, hardLink);
    for (const candidate of [path, hardLink]) {
      process.env.WORKFLOW_SERVICE_KEY_FILE = candidate;
      await assert.rejects(readWorkflowServiceCredential(), /WORKFLOW_SERVICE_DENIED/);
    }
    process.env.WORKFLOW_SERVICE_KEY_FILE = join(folder, 'absent.key');
    await assert.rejects(readWorkflowServiceCredential());
  });
});

test('service reader enforces bounded strict UTF-8 and canonical base64 for exactly 32 bytes', async () => {
  await fixture(async ({ path }) => {
    for (const invalid of [Buffer.alloc(39, 0x41), Buffer.alloc(129, 0x41), Buffer.alloc(44, 0xff),
      Buffer.from('!'.repeat(44)), Buffer.from(Buffer.alloc(31, 0x42).toString('base64')), Buffer.from(Buffer.alloc(33, 0x42).toString('base64')),
      Buffer.from(encoded.slice(0, 43)), Buffer.from(encoded.slice(0, -2) + 'N='), Buffer.from(encoded.slice(0, 10) + ' ' + encoded.slice(10)),
      Buffer.from(Buffer.alloc(32, 0xff).toString('base64').replaceAll('/', '_'))]) {
      await writeFile(path, invalid); await assert.rejects(readWorkflowServiceCredential());
    }
    await writeFile(path, encoded); assert.deepEqual((await readWorkflowServiceCredential()).key, syntheticKey);
  });
});

test('service reader rejects real metadata changes between lstat, open and the final descriptor check', async context => {
  for (const change of ['before-open-mode', 'after-read-mode', 'after-read-link'] as const) await fixture(async ({ folder, path }) => {
    const before = await lstat(path), originalOpen = fileSystem.open;
    let opened = false, read = false, changed = false;
    // Only timing is intercepted: open/read/lstat/fstat still execute against the
    // real private temporary file. No synthetic stat or read result is returned.
    const intercept = context.mock.method(fileSystem, 'open', async (...args: Parameters<typeof fileSystem.open>) => {
      if (String(args[0]) !== path) return originalOpen(...args);
      if (change === 'before-open-mode') { await chmod(path, 0o644); changed = true; }
      const handle = await originalOpen(...args); opened = true;
      const originalRead = handle.read;
      context.mock.method(handle, 'read', (async (...readArgs: unknown[]) => {
        const result = await Reflect.apply(originalRead, handle, readArgs); read = true;
        if (change === 'after-read-mode') { await chmod(path, 0o644); changed = true; }
        if (change === 'after-read-link') { await link(path, join(folder, 'concurrent-hard-link.key')); changed = true; }
        return result;
      }) as typeof handle.read);
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(readWorkflowServiceCredential(), /WORKFLOW_SERVICE_DENIED/);
      assert.equal(opened, true); assert.equal(changed, true); assert.equal(read, change !== 'before-open-mode');
      const after = await lstat(path);
      assert.equal(after.mtimeMs, before.mtimeMs); // chmod/link do not rewrite the bytes.
      if (change === 'after-read-link') assert.equal(after.nlink, 2); else assert.equal(after.mode & 0o777, 0o644);
    } finally { intercept.mock.restore(); syncBuiltinESMExports(); }
  });
});

test('service reader rereads replacement credentials and old proofs cannot authenticate the changed key', async () => {
  await fixture(async ({ path, id }) => {
    const first = await readWorkflowServiceCredential(), command = { grantId: randomUUID(), synthetic: true };
    const proof = serviceMac('invocation', command, first.key), replacement = Buffer.alloc(32, 0x44);
    await writeFile(path, replacement.toString('base64'));
    const second = await readWorkflowServiceCredential(); assert.equal(second.id, id); assert.deepEqual(second.key, replacement);
    assert.notEqual(serviceFingerprint(second.key), serviceFingerprint(first.key)); assert.deepEqual(first.key, syntheticKey);
    assert.throws(() => verifyServiceMac('invocation', command, proof, second.key), /WORKFLOW_SERVICE_PROOF_INVALID/);
    process.env.WORKFLOW_SERVICE_CREDENTIAL_ID = randomUUID();
    assert.notEqual((await readWorkflowServiceCredential()).id, first.id);
    await chmod(path, 0o644); await assert.rejects(readWorkflowServiceCredential(), /WORKFLOW_SERVICE_DENIED/);
  });
});

test('service reader rechecks both gates and never substitutes environment key material for its file', async () => {
  await fixture(async ({ path }) => {
    for (const name of ['WORKFLOW_SERVICE_EXECUTION_MODE', 'WORKFLOW_NATIVE_PREPARATION_MODE']) {
      for (const value of [undefined, '', 'disabled', 'true']) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
        await assert.rejects(readWorkflowServiceCredential(), /WORKFLOW_SERVICE_DISABLED/);
      }
      process.env[name] = 'enabled';
    }
    process.env.WORKFLOW_SERVICE_KEY_BASE64 = encoded; delete process.env.WORKFLOW_SERVICE_KEY_FILE;
    await assert.rejects(readWorkflowServiceCredential(), /WORKFLOW_SERVICE_DENIED/);
    process.env.WORKFLOW_SERVICE_KEY_FILE = path; delete process.env.WORKFLOW_SERVICE_CREDENTIAL_ID;
    await assert.rejects(readWorkflowServiceCredential());
  });
});
