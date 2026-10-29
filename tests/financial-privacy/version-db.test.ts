import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { savePrivateDocumentFile, readPrivateDocument } from '../../src/lib/storage';
import { appendDocumentVersion, documentVersionPage, documentVersionOutcome } from '../../src/lib/document-version-service';
import { DocumentVersionError } from '../../src/lib/document-version-contract';
import { readOrdinaryDocument } from '../../src/lib/ordinary-document-download';
import { selectClientDocuments } from '../../src/lib/selective-client-documents';
const db = new PrismaClient();
before(async () => { assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
after(async () => db.$disconnect());
const oldBytes = '%PDF-1.4\nSYNTHETIC ORIGINAL\n%%EOF', newBytes = '%PDF-1.4\nSYNTHETIC NEW VERSION\n%%EOF';
async function fixture(role: 'admin' | 'commerciale' = 'admin') {
  const user = await db.user.create({ data: { name: 'Synthetic version operator', email: `version-${randomUUID()}@example.test`, role, passwordHash: 'not-login-enabled', active: true } });
  await db.userPermissionOverride.createMany({ data: ['document.upload', 'document.download'].map(permission => ({ userId: user.id, permission, allowed: true })) });
  const session = await db.internalSession.create({ data: { userId: user.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 3600_000) } });
  const client = await db.client.create({ data: { displayName: 'Synthetic document version client', type: 'societa', salesOwnerId: user.id } });
  const file = new File([oldBytes], 'source.pdf', { type: 'application/pdf' });
  const saved = await savePrivateDocumentFile({ file, clientId: client.id, fileName: file.name });
  const document = await db.document.create({ data: { ...saved, clientId: client.id, uploadedById: user.id, fileName: file.name, mimeType: file.type, type: file.type, title: 'Synthetic version evidence' } });
  const version = await db.documentVersion.create({ data: { documentId: document.id, version: 1, storagePath: saved.storagePath, checksum: saved.checksum } });
  const actor: AuthSession = { userId: user.id, sessionId: session.id, active: true, role, expiresAt: Math.floor(session.expiresAt.getTime() / 1000), permissionOverrides: [], clientReadScope: [] };
  return { actor, user, session, client, document, version };
}
async function command(f: Awaited<ReturnType<typeof fixture>>) {
  return { documentId: f.document.id, requestId: randomUUID(), expectedHash: (await documentVersionPage(db, f.actor, f.document.id)).expectedHash, confirmed: true as const };
}
const file = () => new File([newBytes], 'replacement.pdf', { type: 'application/pdf' });
async function footprint(documentId: string) {
  return { document: await db.document.findUniqueOrThrow({ where: { id: documentId } }),
    versions: await db.documentVersion.findMany({ where: { documentId }, orderBy: { id: 'asc' } }),
    receipts: await db.auditLog.findMany({ where: { entityId: documentId, event: 'document_version_upload' }, orderBy: { id: 'asc' } }) };
}
const denies = (error: unknown) => error instanceof DocumentVersionError && error.code === 'DENIED';
test('new content preserves old bytes and metadata, commits one receipt and replays without another version', async () => {
  const f = await fixture(), c = await command(f), result = await appendDocumentVersion(db, f.actor, c, file());
  assert.equal(result.version, 2); assert.equal(result.replay, false);
  const state = await footprint(f.document.id);
  assert.equal(state.versions.length, 2); assert.equal(state.receipts.length, 1);
  for (const key of ['fileName', 'mimeType', 'clientId', 'projectId', 'clientServiceId', 'title', 'documentCategory'] as const) assert.equal(state.document[key], f.document[key]);
  assert.equal((await readPrivateDocument(f.version.storagePath)).toString(), oldBytes);
  assert.equal((await readPrivateDocument(state.document.storagePath)).toString(), newBytes);
  assert.deepEqual(await appendDocumentVersion(db, f.actor, c, file()), { ...result, replay: true });
  assert.deepEqual(await footprint(f.document.id), state);
  assert.equal((await readOrdinaryDocument(db, f.actor, f.document.id, f.version.id)).bytes.toString(), oldBytes);
  assert.equal((await readOrdinaryDocument(db, f.actor, f.document.id, result.versionId)).bytes.toString(), newBytes);
});
test('concurrent commands on one expected revision can only append once', async () => {
  const f = await fixture(), first = await command(f), second = { ...first, requestId: randomUUID() };
  const results = await Promise.allSettled([appendDocumentVersion(db, f.actor, first, file()), appendDocumentVersion(db, f.actor, second, file())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const state = await footprint(f.document.id); assert.equal(state.versions.length, 2); assert.equal(state.receipts.length, 1);
});
test('receipt reconciliation is read-only, actor scoped, and never interprets absence as a failed write', async () => {
  const f = await fixture(), c = await command(f), other = await fixture();
  assert.equal(await documentVersionOutcome(db, f.actor, c), null);
  const result = await appendDocumentVersion(db, f.actor, c, file()), beforeState = await footprint(f.document.id);
  assert.deepEqual(await documentVersionOutcome(db, f.actor, c), { ...result, replay: true });
  assert.equal(await documentVersionOutcome(db, other.actor, c), null);
  assert.deepEqual(await footprint(f.document.id), beforeState);
});
test('commercial upload capability and session revocation deny before mutation and on receipt lookup', async () => {
  const f = await fixture('commerciale'), c = await command(f), beforeState = await footprint(f.document.id);
  await db.userPermissionOverride.update({ where: { userId_permission: { userId: f.user.id, permission: 'document.upload' } }, data: { allowed: false } });
  await assert.rejects(appendDocumentVersion(db, f.actor, c, file()), denies);
  await assert.rejects(documentVersionOutcome(db, f.actor, c), denies);
  assert.deepEqual(await footprint(f.document.id), beforeState);
  await db.userPermissionOverride.update({ where: { userId_permission: { userId: f.user.id, permission: 'document.upload' } }, data: { allowed: true } });
  await db.internalSession.update({ where: { id: f.session.id }, data: { revokedAt: new Date() } });
  await assert.rejects(appendDocumentVersion(db, f.actor, c, file()), denies);
  assert.deepEqual(await footprint(f.document.id), beforeState);
});
test('foreign commercial contexts remain unavailable even with explicit upload and download capabilities', async () => {
  const f = await fixture('commerciale'), other = await fixture('commerciale'), c = await command(f), beforeState = await footprint(f.document.id);
  await assert.rejects(documentVersionPage(db, other.actor, f.document.id), denies);
  await assert.rejects(appendDocumentVersion(db, other.actor, c, file()), denies);
  assert.deepEqual(await footprint(f.document.id), beforeState);
});
test('signed financial records retain their verified flow and cannot be overwritten through version upload', async () => {
  const f = await fixture(), c = await command(f);
  await db.contract.create({ data: { clientId: f.client.id, contractNumber: `VERSION-${randomUUID()}`, serviceName: 'Synthetic', serviceDescription: 'Synthetic', taxableAmount: 1, vatAmount: 0, totalAmount: 1, signedDocumentId: f.document.id } });
  const beforeState = await footprint(f.document.id);
  assert.equal((await documentVersionPage(db, f.actor, f.document.id)).canAppend, false);
  await assert.rejects(appendDocumentVersion(db, f.actor, c, file()), denies);
  assert.deepEqual(await footprint(f.document.id), beforeState);
});
test('mismatched format, invalid signature and stale metadata never create a version or receipt', async () => {
  const f = await fixture(), c = await command(f), beforeState = await footprint(f.document.id);
  for (const bad of [new File(['text'], 'source.txt', { type: 'text/plain' }), new File(['not PDF'], 'source.pdf', { type: 'application/pdf' }), new File([newBytes], 'source.pdf', { type: 'image/png' })]) {
    await assert.rejects(appendDocumentVersion(db, f.actor, c, bad), (e: unknown) => e instanceof DocumentVersionError && e.code === 'INVALID');
  }
  assert.deepEqual(await footprint(f.document.id), beforeState);
  await db.document.update({ where: { id: f.document.id }, data: { title: 'Changed independently' } });
  const changed = await footprint(f.document.id);
  await assert.rejects(appendDocumentVersion(db, f.actor, c, file()), (e: unknown) => e instanceof DocumentVersionError && e.code === 'STALE');
  assert.deepEqual(await footprint(f.document.id), changed);
});
test('an appended version invalidates a prior selected snapshot and never changes its exact version or download choice', async () => {
  const f = await fixture(), target = { id: f.user.id, role: 'admin' as const, active: true, permissionOverrides: [] };
  const choices = [{ versionId: f.version.id, download: false }];
  const prior = await db.$transaction(tx => selectClientDocuments(tx, f.user.id, target, f.client.id, choices));
  await appendDocumentVersion(db, f.actor, await command(f), file());
  const current = await db.$transaction(tx => selectClientDocuments(tx, f.user.id, target, f.client.id, choices));
  assert.equal(current.snapshots.length, 1); assert.equal(current.snapshots[0].versionId, f.version.id); assert.equal(current.snapshots[0].download, false);
  assert.notEqual(current.snapshots[0].stateHash, prior.snapshots[0].stateHash);
  assert.equal(current.paths.get(f.version.id), f.version.storagePath);
});
test('archived and private documents cannot acquire a new version from an ordinary stale form', async () => {
  for (const data of [{ status: 'archiviato' as const }, { visibilityLevel: 'technical_private' }]) {
    const f = await fixture(), c = await command(f); await db.document.update({ where: { id: f.document.id }, data });
    const beforeState = await footprint(f.document.id);
    await assert.rejects(appendDocumentVersion(db, f.actor, c, file()), denies);
    assert.deepEqual(await footprint(f.document.id), beforeState);
  }
});

test('bounded version history paginates without losing the current revision or duplicating entries', async () => {
  const f = await fixture();
  await db.documentVersion.createMany({ data: Array.from({ length: 54 }, (_, i) => ({ documentId: f.document.id, version: i + 2, storagePath: f.document.storagePath, checksum: f.document.checksum })) });
  const first = await documentVersionPage(db, f.actor, f.document.id);
  assert.equal(first.versions.length, 50); assert.equal(first.currentVersion, 55); assert.equal(first.nextBefore, 6);
  const next = await documentVersionPage(db, f.actor, f.document.id, first.nextBefore!);
  assert.deepEqual(next.versions.map(v => v.version), [5, 4, 3, 2, 1]); assert.equal(next.nextBefore, null);
  assert.equal(next.expectedHash, first.expectedHash); assert.equal(new Set([...first.versions, ...next.versions].map(v => v.id)).size, 55);
});
