import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { previewTechnicalUploadDeposit, confirmTechnicalUploadDeposit } from '../src/lib/technical-upload-plan';
import type { TechnicalUploadAdmission } from '../src/lib/technical-upload-contract';

const now = Date.parse('2026-10-24T10:00:00.000Z');
const key = { version: 2, secret: 'synthetic-upload-plan-key-material-only' };
const bytes = Buffer.from('%PDF-1.4\nSynthetic technical document\n%%EOF\n');
const input = { commandId: 'b04df201-b679-41ca-9c9f-edbcf0b6a0da',
  assignmentId: 'a6ef69e8-7915-4dc9-bbe7-f636d39c274a', assignmentRevision: 2,
  expectedContextSha256: 'a'.repeat(64), title: 'Elaborato tecnico', action: 'deposit_private_document' };
const current: TechnicalUploadAdmission = { target: { kind: 'Project', targetId: 'synthetic-project' },
  actorId: 'synthetic-tech-a', sessionId: '83b20770-f7bc-44ae-b388-45a6eca8ec4f',
  assignmentId: input.assignmentId, assignmentRevision: 2, assignmentStateSha256: 'b'.repeat(64),
  authorityRevision: 3, actorEpoch: 4, authorEpoch: 5, keyVersion: key.version,
  contextSha256: input.expectedContextSha256, scopeGeneration: 2,
  profile: { purpose: 'Elaborati del progetto', formats: ['.pdf', '.txt'], maxFileBytes: 1024,
    maxFilesPerRevision: 3, maxBytesPerRevision: 2048, visibility: 'PRIVATE_PENDING_ADMIN_REVIEW' },
  consumedFiles: 0, consumedBytes: 0, validUntil: now + 600_000 };
const preview = previewTechnicalUploadDeposit(key, input, 'Relazione.pdf', bytes, current, now);
const confirm = (data = bytes, state = current, time = now + 1) =>
  confirmTechnicalUploadDeposit(key, preview.command, preview.token, data, true, state, time);

test('preview describes server-observed bytes, remaining quota and private purpose', () => {
  assert.deepEqual(preview.summary, { title: input.title, fileName: 'Relazione.pdf', sizeBytes: bytes.length,
    contentSha256: createHash('sha256').update(bytes).digest('hex'), purpose: current.profile.purpose,
    visibility: 'PRIVATE_PENDING_ADMIN_REVIEW', remainingFilesAfter: 2, remainingBytesAfter: 2048 - bytes.length });
  assert.throws(() => previewTechnicalUploadDeposit(key, { ...input, file: preview.command.file }, 'Relazione.pdf', bytes, current, now));
});
test('confirmation yields only a private write intent, not a persisted receipt or publication', () => {
  const plan = confirm(); assert.ok(plan);
  assert.deepEqual(Buffer.from(plan.privateFile.bytes), bytes);
  assert.match(plan.privateFile.storageKey, /^technical-submissions\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}$/);
  assert.deepEqual(plan.quota, { assignmentId: input.assignmentId, revision: 2,
    filesBefore: 0, bytesBefore: 0, filesAfter: 1, bytesAfter: bytes.length });
  assert.deepEqual(plan.audit, { action: 'deposit_private_document', fileCount: 1 });
  for (const name of ['receipt', 'documentId', 'versionId', 'recipients', 'publicUrl', 'status', 'send']) {
    assert.equal(Object.hasOwn(plan, name), false);
  }
});
test('changed bytes, length and invalid file format after preview are rejected', () => {
  const sameSize = Buffer.from(bytes); sameSize[20] ^= 1;
  for (const changed of [sameSize, Buffer.concat([bytes, Buffer.from('x')]), bytes.subarray(0, 20),
    Buffer.from('not a PDF'), Buffer.alloc(0)]) assert.equal(confirm(changed), null);
});
test('the caller cannot mutate already planned bytes through its original buffer', () => {
  const supplied = Buffer.from(bytes), plan = confirm(supplied); assert.ok(plan);
  supplied.fill(0);
  assert.deepEqual(Buffer.from(plan.privateFile.bytes), bytes);
  assert.equal(createHash('sha256').update(plan.privateFile.bytes).digest('hex'), plan.privateFile.sha256);
});
test('confirmation cannot swap title, file name, command or descriptor behind another preview', () => {
  for (const delta of [{ title: 'Other title' }, { commandId: '4286fc51-78cd-46f4-9cb1-6d411349a41e' },
    { file: { ...preview.command.file, fileName: 'Another.pdf' } },
    { file: { ...preview.command.file, contentSha256: 'd'.repeat(64) } }]) {
    assert.equal(confirmTechnicalUploadDeposit(key, { ...preview.command, ...delta }, preview.token, bytes, true, current, now + 1), null);
  }
  assert.equal(confirmTechnicalUploadDeposit(key, preview.command, preview.token, bytes, false, current, now + 1), null);
});
test('concurrent quota, revocation, assignment or target change denies the write intent', () => {
  for (const delta of [{ consumedFiles: 1, consumedBytes: bytes.length }, { authorityRevision: 4 },
    { assignmentRevision: 3 }, { scopeGeneration: 3 }, { assignmentStateSha256: 'd'.repeat(64) },
    { actorId: 'synthetic-tech-b' }, { target: { ...current.target, targetId: 'other-project' } },
    { validUntil: now }]) assert.equal(confirm(bytes, { ...current, ...delta }), null);
  assert.equal(confirm(bytes, current, now + 300_000), null);
});
test('same actor session target and command retain one storage identity on retry', () => {
  const first = confirm(), again = confirm(); assert.ok(first && again);
  assert.equal(first.privateFile.storageKey, again.privateFile.storageKey);
  assert.equal(first.requestDigest, again.requestDigest);
  const newBytes = Buffer.concat([bytes, Buffer.from('changed')]);
  const newPreview = previewTechnicalUploadDeposit(key, input, 'Different.pdf', newBytes, current, now);
  const changed = confirmTechnicalUploadDeposit(key, newPreview.command, newPreview.token, newBytes, true, current, now + 1);
  assert.ok(changed);
  assert.equal(changed.privateFile.storageKey, first.privateFile.storageKey);
  assert.notEqual(changed.requestDigest, first.requestDigest);
  // The future exclusive storage/database boundary must reject this conflicting
  // identity. The pure plan must not evade that boundary with a content key.
});
test('other actors and sessions never share private storage identities', () => {
  const first = confirm(); assert.ok(first);
  for (const delta of [{ actorId: 'synthetic-tech-b' },
    { sessionId: 'b9b67686-f16e-49ad-8320-078a78adb6b2' }, { target: { ...current.target, targetId: 'other-project' } }]) {
    const state = { ...current, ...delta };
    const p = previewTechnicalUploadDeposit(key, input, 'Relazione.pdf', bytes, state, now);
    const changed = confirmTechnicalUploadDeposit(key, p.command, p.token, bytes, true, state, now + 1);
    assert.ok(changed); assert.notEqual(changed.privateFile.storageKey, first.privateFile.storageKey);
  }
});
test('untrusted paths and financial metadata cannot enter the private plan', () => {
  for (const fileName of ['../Relazione.pdf', 'fattura.pdf', 'x\r\ny.pdf', 'CON.pdf']) {
    assert.throws(() => previewTechnicalUploadDeposit(key, input, fileName, bytes, current, now));
  }
  assert.throws(() => previewTechnicalUploadDeposit(key, { ...input, title: 'Contratto' }, 'Relazione.pdf', bytes, current, now));
});

test('one approved revision shares a physical quota bucket across sessions and commands', () => {
  const first = confirm(); assert.ok(first);
  const state = { ...current, sessionId: 'b9b67686-f16e-49ad-8320-078a78adb6b2' };
  const p = previewTechnicalUploadDeposit(key, input, 'Relazione.pdf', bytes, state, now);
  const next = confirmTechnicalUploadDeposit(key, p.command, p.token, bytes, true, state, now + 1); assert.ok(next);
  assert.equal(next.privateFile.storageKey.split('/')[2], first.privateFile.storageKey.split('/')[2]);
  assert.notEqual(next.privateFile.storageKey, first.privateFile.storageKey);
  const revision = { ...current, assignmentRevision: current.assignmentRevision + 1 };
  const q = previewTechnicalUploadDeposit(key, { ...input, assignmentRevision: revision.assignmentRevision }, 'Relazione.pdf', bytes, revision, now);
  const other = confirmTechnicalUploadDeposit(key, q.command, q.token, bytes, true, revision, now + 1); assert.ok(other);
  assert.notEqual(other.privateFile.storageKey.split('/')[2], first.privateFile.storageKey.split('/')[2]);
});
