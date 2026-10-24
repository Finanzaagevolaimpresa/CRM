import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, mkdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';

// Isolated synthetic storage, never a configured production mount. Retain the
// test directory for inspection; no cleanup, provider or database is invoked.
let root: string;
let store: typeof import('../src/lib/technical-upload-storage').storeTechnicalUploadPrivateFile;
let read: typeof import('../src/lib/technical-upload-storage').readTechnicalUploadPrivateFile;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'fai-technical-upload-test-'));
  process.env.LOCAL_DOCUMENT_STORAGE_ROOT = root;
  process.env.STORAGE_PROVIDER = 'local';
  process.env.DOCUMENT_MAX_BYTES = '1024';
  ({ storeTechnicalUploadPrivateFile: store, readTechnicalUploadPrivateFile: read } = await import('../src/lib/technical-upload-storage'));
  await mkdir(path.join(root, 'technical-submissions', 'v1'), { recursive: true });
});
const bytes = Buffer.from('Synthetic technical file only');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const file = (letter: string, content = bytes) => ({ storageKey: `technical-submissions/v1/${letter.repeat(64)}`,
  bytes: content, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length });
const target = (key: string) => path.join(root, ...key.split('/'));

test('actual private storage preserves exact bytes and reuses only the same content', async () => {
  const input = file('a'), first = await store(input), second = await store(input);
  assert.equal(first.reusedExactBytes, false); assert.equal(second.reusedExactBytes, true);
  assert.deepEqual(await readFile(target(input.storageKey)), bytes);
  assert.deepEqual(Object.keys(first).sort(), ['reusedExactBytes', 'sha256', 'sizeBytes', 'storageKey']);
  assert.equal(first.sha256, sha256);
  assert.deepEqual(await readdir(root), ['technical-submissions']);
});
test('same command with other bytes cannot overwrite its private file', async () => {
  const input = file('b'); await store(input);
  await assert.rejects(store(file('b', Buffer.from('Changed technical content'))));
  assert.deepEqual(await readFile(target(input.storageKey)), bytes);
});
test('tampered intent, arbitrary paths and configured size overflow fail before writing', async () => {
  const input = file('c');
  for (const changed of [{ ...input, sha256: 'd'.repeat(64) }, { ...input, sizeBytes: bytes.length + 1 },
    { ...input, storageKey: '../public/file.pdf' }, { ...input, storageKey: 'communications/lead/id' },
    { ...input, storageKey: `technical-submissions/v1/${'c'.repeat(64)}/file.pdf` },
    file('c', Buffer.alloc(1025)), file('c', Buffer.alloc(0))]) await assert.rejects(store(changed));
  await assert.rejects(readFile(target(input.storageKey)), { code: 'ENOENT' });
});
test('incomplete prior file and directory collisions are retained and refused', async () => {
  const partial = file('d'); await writeFile(target(partial.storageKey), bytes.subarray(0, 3), { flag: 'wx' });
  await assert.rejects(store(partial));
  assert.deepEqual(await readFile(target(partial.storageKey)), bytes.subarray(0, 3));
  const directory = file('e'); await mkdir(target(directory.storageKey));
  await assert.rejects(store(directory));
});
test('hard-linked existing file is refused, even when its bytes match', {
  skip: process.platform === 'win32' ? 'Windows sandbox forbids hard links; required in Linux qualification' : false,
}, async () => {
  const first = file('f'); await store(first);
  const second = file('0'); await link(target(first.storageKey), target(second.storageKey));
  await assert.rejects(store(second));
  await assert.rejects(read(second));
  assert.deepEqual(await readFile(target(first.storageKey)), bytes);
});
test('concurrent different content has one winner and never two stored files', async () => {
  const a = file('1'), b = file('1', Buffer.from('Other competing technical bytes'));
  const results = await Promise.allSettled([store(a), store(b)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const saved = await readFile(target(a.storageKey));
  assert.ok(saved.equals(a.bytes) || saved.equals(b.bytes));
});

test('private read returns only the exact committed descriptor bytes without rewriting', async () => {
  const input = file('2'); await store(input);
  const before = await readdir(path.dirname(target(input.storageKey)));
  assert.deepEqual(await read(input), bytes);
  assert.deepEqual(await readdir(path.dirname(target(input.storageKey))), before);
});

test('private read rejects substituted hash and size, including same-length changed content', async () => {
  const input = file('3'); await store(input);
  await assert.rejects(read({ ...input, sha256: '0'.repeat(64) }));
  await assert.rejects(read({ ...input, sizeBytes: input.sizeBytes + 1 }));
  await writeFile(target(input.storageKey), Buffer.alloc(bytes.length, 'X'));
  await assert.rejects(read(input));
  assert.deepEqual(await readFile(target(input.storageKey)), Buffer.alloc(bytes.length, 'X'));
});

test('private read cannot alias ordinary documents or create a missing submission', async () => {
  const input = file('4'), before = await readdir(path.dirname(target(input.storageKey)));
  for (const key of [input.storageKey, '../outside/file.pdf', 'client/service/file.pdf', 'communications/client/id/file',
    'technical-submissions/v1/' + '4'.repeat(64) + '/file.pdf']) await assert.rejects(read({ ...input, storageKey: key }));
  assert.deepEqual(await readdir(path.dirname(target(input.storageKey))), before);
});

test('private read respects the current lower size limit and refuses a directory', async () => {
  const input = file('5'); await store(input);
  process.env.DOCUMENT_MAX_BYTES = String(bytes.length - 1);
  try { await assert.rejects(read(input)); }
  finally { process.env.DOCUMENT_MAX_BYTES = '1024'; }
  const directory = file('6'); await mkdir(target(directory.storageKey));
  await assert.rejects(read(directory));
});
