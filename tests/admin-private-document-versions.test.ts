import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readPrivateDocumentVersions, originalPrivateVersionState, privateVersionDigest as digest } from '../src/lib/private-document-versions';
const acquisition = randomUUID(), at = new Date('2026-10-30T12:00:00.000Z'), later = new Date('2026-10-30T13:00:00.000Z');
const original = { id: 'original-version', documentId: 'private-document', version: 1, storagePath: 'synthetic/original.txt', checksum: 'a'.repeat(64), createdAt: at };
function valid() {
  const version = { ...original, id: 'new-version', version: 2, storagePath: 'synthetic/new.txt', checksum: 'b'.repeat(64), createdAt: later };
  const before = originalPrivateVersionState(original.documentId, acquisition, original);
  const after = { ...before, versionCount: 2, latestVersionId: version.id, version: { ...version, createdAt: later.toISOString() },
    file: { fileName: 'new.txt', mimeType: 'text/plain' as const, sizeBytes: 12, sha256: version.checksum } };
  const row = { commandId: randomUUID(), actorId: 'original-admin', createdAt: later, reason: 'Synthetic version',
    operation: 'UPDATE', before, after, beforeHash: digest(before), afterHash: digest(after) };
  return { row, version };
}
function read(rows: ReturnType<typeof valid>['row'][], versions = [original, valid().version]) {
  const tx = { adminRecordRevision: { findMany: async () => rows } };
  return readPrivateDocumentVersions(tx as never, original.documentId, acquisition, original, versions, 'original-admin');
}
test('private binary history is anchored to the exact acquired original and its actor', async () => {
  const { row, version } = valid(), result = await read([row], [original, version]);
  assert.equal(result.current.versionCount, 2); assert.equal(result.additions[0].file.fileName, 'new.txt');
  assert.deepEqual((await read([], [original])).current, originalPrivateVersionState(original.documentId, acquisition, original));
});
test('a missing or extra physical version cannot be hidden behind the private version journal', async () => {
  const { row, version } = valid();
  await assert.rejects(read([], [original, version]), /INTEGRITY/);
  await assert.rejects(read([row], [original]), /INTEGRITY/);
});
test('a self-consistent altered predecessor does not replace the acquired original', async () => {
  const { row } = valid(); row.before.latestVersionId = 'unrelated'; row.beforeHash = digest(row.before);
  await assert.rejects(read([row]), /INTEGRITY/);
});
test('version gaps, duplicate records and modified physical bytes metadata are denied', async () => {
  const { row, version } = valid();
  row.after.versionCount = 3; row.after.version.version = 3; row.afterHash = digest(row.after);
  await assert.rejects(read([row], [original, { ...version, version: 3 }]), /INTEGRITY/);
  const duplicate = valid(); await assert.rejects(read([duplicate.row, duplicate.row], [original, duplicate.version]), /INTEGRITY/);
  await assert.rejects(read([valid().row], [original, { ...version, checksum: 'c'.repeat(64) }]), /INTEGRITY/);
});
test('earlier hashes, receipt attribution and chronological order remain checked', async () => {
  const first = valid(); first.row.beforeHash = '0'.repeat(64); await assert.rejects(read([first.row]), /INTEGRITY/);
  const other = valid(); other.row.actorId = 'another-admin'; await assert.rejects(read([other.row]), /INTEGRITY/);
  const early = valid(); early.row.createdAt = at; await assert.rejects(read([early.row]), /INTEGRITY/);
});
test('private file metadata cannot introduce active content or a path as a file name', async () => {
  const badName = valid(); badName.row.after.file.fileName = '../leak.txt'; badName.row.afterHash = digest(badName.row.after);
  await assert.rejects(read([badName.row]));
  const badType = valid(); (badType.row.after.file as { mimeType: string }).mimeType = 'text/html'; badType.row.afterHash = digest(badType.row.after);
  await assert.rejects(read([badType.row]));
});
