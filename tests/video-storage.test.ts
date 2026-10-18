import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let folder: string;
let storage: typeof import('../src/lib/video-storage');
const mp4 = () => { const b = Buffer.alloc(32); b.writeUInt32BE(20); b.write('ftyp', 4); b.write('isom', 8); b.write('isom', 16); return b; };
before(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'fai-crm-video-'));
  process.env.STORAGE_PROVIDER = 'local'; process.env.LOCAL_DOCUMENT_STORAGE_ROOT = folder;
  storage = await import('../src/lib/video-storage');
});
after(async () => {
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(folder).startsWith('fai-crm-video-'));
  await rm(folder, { recursive: true, force: true });
});

test('private video uses the approved root and exact immutable bytes', async () => {
  const id = randomUUID(), bytes = mp4();
  const prepared = await storage.prepareVideoFile(new File([bytes], 'formazione.mp4', { type: 'text/html' }));
  assert.equal(prepared.mimeType, 'video/mp4');
  const saved = await storage.savePrivateVideoFile(id, prepared);
  assert.equal(saved.storagePath, 'videos/' + id);
  assert.deepEqual(await storage.readPrivateVideoFile(id, saved), bytes);
  assert.deepEqual(await storage.savePrivateVideoFile(id, prepared), saved);
});
test('reused file id cannot overwrite different bytes or forged hash', async () => {
  const id = randomUUID(), original = await storage.prepareVideoFile(new File([mp4()], 'a.mp4'));
  await storage.savePrivateVideoFile(id, original);
  const changed = mp4(); changed[31] = 1;
  const replacement = await storage.prepareVideoFile(new File([changed], 'a.mp4'));
  await assert.rejects(storage.savePrivateVideoFile(id, replacement));
  await assert.rejects(storage.savePrivateVideoFile(randomUUID(), { ...original, sha256: '0'.repeat(64) }));
  assert.deepEqual(await storage.readPrivateVideoFile(id, original), original.bytes);
});
test('changed stored size or hash is denied before any partial response', async () => {
  const id = randomUUID(), prepared = await storage.prepareVideoFile(new File([mp4()], 'a.mp4'));
  await storage.savePrivateVideoFile(id, prepared);
  const target = path.join(folder, 'videos', id), changed = mp4(); changed[31] = 1;
  await writeFile(target, changed);
  await assert.rejects(storage.readPrivateVideoFile(id, prepared));
  await writeFile(target, Buffer.alloc(33));
  await assert.rejects(storage.readPrivateVideoFile(id, prepared));
});
test('ids, active formats and directory files cannot escape the video namespace', async () => {
  for (const id of ['../secret', 'other/file', 'C:/secret', '00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => storage.videoStoragePath(id));
  }
  await assert.rejects(storage.prepareVideoFile(new File([mp4()], 'file.html')));
  const id = randomUUID(), prepared = await storage.prepareVideoFile(new File([mp4()], 'a.mp4'));
  await mkdir(path.join(folder, 'videos', id), { recursive: true });
  await assert.rejects(storage.readPrivateVideoFile(id, prepared));
  await assert.rejects(storage.savePrivateVideoFile(id, prepared));
});
