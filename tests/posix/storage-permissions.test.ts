import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let temporaryDirectory: string;
let storageRoot: string;
let storage: typeof import('../../src/lib/storage');

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'fai-crm-storage-'));
  storageRoot = path.join(temporaryDirectory, 'documents');
  process.env.STORAGE_PROVIDER = 'local';
  process.env.LOCAL_DOCUMENT_STORAGE_ROOT = storageRoot;
  storage = await import('../../src/lib/storage');
});

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test('salva una chiave root-relative con permessi privati e consente il round trip', async () => {
  const contents = Buffer.from('contenuto riservato FAI');
  const file = new File([contents], 'documento.pdf', { type: 'application/pdf' });
  const saved = await storage.savePrivateDocumentFile({
    file,
    clientId: 'cliente-1',
    clientServiceId: 'servizio-1',
    fileName: 'documento.pdf',
  });

  assert.match(saved.storagePath, /^cliente-1\/servizio-1\/[0-9a-f-]+-documento\.pdf$/);
  assert.equal(saved.storagePath.includes('\\'), false);
  assert.equal(saved.sizeBytes, contents.byteLength);
  assert.equal(saved.checksum, createHash('sha256').update(contents).digest('hex'));

  const absolutePath = storage.localPathFromStoragePath(saved.storagePath);
  assert.equal((await stat(path.dirname(absolutePath))).mode & 0o777, 0o700);
  assert.equal((await stat(absolutePath)).mode & 0o777, 0o600);
  assert.equal(await storage.privateDocumentExists(saved.storagePath), true);
  assert.deepEqual(await storage.readPrivateDocument(saved.storagePath), contents);
});
