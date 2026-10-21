import test from 'node:test';
import assert from 'node:assert/strict';
import { documentPreviewMaxBytes, documentPreviewMime } from '../src/lib/document-preview';

test('inline preview refuses active formats and mismatched extensions, independently of claimed MIME', () => {
  for (const name of ['file.html', 'file.svg', 'file.xml', 'file.docx', 'file.zip', 'file.pdf']) {
    assert.equal(documentPreviewMime(name, Buffer.from('<script>parent.location="https://example.test"</script>')), null);
  }
  assert.equal(documentPreviewMime('file.jpg', Buffer.from('%PDF-1.4')), null);
  assert.equal(documentPreviewMime('file.txt', Buffer.from([0xff, 0xfe])), null);
  assert.equal(documentPreviewMime('file.txt', Buffer.from([65, 0, 66])), null);
  assert.equal(documentPreviewMime('file.txt', Buffer.alloc(documentPreviewMaxBytes + 1, 65)), null);
});
test('passive preview accepts signature-bound formats and renders markup text as plain text', () => {
  assert.equal(documentPreviewMime('CONTRATTO.PDF', Buffer.from('%PDF-1.7\n%%EOF')), 'application/pdf');
  assert.equal(documentPreviewMime('prova.png', Buffer.from('89504e470d0a1a0a', 'hex')), 'image/png');
  assert.equal(documentPreviewMime('prova.jpeg', Buffer.from([255, 216, 255])), 'image/jpeg');
  assert.equal(documentPreviewMime('note.txt', Buffer.from('<script>non eseguire</script>')), 'text/plain; charset=utf-8');
});
