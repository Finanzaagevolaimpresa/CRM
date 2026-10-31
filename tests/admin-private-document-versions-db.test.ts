import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { lifecyclePrivateDocumentFixture } from './admin-lifecycle/fixtures';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { readAdminPrivateVersions, saveAdminPrivateVersion, reconcileAdminPrivateVersion } from '../src/lib/admin-private-document-versions';
import { readPersonalAcquiredDocument } from '../src/lib/technical-document-acquired-access';
import { selectClientDocuments } from '../src/lib/selective-client-documents';
import { assignTechnical, revokeTechnical } from './technical-assignments/fixtures';
import { readTechnicalWorkDocument } from '../src/lib/technical-assignment-access';
import { readPrivateDocumentBounded } from '../src/lib/storage';
import { readAdminOperationalState, saveAdminOperationalState } from '../src/lib/admin-operational-lifecycle';
const enabled = process.env.RUN_DB_TESTS === '1' && process.env.ADMIN_PRIVATE_VERSION_DB_TESTS === '1', options = { skip: !enabled };
const db = new PrismaClient(), key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person;
before(async () => {
  if (!enabled) return; await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const [ledger] = await db.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
  assert.equal(ledger.count, 74n);
  const existing = await db.selectiveAccessAuthority.findFirst();
  if (existing) { const user = await db.user.findUniqueOrThrow({ where: { id: existing.userId } }); admin = { user, ...await syntheticSession(db, user) }; }
  else admin = await syntheticAuthority(db);
});
after(() => db.$disconnect());
function proof(person = admin, secondsAgo = 0) {
  return { key, sessionToken: person.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: person.user.id, role: person.user.role,
    sessionToken: person.token, nowSeconds: Math.floor(Date.now() / 1000) - secondsAgo }) };
}
const file = (text = 'VERSIONE_PRIVATA_SINTETICA_2') => new File([text], 'versione-sintetica.txt', { type: 'text/plain' });
async function command(id: string, restoreVersionId: string | null = null) {
  const current = await readAdminPrivateVersions(db, admin.session, id);
  return { commandId: randomUUID(), id, expectedVersion: current.expectedVersion, restoreVersionId, reason: 'Versione sintetica isolata', confirmed: true as const };
}
async function latest(id: string) { return (await readAdminPrivateVersions(db, admin.session, id)).versions.at(-1)!; }
const fixture = () => lifecyclePrivateDocumentFixture(db, admin);
test('private version append retains exact original row, bytes, acquisition and source audit', options, async () => {
  const f = await fixture(), id = f.receipt.documentId;
  const original = await db.document.findUniqueOrThrow({ where: { id } }), version = await db.documentVersion.findUniqueOrThrow({ where: { id: f.receipt.versionId } });
  const acquisition = await db.$queryRawUnsafe('SELECT record FROM "TechnicalDocumentAcquisition" WHERE "commandId"=$1::uuid', f.receipt.commandId);
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: f.receipt.commandId } });
  await saveAdminPrivateVersion(db, admin.session, await command(id), file(), proof());
  const after = await db.document.findUniqueOrThrow({ where: { id } }), added = await latest(id);
  assert.equal(added.version, 2); assert(after.selectiveEpoch > original.selectiveEpoch);
  assert.deepEqual({ ...after, selectiveEpoch: original.selectiveEpoch }, original);
  assert.deepEqual(await db.documentVersion.findUniqueOrThrow({ where: { id: version.id } }), version);
  assert.deepEqual(await db.$queryRawUnsafe('SELECT record FROM "TechnicalDocumentAcquisition" WHERE "commandId"=$1::uuid', f.receipt.commandId), acquisition);
  assert.deepEqual(await db.auditLog.findUniqueOrThrow({ where: { id: f.receipt.commandId } }), audit);
  assert.deepEqual((await readPersonalAcquiredDocument(db, admin.session, id)).bytes, f.bytes);
  assert.equal((await readPersonalAcquiredDocument(db, admin.session, id, added.versionId)).bytes.toString(), 'VERSIONE_PRIVATA_SINTETICA_2');
});
test('response reconciliation and exact replay never append another version or accept different bytes', options, async () => {
  const f = await fixture(), input = await command(f.receipt.documentId);
  await saveAdminPrivateVersion(db, admin.session, input, file(), proof());
  assert.equal((await saveAdminPrivateVersion(db, admin.session, input, file(), proof())).replayed, true);
  await assert.rejects(saveAdminPrivateVersion(db, admin.session, input, file('ALTRO_CONTENUTO'), proof()), /STALE/);
  assert.equal((await reconcileAdminPrivateVersion(db, admin.session, { id: input.id, commandId: input.commandId, close: true })).status, 'RECORDED');
  assert.equal(await db.documentVersion.count({ where: { documentId: input.id } }), 2);
});
test('restore creates a new version with exact prior bytes instead of replacing a signed source', options, async () => {
  const f = await fixture(), id = f.receipt.documentId;
  await saveAdminPrivateVersion(db, admin.session, await command(id), file(), proof());
  await saveAdminPrivateVersion(db, admin.session, await command(id, f.receipt.versionId), null, proof());
  const restored = await latest(id); assert.equal(restored.version, 3); assert.notEqual(restored.versionId, f.receipt.versionId);
  assert.deepEqual((await readPersonalAcquiredDocument(db, admin.session, id, restored.versionId)).bytes, f.bytes);
  assert.equal(await db.documentVersion.count({ where: { documentId: id } }), 3);
});
test('Admin confirmation boundary and revoked sessions fail before any version is appended', options, async () => {
  const f = await fixture(), input = await command(f.receipt.documentId);
  await assert.rejects(saveAdminPrivateVersion(db, admin.session, input, file(), proof(admin, 1800)));
  assert.equal(await db.documentVersion.count({ where: { documentId: input.id } }), 1);
  await db.internalSession.update({ where: { id: admin.session.sessionId! }, data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE', revokedByUserId: admin.user.id } });
  await assert.rejects(saveAdminPrivateVersion(db, admin.session, input, file(), proof()));
  admin = { user: admin.user, ...await syntheticSession(db, admin.user) };
  await saveAdminPrivateVersion(db, admin.session, input, file(), proof());
  assert.equal(await db.documentVersion.count({ where: { documentId: input.id } }), 2);
});
test('old selected access is invalidated and a technician receives only the new explicitly selected version', options, async () => {
  const f = await fixture(), id = f.receipt.documentId;
  await assignTechnical(db, admin, f.target, f.techA, { documents: [{ fileId: f.receipt.versionId, allowDownload: true }] });
  assert.deepEqual((await readTechnicalWorkDocument(db, f.techA.session, f.target, f.receipt.versionId, true, readPrivateDocumentBounded)).bytes, f.bytes);
  await saveAdminPrivateVersion(db, admin.session, await command(id), file(), proof());
  const added = await latest(id);
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, f.target, f.receipt.versionId, true, readPrivateDocumentBounded));
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, f.target, added.versionId, true, readPrivateDocumentBounded));
  await assignTechnical(db, admin, f.target, f.techA, { documents: [{ fileId: added.versionId, allowDownload: true }] });
  assert.equal((await readTechnicalWorkDocument(db, f.techA.session, f.target, added.versionId, true, readPrivateDocumentBounded)).bytes.toString(), 'VERSIONE_PRIVATA_SINTETICA_2');
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, f.target, f.receipt.versionId, true, readPrivateDocumentBounded));
  await assert.rejects(readTechnicalWorkDocument(db, f.techB.session, f.target, added.versionId, true, readPrivateDocumentBounded));
  await revokeTechnical(db, admin, f.target, f.techA);
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, f.target, added.versionId, true, readPrivateDocumentBounded));
});
test('financial ceilings survive new file names and binary versions', options, async () => {
  const f = await lifecyclePrivateDocumentFixture(db, admin, 'CONTRACT'), id = f.receipt.documentId;
  await saveAdminPrivateVersion(db, admin.session, await command(id), file(), proof());
  const added = await latest(id);
  await assert.rejects(db.$transaction(tx => selectClientDocuments(tx, admin.user.id, { ...f.techA.session, id: f.techA.user.id }, f.client.id,
    [{ versionId: added.versionId, download: true }]), { isolationLevel: 'Serializable' }));
  assert.equal((await readPersonalAcquiredDocument(db, admin.session, id, added.versionId)).bytes.toString(), 'VERSIONE_PRIVATA_SINTETICA_2');
});
test('unknown attempts close durably and cannot create a version through late arrival', options, async () => {
  const f = await fixture(), input = await command(f.receipt.documentId);
  assert.equal((await reconcileAdminPrivateVersion(db, admin.session, { id: input.id, commandId: input.commandId, close: false })).status, 'UNKNOWN');
  assert.equal((await reconcileAdminPrivateVersion(db, admin.session, { id: input.id, commandId: input.commandId, close: true })).status, 'CLOSED');
  await assert.rejects(saveAdminPrivateVersion(db, admin.session, input, file(), proof()), /CLOSED/);
  assert.equal(await db.documentVersion.count({ where: { documentId: input.id } }), 1);
});
test('another Admin and a recipient cannot acquire version-writing authority from a document id', options, async () => {
  const f = await fixture(), input = await command(f.receipt.documentId), other = await syntheticPerson(db, 'Altro Admin versioni');
  for (const person of [other, f.techA]) {
    await assert.rejects(readAdminPrivateVersions(db, person.session, input.id));
    await assert.rejects(saveAdminPrivateVersion(db, person.session, input, file(), proof(person)));
  }
  const permission = await db.userPermissionOverride.create({ data: { userId: admin.user.id, permission: 'document.upload', allowed: false } });
  try {
    assert.equal((await readAdminPrivateVersions(db, admin.session, input.id)).canWrite, false);
    await assert.rejects(saveAdminPrivateVersion(db, admin.session, input, file(), proof()));
  } finally { await db.userPermissionOverride.delete({ where: { id: permission.id } }); }
});
test('an archived source remains closed to new versions and personal byte delivery', options, async () => {
  const f = await fixture(), id = f.receipt.documentId, data = await readAdminOperationalState(db, admin.session, 'Document', id);
  await saveAdminOperationalState(db, admin.session, { commandId: randomUUID(), model: 'Document', id, expectedVersion: data.expectedVersion,
    state: 'ARCHIVED', reason: 'Archivio sintetico', confirmed: true }, proof());
  await assert.rejects(saveAdminPrivateVersion(db, admin.session, await command(id), file(), proof()));
  await assert.rejects(readPersonalAcquiredDocument(db, admin.session, id));
  assert.equal(await db.documentVersion.count({ where: { documentId: id } }), 1);
});
test('an audit failure rolls back the version, receipt and epoch while preserving the original file', options, async () => {
  const f = await fixture(), input = await command(f.receipt.documentId), before = await db.document.findUniqueOrThrow({ where: { id: input.id } });
  await db.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: admin.user.id, entityType: 'Synthetic', entityId: input.id, event: 'synthetic_collision' } });
  await assert.rejects(saveAdminPrivateVersion(db, admin.session, input, file(), proof()));
  assert.equal(await db.documentVersion.count({ where: { documentId: input.id } }), 1);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 0);
  assert.deepEqual(await db.document.findUniqueOrThrow({ where: { id: input.id } }), before);
  assert.deepEqual((await readPersonalAcquiredDocument(db, admin.session, input.id)).bytes, f.bytes);
});
test('concurrent append choices produce one new version and require a fresh version choice for the other', options, async () => {
  const f = await fixture(), first = await command(f.receipt.documentId), second = { ...first, commandId: randomUUID() };
  const result = await Promise.allSettled([saveAdminPrivateVersion(db, admin.session, first, file('PRIMO'), proof()),
    saveAdminPrivateVersion(db, admin.session, second, file('SECONDO'), proof())]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await db.documentVersion.count({ where: { documentId: first.id } }), 2);
});
test('native SQL rejects a private version without provenance and protects both original and administrative versions', options, async () => {
  const f = await fixture(), id = f.receipt.documentId;
  await assert.rejects(db.documentVersion.create({ data: { documentId: id, version: 2, storagePath: 'synthetic/not-written', checksum: 'a'.repeat(64) } }), /TECHNICAL_CANONICAL_ATOMIC/);
  await saveAdminPrivateVersion(db, admin.session, await command(id), file(), proof());
  const added = await latest(id);
  for (const versionId of [f.receipt.versionId, added.versionId]) {
    await assert.rejects(db.documentVersion.update({ where: { id: versionId }, data: { checksum: '0'.repeat(64) } }), /TECHNICAL_CANONICAL_RETAINED/);
    await assert.rejects(db.documentVersion.delete({ where: { id: versionId } }), /TECHNICAL_CANONICAL_RETAINED/);
  }
  const receipt = await db.adminRecordRevision.findFirstOrThrow({ where: { model: 'AdminPrivateDocumentVersion', recordId: id, operation: 'UPDATE' } });
  await assert.rejects(db.adminRecordRevision.update({ where: { commandId: receipt.commandId }, data: { after: Prisma.JsonNull } }));
});
