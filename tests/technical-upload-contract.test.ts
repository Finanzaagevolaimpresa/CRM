import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../src/lib/canonical-json';
import { documentUploadMaxBytes } from '../src/lib/document-upload-contract';
import { technicalAssignmentProof } from '../src/lib/technical-assignment-proof';
import { createTechnicalUploadPreview, describeTechnicalUpload, readTechnicalUploadPreview, technicalUploadCommand,
  technicalUploadProfile, technicalUploadReceipt, technicalUploadRequestDigest, signTechnicalUploadReceipt,
  readTechnicalUploadReceipt, type TechnicalUploadAdmission, type TechnicalUploadCommand,
  type TechnicalUploadProfile, type TechnicalUploadReceipt } from '../src/lib/technical-upload-contract';

const now = Date.parse('2026-10-24T10:00:00.000Z');
const key = { version: 2, secret: 'synthetic-private-upload-key-material' };
const bytes = Buffer.from('%PDF-1.4\nSynthetic technical submission\n%%EOF\n');
const profile: TechnicalUploadProfile = { purpose: 'Elaborati del progetto', formats: ['.pdf', '.txt', '.docx'],
  maxFileBytes: 1024, maxFilesPerRevision: 3, maxBytesPerRevision: 2048, visibility: 'PRIVATE_PENDING_ADMIN_REVIEW' };
const command: TechnicalUploadCommand = { commandId: 'aa1456f0-a040-4420-928e-25fe64754482',
  assignmentId: '4310d341-318a-4de1-a4d9-42c7cf8acf99', assignmentRevision: 2,
  expectedContextSha256: 'a'.repeat(64), title: 'Elaborato tecnico', action: 'deposit_private_document',
  file: describeTechnicalUpload('Elaborato.pdf', bytes, profile) };
const current: TechnicalUploadAdmission = { target: { kind: 'Project', targetId: 'synthetic-project' },
  actorId: 'synthetic-tech-a', sessionId: 'b63b0628-b533-441c-a1a5-e461485f63d8',
  assignmentId: command.assignmentId, assignmentRevision: command.assignmentRevision, assignmentStateSha256: 'b'.repeat(64),
  authorityRevision: 3, actorEpoch: 4, authorEpoch: 5, keyVersion: key.version, contextSha256: command.expectedContextSha256,
  scopeGeneration: 2, profile, consumedFiles: 0, consumedBytes: 0, validUntil: now + 600_000 };
const token = createTechnicalUploadPreview(key, command, current, now);
const receipt: TechnicalUploadReceipt = { protocol: 'TECHNICAL_UPLOAD_RECEIPT_V1', commandId: command.commandId,
  submissionId: 'a6863f07-7cfe-46d1-9347-94b3ebac1b4f', actorId: current.actorId, sessionId: current.sessionId,
  target: current.target, assignmentId: command.assignmentId, assignmentRevision: command.assignmentRevision,
  requestDigest: technicalUploadRequestDigest(current.target, command), contentSha256: command.file.contentSha256,
  sizeBytes: bytes.length, status: 'PRIVATE_STORED', recordedAt: new Date(now + 10).toISOString(), keyVersion: key.version };
const expected = { commandId: command.commandId, actorId: current.actorId, sessionId: current.sessionId,
  target: current.target, requestDigest: receipt.requestDigest };

test('one bounded exact private proposal can be previewed without publishing or storing it', () => {
  assert.deepEqual(readTechnicalUploadPreview(key, token, current, now + 1), command);
  assert.equal(command.file.sizeBytes, bytes.length);
  assert.equal(command.file.previewMime, 'application/pdf');
  assert.equal(profile.visibility, 'PRIVATE_PENDING_ADMIN_REVIEW');
});
test('profiles cannot silently enable public access, archives or unlimited uploads', () => {
  for (const delta of [{ visibility: 'PUBLIC' }, { formats: ['.zip'] }, { formats: ['.pdf', '.pdf'] },
    { maxFilesPerRevision: 21 }, { maxFilesPerRevision: 0 }, { maxFileBytes: documentUploadMaxBytes + 1 },
    { maxFileBytes: 0 }, { maxBytesPerRevision: 1023 }, { maxBytesPerRevision: 4096 }, { recipients: ['another-tech'] }]) {
    assert.equal(technicalUploadProfile.safeParse({ ...profile, ...delta }).success, false);
  }
});
test('bytes are hashed exactly, opaque approved formats never claim inline preview', () => {
  const a = describeTechnicalUpload('Relazione.docx', Buffer.from('opaque test bytes'), profile);
  assert.equal(a.previewMime, null);
  assert.notEqual(describeTechnicalUpload('Elaborato.pdf', Buffer.concat([bytes, Buffer.from('change')]), profile).contentSha256,
    command.file.contentSha256);
});
test('empty, oversized, unselected and executable files are rejected before submission', () => {
  for (const [name, data] of [['Empty.pdf', Buffer.alloc(0)], ['Large.pdf', Buffer.alloc(1025)],
    ['Unknown.xml', bytes], ['Script.js', bytes], ['Archive.zip', bytes]] as const) {
    assert.throws(() => describeTechnicalUpload(name, data, profile));
  }
});
test('passive previews require the actual format and valid UTF-8 text', () => {
  for (const [name, data] of [['False.pdf', Buffer.from('not a PDF')], ['False.txt', Buffer.from([0xff])],
    ['Binary.txt', Buffer.from([65, 0, 66])]] as const) assert.throws(() => describeTechnicalUpload(name, data, profile));
  assert.equal(describeTechnicalUpload('Relazione.txt', Buffer.from('Testo tecnico'), profile).previewMime, 'text/plain; charset=utf-8');
});
test('financial classifications cannot be hidden behind generic metadata or the private action', () => {
  for (const name of ['contratto.pdf', 'Pagamento.pdf', 'bonifico.pdf', 'fattura.pdf']) {
    assert.throws(() => describeTechnicalUpload(name, bytes, profile));
  }
  for (const title of ['Contratto', 'Dichiarazione di pagamento', 'Invoice']) {
    assert.throws(() => createTechnicalUploadPreview(key, { ...command, title }, current, now));
  }
});
test('names cannot carry paths, CRLF, invisible direction controls or device names', () => {
  for (const name of ['../x.pdf', 'C:\\x.pdf', 'a/b.pdf', 'a\r\nb.pdf', 'a\u202eb.pdf', 'CON.pdf',
    'LPT9.pdf', 'a..pdf', 'a.pdf.', ' a.pdf', 'a\u0000.pdf', 'a?.pdf']) {
    assert.throws(() => describeTechnicalUpload(name, bytes, profile));
  }
});
test('the five-minute preview expires earlier with its current session or assignment', () => {
  assert.deepEqual(readTechnicalUploadPreview(key, token, current, now + 299_999), command);
  assert.equal(readTechnicalUploadPreview(key, token, current, now + 300_000), null);
  assert.equal(readTechnicalUploadPreview(key, token, current, now - 1), null);
  const shorter = { ...current, validUntil: now + 100 };
  const short = createTechnicalUploadPreview(key, command, shorter, now);
  assert.equal(readTechnicalUploadPreview(key, short, shorter, now + 100), null);
});
test('another technician, session or target cannot reuse a preview', () => {
  for (const delta of [{ actorId: 'synthetic-tech-b' }, { sessionId: '2f742a52-cebb-4c89-abd6-f9b747650cbe' },
    { target: { kind: 'Project' as const, targetId: 'other-project' } },
    { target: { kind: 'TechnicalPractice' as const, targetId: current.target.targetId } }]) {
    assert.equal(readTechnicalUploadPreview(key, token, { ...current, ...delta }, now + 1), null);
  }
});
test('revocation, regrant, context restoration and authority changes invalidate earlier previews', () => {
  for (const delta of [{ assignmentRevision: 3 }, { assignmentStateSha256: 'd'.repeat(64) }, { authorityRevision: 4 },
    { actorEpoch: 5 }, { authorEpoch: 6 }, { scopeGeneration: 3 }, { contextSha256: 'd'.repeat(64) },
    { keyVersion: 3 }, { profile: { ...profile, maxFilesPerRevision: 4 } }]) {
    assert.equal(readTechnicalUploadPreview(key, token, { ...current, ...delta }, now + 1), null);
  }
});
test('concurrent quota consumption invalidates an open preview and cannot exceed the selected budget', () => {
  for (const delta of [{ consumedFiles: 1 }, { consumedBytes: 1 }]) {
    assert.equal(readTechnicalUploadPreview(key, token, { ...current, ...delta }, now + 1), null);
  }
  assert.throws(() => createTechnicalUploadPreview(key, command, { ...current, consumedFiles: 3 }, now));
  assert.throws(() => createTechnicalUploadPreview(key, command, { ...current, consumedBytes: 2048 - bytes.length + 1 }, now));
  assert.doesNotThrow(() => createTechnicalUploadPreview(key, command, { ...current, consumedFiles: 2, consumedBytes: 2048 - bytes.length }, now));
});
test('corrupt quota snapshots cannot admit a new upload', () => {
  for (const quota of [{ consumedFiles: 0, consumedBytes: 1 }, { consumedFiles: 1, consumedBytes: 0 },
    { consumedFiles: 1, consumedBytes: 1025 }, { consumedFiles: 4, consumedBytes: 2000 }]) {
    assert.throws(() => createTechnicalUploadPreview(key, command, { ...current, ...quota }, now));
  }
});
test('client-supplied preview metadata cannot turn opaque or mismatched formats into inline content', () => {
  for (const file of [{ ...command.file, previewMime: 'image/png' }, { ...command.file, previewMime: null },
    { ...command.file, extension: '.docx', fileName: 'Report.docx', previewMime: 'application/pdf' }]) {
    assert.equal(technicalUploadCommand.safeParse({ ...command, file }).success, false);
  }
});
test('same command ID with changed bytes, title or file name conflicts instead of deduplicating falsely', () => {
  for (const delta of [{ title: 'Altra relazione' }, { file: { ...command.file, fileName: 'Other.pdf' } },
    { file: { ...command.file, contentSha256: 'd'.repeat(64) } }, { file: { ...command.file, sizeBytes: bytes.length + 1 } }]) {
    assert.notEqual(technicalUploadRequestDigest(current.target, { ...command, ...delta }), receipt.requestDigest);
  }
});
test('a submission cannot choose another destination, existing version, recipient or public URL', () => {
  for (const extra of ['clientId', 'projectId', 'documentId', 'versionId', 'recipients', 'storagePath', 'url', 'sendEmail']) {
    assert.equal(technicalUploadCommand.safeParse({ ...command, [extra]: 'forged' }).success, false);
  }
  assert.equal(technicalUploadCommand.safeParse({ ...command, action: 'publish_document' }).success, false);
});
test('tampered or differently signed previews fail closed and no decoded value is trusted', () => {
  const original = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  const changed = structuredClone(original); changed.payload.command.title = 'Changed';
  const other = { ...original, proof: technicalAssignmentProof(key, 'preview', original.payload) };
  for (const value of [changed, other, { ...original, grant: true }]) {
    assert.equal(readTechnicalUploadPreview(key, Buffer.from(canonicalJson(value)).toString('base64url'), current, now + 1), null);
  }
  for (const invalid of ['', token + '=', 'x'.repeat(32_001), Buffer.from(JSON.stringify(original, null, 2)).toString('base64url')]) {
    assert.equal(readTechnicalUploadPreview(key, invalid, current, now + 1), null);
  }
});
test('invalid clocks and signing keys cannot produce admissible previews', () => {
  for (const time of [NaN, Infinity, -1, 0.5]) assert.throws(() => createTechnicalUploadPreview(key, command, current, time));
  assert.throws(() => createTechnicalUploadPreview({ ...key, secret: 'short' }, command, current, now));
  assert.equal(readTechnicalUploadPreview({ ...key, secret: 'different-synthetic-key-material' }, token, current, now + 1), null);
});
test('a lost-response receipt reports only the exact private outcome, never publication or access', () => {
  const proof = signTechnicalUploadReceipt(key, receipt);
  assert.deepEqual(readTechnicalUploadReceipt(key, receipt, proof, expected, now + 20), receipt);
  for (const extra of ['title', 'fileName', 'storagePath', 'recipients', 'readToken', 'publicUrl']) {
    assert.equal(technicalUploadReceipt.safeParse({ ...receipt, [extra]: 'private' }).success, false);
  }
  assert.equal(technicalUploadReceipt.safeParse({ ...receipt, status: 'PUBLISHED' }).success, false);
});
test('receipt reconciliation checks actor, session, target, command, exact request and signature domain', () => {
  const proof = signTechnicalUploadReceipt(key, receipt);
  for (const delta of [{ actorId: 'other' }, { sessionId: '2f742a52-cebb-4c89-abd6-f9b747650cbe' },
    { target: { ...current.target, targetId: 'other' } }, { requestDigest: 'd'.repeat(64) },
    { commandId: '829b5e60-cb84-4c05-9e39-a0b352298364' }]) {
    assert.equal(readTechnicalUploadReceipt(key, receipt, proof, { ...expected, ...delta }, now + 20), null);
  }
  assert.equal(readTechnicalUploadReceipt(key, receipt, proof, expected, now), null);
  assert.equal(readTechnicalUploadReceipt(key, receipt, 'bad', expected, now + 20), null);
  assert.equal(readTechnicalUploadReceipt(key, receipt, technicalAssignmentProof(key, 'receipt', receipt), expected, now + 20), null);
});
