import assert from 'node:assert/strict';
import test from 'node:test';
import { selectivePracticeSelectionSchema, practiceFieldProjection } from '../src/lib/selective-practice-policy';
import { documentEligibleForPractice, practiceDocumentChoicesMatch, practiceDocumentSnapshotSchema } from '../src/lib/selective-practice-document-policy';
import { selectivePracticeGrantPayloadSchema, readSelectivePracticeGrant } from '../src/lib/selective-practice-grant';
import { selectivePracticeProof } from '../src/lib/selective-practice-proof';

const selection = { practiceId: 'practice-a', recipientId: 'reader', revision: 0,
  commandId: '11111111-1111-4111-8111-111111111111', fields: ['title'], expiresAt: null };
const choice = { versionId: 'version-a', download: false };
const snapshot = { documentId: 'document-a', versionId: 'version-a', version: 1,
  checksum: 'a'.repeat(64), stateHash: 'b'.repeat(64), title: 'Synthetic document', fileName: 'test.pdf',
  mimeType: 'application/pdf', download: false, practiceId: 'practice-a' };
const payload = { id: '22222222-2222-4222-8222-222222222222', selection,
  revision: 1, approvedById: 'admin', approvedAt: '2026-10-21T00:00:00.000Z', authorityRevision: 1,
  actorEpoch: 1, recipientEpoch: 1, practiceEpoch: 1, contextHash: 'c'.repeat(64), keyVersion: 1 };
const context = { id: 'practice-a', clientId: 'client-a', projectId: 'project-a', clientServiceId: 'service-a', serviceProjectId: 'project-a' };

test('V1 practice selection and grant retain their exact canonical structure', () => {
  assert.deepEqual(selectivePracticeSelectionSchema.parse(selection), selection);
  assert.deepEqual(selectivePracticeGrantPayloadSchema.parse(payload), payload);
  assert.equal(selectivePracticeSelectionSchema.safeParse({ ...selection, documents: [choice] }).success, false);
  assert.equal(selectivePracticeGrantPayloadSchema.safeParse({ ...payload, documents: [snapshot] }).success, false);
});
test('V2 can grant exact document versions without disclosing any scalar field', () => {
  const selected = { ...selection, version: 2, fields: [], documents: [choice] };
  assert.deepEqual(selectivePracticeSelectionSchema.parse(selected), selected);
  assert.deepEqual(practiceFieldProjection({ title: 'NOT_SELECTED' }, []), []);
  assert.equal(selectivePracticeGrantPayloadSchema.safeParse({ ...payload, selection: selected, documents: [snapshot] }).success, true);
});
test('no empty selection, wildcards, duplicate version or implicit download', () => {
  for (const documents of [[], [{ versionId: '*' }], [choice, choice], [{ versionId: 'version-a' }]]) {
    assert.equal(selectivePracticeSelectionSchema.safeParse({ ...selection, version: 2, fields: [], documents }).success, false);
  }
  assert.equal(selectivePracticeSelectionSchema.safeParse({ ...selection, fields: [] }).success, false);
});
test('a snapshot must name the same practice and exact version/download choice', () => {
  const parsed = practiceDocumentSnapshotSchema.parse(snapshot);
  assert.equal(practiceDocumentChoicesMatch('practice-a', [choice], [parsed]), true);
  assert.equal(practiceDocumentChoicesMatch('practice-b', [choice], [parsed]), false);
  assert.equal(practiceDocumentChoicesMatch('practice-a', [{ ...choice, download: true }], [parsed]), false);
  const selected = { ...selection, version: 2, documents: [choice] };
  for (const changed of [{ ...snapshot, practiceId: 'practice-b' }, { ...snapshot, versionId: 'version-b' }]) {
    assert.equal(selectivePracticeGrantPayloadSchema.safeParse({ ...payload, selection: selected, documents: [changed] }).success, false);
  }
});
test('bounded version selection and snapshots never accept executable formats or storage paths', () => {
  assert.equal(selectivePracticeSelectionSchema.safeParse({ ...selection, version: 2,
    documents: Array.from({ length: 21 }, (_, i) => ({ versionId: 'v-' + i, download: false })) }).success, false);
  for (const changed of [{ ...snapshot, storagePath: '/private/path' }, { ...snapshot, mimeType: 'text/html' }, { ...snapshot, mimeType: 'image/svg+xml' }]) {
    assert.equal(practiceDocumentSnapshotSchema.safeParse(changed).success, false);
  }
});
test('candidate listing never treats a common client as a link to sibling service/project', () => {
  assert.equal(documentEligibleForPractice(context, { clientId: 'client-a', projectId: null, clientServiceId: null }), true);
  assert.equal(documentEligibleForPractice(context, { clientId: 'client-a', projectId: 'project-a', clientServiceId: 'service-a' }), true);
  for (const document of [
    { clientId: 'client-b', projectId: 'project-a', clientServiceId: null },
    { clientId: 'client-a', projectId: 'project-b', clientServiceId: null },
    { clientId: 'client-a', projectId: 'project-a', clientServiceId: 'service-b' },
  ]) assert.equal(documentEligibleForPractice(context, document), false);
  assert.equal(documentEligibleForPractice({ ...context, projectId: null, serviceProjectId: null },
    { clientId: 'client-a', projectId: 'project-a', clientServiceId: null }), false);
});
test('signed document association cannot be transplanted to another practice or parent generation', () => {
  const key = { version: 1, secret: 'synthetic-practice-documents-proof-only-0000000000000' };
  const grant = selectivePracticeGrantPayloadSchema.parse({ ...payload,
    selection: { ...selection, version: 2, documents: [choice] }, documents: [snapshot] });
  const raw = { payload: grant, proof: selectivePracticeProof(key, 'grant', grant), revokedAt: null };
  const current = { practiceId: 'practice-a', recipientId: 'reader', revision: 1,
    authority: { enabled: true, userId: 'admin', revision: 1, actorEpoch: 1, actorActive: true },
    recipientActive: true, recipientEpoch: 1, practiceEpoch: 1, practiceOperational: true, contextHash: 'c'.repeat(64) };
  const now = Date.parse('2026-10-21T01:00:00Z');
  assert.ok(readSelectivePracticeGrant(raw, key, current, now));
  for (const changed of [{ ...current, practiceId: 'practice-b' }, { ...current, contextHash: 'd'.repeat(64) },
    { ...current, practiceEpoch: 2 }, { ...current, recipientEpoch: 2 }, { ...current, practiceOperational: false }]) {
    assert.equal(readSelectivePracticeGrant(raw, key, changed, now), null);
  }
  assert.equal(readSelectivePracticeGrant({ ...raw, revokedAt: '2026-10-21T00:30:00Z' }, key, current, now), null);
});
