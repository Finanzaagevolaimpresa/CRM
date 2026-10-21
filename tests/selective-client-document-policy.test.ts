import assert from 'node:assert/strict';
import test from 'node:test';
import { clientDocumentChoicesMatch, clientDocumentSnapshotSchema } from '../src/lib/selective-client-document-policy';
import { selectiveClientSelectionSchema } from '../src/lib/selective-client-policy';
import { selectiveClientGrantPayloadSchema } from '../src/lib/selective-client-grant';

const input = { version: 2, clientId: 'synthetic-client', recipientId: 'synthetic-recipient', revision: 0,
  commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: [], expiresAt: null,
  documents: [{ versionId: 'synthetic-version', download: false }] };
const document = { documentId: 'synthetic-document', versionId: 'synthetic-version', version: 1,
  checksum: 'a'.repeat(64), stateHash: 'b'.repeat(64), title: 'Synthetic document', fileName: 'synthetic.pdf',
  mimeType: 'application/pdf', download: false };

test('explicit V2 permits only a document without exposing client identity fields', () => {
  assert.deepEqual(selectiveClientSelectionSchema.parse(input), input);
  for (const change of [{ version: undefined }, { version: 1 }, { documents: [] }, { documents: undefined },
    { fields: ['notes'] }, { documents: [...input.documents, ...input.documents] },
    { documents: [{ documentId: 'synthetic-document', download: false }] },
    { documents: [{ versionId: 'current', download: 'true' }] }, { documents: [{ versionId: '../bytes', download: true }] }]) {
    assert.equal(selectiveClientSelectionSchema.safeParse({ ...input, ...change }).success, false);
  }
});

test('selected versions and download decisions must match unique signed snapshots exactly', () => {
  const snapshot = clientDocumentSnapshotSchema.parse(document);
  assert.equal(clientDocumentChoicesMatch(input.documents, [snapshot]), true);
  assert.equal(clientDocumentChoicesMatch(input.documents, [{ ...snapshot, download: true }]), false);
  assert.equal(clientDocumentChoicesMatch(input.documents, [{ ...snapshot, versionId: 'new-version' }]), false);
  assert.equal(clientDocumentChoicesMatch(input.documents, [snapshot, snapshot]), false);
  assert.equal(clientDocumentChoicesMatch([], [snapshot]), false);
  assert.equal(clientDocumentSnapshotSchema.safeParse({ ...document, storagePath: '/private/file' }).success, false);
  assert.equal(clientDocumentSnapshotSchema.safeParse({ ...document, mimeType: 'text/html' }).success, false);
});

test('legacy payload stays unchanged; V2 requires signed document snapshots and bounded exact choices', () => {
  const base = { id: 'c9cd54fe-5acf-4227-8bf4-1c320e740248', revision: 1, approvedById: 'authority',
    approvedAt: '2026-10-21T08:00:00.000Z', authorityRevision: 1, actorEpoch: 1, recipientEpoch: 1, clientEpoch: 1, keyVersion: 1 };
  const legacySelection = { clientId: input.clientId, recipientId: input.recipientId, revision: 0,
    commandId: input.commandId, fields: ['status'], expiresAt: null };
  const legacy = { ...base, selection: legacySelection };
  assert.deepEqual(selectiveClientGrantPayloadSchema.parse(legacy), legacy);
  assert.equal(selectiveClientGrantPayloadSchema.safeParse({ ...legacy, documents: [] }).success, false);
  const next = { ...base, selection: input, documents: [document] };
  assert.deepEqual(selectiveClientGrantPayloadSchema.parse(next), next);
  for (const documents of [undefined, [], [{ ...document, download: true }], [{ ...document, versionId: 'other' }]]) {
    assert.equal(selectiveClientGrantPayloadSchema.safeParse({ ...next, documents }).success, false);
  }
  assert.equal(selectiveClientSelectionSchema.safeParse({ ...input, documents: Array.from({ length: 21 }, (_, i) => ({ versionId: `v${i}`, download: false })) }).success, false);
});
