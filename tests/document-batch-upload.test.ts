import assert from 'node:assert/strict';
import test from 'node:test';
import { documentUploadMaxBytes, uploadSelection, validateUploadSelection, type UploadProgress } from '../src/lib/document-upload-contract';

test('bounded selection accepts multiple PDFs and ZIP, rejects empty, oversized and executable files before sending', () => {
  assert.equal(validateUploadSelection([{ name: 'one.pdf', size: 2 }, { name: 'two.ZIP', size: 30 }]), null);
  assert.ok(validateUploadSelection([]));
  assert.ok(validateUploadSelection([{ name: 'empty.pdf', size: 0 }]));
  assert.ok(validateUploadSelection([{ name: 'large.zip', size: documentUploadMaxBytes + 1 }]));
  assert.ok(validateUploadSelection([{ name: 'run.exe', size: 1 }]));
  assert.ok(validateUploadSelection(Array.from({ length: 21 }, () => ({ name: 'file.pdf', size: 1 }))));
});

test('one user submission sends all files with per-file titles, shared context and distinct outcomes', async () => {
  const files = ['first.pdf', 'second.zip', 'third.txt'].map(name => new File(['synthetic'], name));
  const metadata = new FormData(); metadata.set('clientId', 'client'); metadata.set('clientServiceId', 'service'); metadata.set('title', 'Materiali');
  metadata.append('file', files[0]); metadata.append('file', files[1]);
  const sent: FormData[] = [], results: UploadProgress[] = [];
  await uploadSelection(files, metadata, async form => { sent.push(form); return sent.length === 2 ? { ok: false, message: 'Formato non valido' } : { ok: true }; }, value => results.push(value));
  assert.equal(sent.length, 3);
  sent.forEach((form, index) => { assert.equal(form.getAll('file').length, 1); assert.equal((form.get('file') as File).name, files[index].name); assert.equal(form.get('clientId'), 'client'); assert.equal(form.get('clientServiceId'), 'service'); assert.equal(form.get('title'), `Materiali — ${files[index].name}`); });
  assert.deepEqual(results.map(x => x.result.ok), [true, false, true]);
});

test('uncertain network outcome stops the batch and never retries an already sent file', async () => {
  let calls = 0; const results: UploadProgress[] = [];
  await uploadSelection(['a.pdf', 'b.pdf', 'c.pdf'].map(name => new File(['synthetic'], name)), new FormData(), async form => {
    calls++; assert.equal(form.get('title'), (form.get('file') as File).name);
    if (calls === 2) throw new Error('lost response');
    return { ok: true };
  }, value => results.push(value));
  assert.equal(calls, 2); assert.equal(results.length, 2); assert.equal(results[0].result.ok, true); assert.equal(results[1].result.ok, false);
});

test('invalid selection cannot cause a partial upload', async () => {
  let sent = false;
  await assert.rejects(uploadSelection([new File(['x'], 'valid.pdf'), new File(['x'], 'bad.exe')], new FormData(), async () => { sent = true; return { ok: true }; }, () => {}), /formato non consentito/);
  assert.equal(sent, false);
});
