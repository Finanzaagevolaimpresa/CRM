import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let temporaryDirectory: string;
let storageRoot: string;
let storage: typeof import('../src/lib/storage');

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'fai-crm-storage-'));
  storageRoot = path.join(temporaryDirectory, 'documents');
  process.env.STORAGE_PROVIDER = 'local';
  process.env.LOCAL_DOCUMENT_STORAGE_ROOT = storageRoot;
  storage = await import('../src/lib/storage');
});

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test('sanitizza il nome originale senza conservare separatori di percorso', () => {
  assert.equal(storage.sanitizeFileName('../fattura \\ finale?.pdf'), 'fattura finale_.pdf');
  assert.equal(storage.sanitizeFileName(''), 'documento');
});

test('accetta soltanto nomi upload con estensioni consentite', () => {
  assert.doesNotThrow(() => storage.assertSafeUploadName('documento.pdf'));
  for (const fileName of ['../documento.pdf', 'cartella/documento.pdf', 'documento.exe', 'documento']) {
    assert.throws(() => storage.assertSafeUploadName(fileName), /non valid|non consentita/);
  }
});

test('risolve chiavi POSIX relative alla root e mantiene la compatibilita con le chiavi legacy', () => {
  assert.equal(path.isAbsolute(storageRoot), true);
  const expected = path.join(storageRoot, 'cliente-1', 'generale', 'documento.pdf');
  assert.equal(storage.localPathFromStoragePath('cliente-1/generale/documento.pdf'), expected);
  assert.equal(storage.localPathFromStoragePath('storage/private/documents/cliente-1/generale/documento.pdf'), expected);
  assert.equal(storage.localPathFromStoragePath('storage\\private\\documents\\cliente-1\\generale\\documento.pdf'), expected);
});

test('rifiuta traversal, percorsi assoluti, NUL, segmenti non validi e ID iniettati', async () => {
  const unsafePaths = [
    '../segreto.pdf',
    'cliente/../segreto.pdf',
    '/etc/passwd',
    'C:/Windows/system.ini',
    'C:\\Windows\\system.ini',
    '\\\\server\\share\\documento.pdf',
    'cliente//documento.pdf',
    'cliente/./documento.pdf',
    'cliente/documento.pdf\0nascosto',
  ];

  for (const unsafePath of unsafePaths) assert.throws(() => storage.localPathFromStoragePath(unsafePath), /Storage path non valido/);

  const file = new File(['contenuto'], 'documento.pdf', { type: 'application/pdf' });
  for (const clientId of ['../cliente', 'cliente/secondario', 'cliente\\secondario', '.', `cliente\0nascosto`]) {
    await assert.rejects(
      storage.savePrivateDocumentFile({ file, clientId, clientServiceId: 'servizio-1', fileName: 'documento.pdf' }),
      /Client ID non valido/,
    );
  }
  for (const clientServiceId of ['../servizio', 'servizio/secondario', 'servizio\\secondario', '..']) {
    await assert.rejects(
      storage.savePrivateDocumentFile({ file, clientId: 'cliente-1', clientServiceId, fileName: 'documento.pdf' }),
      /Client service ID non valido/,
    );
  }
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
