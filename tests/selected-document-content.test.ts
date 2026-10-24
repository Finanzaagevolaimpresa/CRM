import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedDocumentMode, selectedDocumentAccessLabel } from '../src/lib/selected-document-formats';
import { selectedDocumentResponseMime } from '../src/lib/selected-document-content';
import { clientDocumentSnapshotSchema } from '../src/lib/selective-client-document-policy';
import { practiceDocumentSnapshotSchema } from '../src/lib/selective-practice-document-policy';

test('existing passive snapshots keep their exact signed shape; no derived authorization is added', () => {
  const old = { documentId: 'd', versionId: 'v', version: 1, checksum: 'a'.repeat(64), stateHash: 'b'.repeat(64),
    title: 'Documento sintetico', fileName: 'file.pdf', mimeType: 'application/pdf', download: false };
  assert.deepEqual(clientDocumentSnapshotSchema.parse(old), old);
  const office = { ...old, fileName: 'file.docx', mimeType: 'application/octet-stream' };
  assert.deepEqual(clientDocumentSnapshotSchema.parse(office), office);
  assert.equal(clientDocumentSnapshotSchema.safeParse({ ...office, previewAllowed: true }).success, false);
  assert.equal(practiceDocumentSnapshotSchema.shape.mimeType.safeParse(office.mimeType).success, true);
});

test('only matching passive extension, media type and actual bytes can be rendered inline', () => {
  for (const [fileName, mimeType, bytes, expected] of [
    ['file.pdf', 'application/pdf', Buffer.from('%PDF-1.7\nSYNTHETIC'), 'application/pdf'],
    ['file.png', 'image/png', Buffer.from('89504e470d0a1a0a00', 'hex'), 'image/png'],
    ['file.JPEG', 'image/jpeg', Buffer.from('ffd8ffe0', 'hex'), 'image/jpeg'],
    ['file.txt', 'text/plain', Buffer.from('Sintetico è valido'), 'text/plain; charset=utf-8'],
  ] as const) {
    const d = { fileName, mimeType };
    assert.equal(selectedDocumentMode(d), 'preview');
    assert.equal(selectedDocumentResponseMime(d, bytes, false), expected);
    assert.equal(selectedDocumentResponseMime(d, bytes, true), 'application/octet-stream');
    assert.throws(() => selectedDocumentResponseMime(d, Buffer.from([0, 255]), false));
  }
});

test('supported Office, signed, XML, CSV, WEBP and archive files are attachment-only', () => {
  for (const [fileName, mimeType] of [
    ['file.doc', 'application/msword'], ['file.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['file.xls', 'application/vnd.ms-excel'], ['file.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['file.odt', 'application/vnd.oasis.opendocument.text'], ['file.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['file.p7m', 'application/pkcs7-mime'], ['file.xml', 'text/plain'], ['file.xml', 'application/xml'],
    ['file.csv', 'text/csv'], ['file.webp', 'image/webp'], ['file.zip', 'application/zip'],
  ]) {
    const d = { fileName, mimeType }, bytes = Buffer.from('EXACT_SYNTHETIC_BYTES');
    for (const mediaType of [mimeType, 'application/octet-stream']) {
      const candidate = { ...d, mimeType: mediaType };
      assert.equal(selectedDocumentMode(candidate), 'download');
      assert.throws(() => selectedDocumentResponseMime(candidate, bytes, false));
      assert.equal(selectedDocumentResponseMime(candidate, bytes, true), 'application/octet-stream');
    }
    assert.match(selectedDocumentAccessLabel(d, false), /Solo nome e versione.*download non consentito/);
    assert.match(selectedDocumentAccessLabel(d, true), /Download consentito.*anteprima non disponibile/);
  }
});

test('generic acquisition media type never promotes a file to inline, even when its bytes resemble PDF', () => {
  const d = { fileName: 'file.pdf', mimeType: 'application/octet-stream' }, bytes = Buffer.from('%PDF-1.7');
  assert.equal(selectedDocumentMode(d), 'download');
  assert.throws(() => selectedDocumentResponseMime(d, bytes, false));
  assert.equal(selectedDocumentResponseMime(d, bytes, true), 'application/octet-stream');
});

test('unapproved types, mismatched names, active formats, paths and unbounded bytes fail closed', () => {
  for (const [fileName, mimeType] of [['file.docx', 'application/pdf'], ['file.txt', 'image/png'],
    ['file.html', 'text/plain'], ['file.svg', 'image/svg+xml'], ['file.exe', 'application/octet-stream'],
    ['file.docm', 'application/octet-stream'], ['file.docx.exe', 'application/octet-stream'],
    ['../file.docx', 'application/octet-stream'], ['file\n.pdf', 'application/pdf'],
    ['file.pdf', 'text/html'], ['file.pdf', 'application/pdf; charset=utf-8']]) {
    const d = { fileName, mimeType };
    assert.equal(selectedDocumentMode(d), null);
    for (const download of [false, true]) assert.throws(() => selectedDocumentResponseMime(d, Buffer.from('%PDF-1.7'), download));
  }
  const d = { fileName: 'file.docx', mimeType: 'application/octet-stream' };
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(25 * 1024 * 1024 + 1)])
    for (const download of [false, true]) assert.throws(() => selectedDocumentResponseMime(d, bytes, download));
});
