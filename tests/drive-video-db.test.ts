import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from './selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { previewDriveVideo, confirmDriveVideo, settleDriveVideo, readDriveVideo, listDriveVideos, driveVideoSetup } from '../src/lib/drive-video-library';
import { driveVideoAccount, driveVideoModel, type DriveVideoCommand, type DriveVideoDetails } from '../src/lib/drive-video-contract';

const enabled = process.env.RUN_DB_TESTS === '1' && process.env.DRIVE_VIDEO_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
let admin: Awaited<ReturnType<typeof syntheticPerson>>;
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
before(async () => { if (enabled) { await assertAiOrchestratorEphemeralDatabaseIdentity(db); admin = await syntheticAuthority(db); } });
after(async () => db.$disconnect());
const proof = () => ({ key, sessionToken: admin.token, stepUpToken: createPrivilegedStepUpToken({ key, role: 'admin', userId: admin.user.id, sessionToken: admin.token }) });
async function fixture(role: RoleCode = 'commerciale') {
  const reader = await syntheticPerson(db, 'Synthetic Drive reader', role);
  await db.userPermissionOverride.create({ data: { userId: reader.user.id, permission: 'video.read', allowed: true } });
  const id = randomUUID(), details: DriveVideoDetails = { url: 'https://drive.google.com/file/d/synthetic_not_real_' + id.replaceAll('-', '') + '/view',
    title: 'Synthetic Drive reference', description: 'Neutral training fixture', category: '', position: 0,
    sourceAccount: driveVideoAccount, accountConfirmed: true, downloadAllowed: false, expiresAt: null,
    selection: { people: [reader.user.id], areas: [], technicalContentReviewed: true } };
  const input: DriveVideoCommand = { protocol: 'DRIVE_VIDEO_REFERENCE_V1', commandId: randomUUID(), videoId: id, expectedVersion: 0, operation: 'SAVE_DRAFT', details };
  const p = await previewDriveVideo(db, admin.session, input);
  await confirmDriveVideo(db, admin.session, input, p.digest, proof());
  return { reader, id, details, input, token: p.digest };
}
async function transition(f: Awaited<ReturnType<typeof fixture>>, operation: DriveVideoCommand['operation'], changes: Partial<DriveVideoDetails> = {}) {
  const setup = await driveVideoSetup(db, admin.session, f.id);
  const base = { protocol: 'DRIVE_VIDEO_REFERENCE_V1' as const, commandId: randomUUID(), videoId: f.id, expectedVersion: setup.current!.revision };
  const input: DriveVideoCommand = operation === 'PUBLISH' || operation === 'SAVE_DRAFT'
    ? { ...base, operation, details: { ...setup.current!.details, ...changes } } : { ...base, operation };
  const preview = await previewDriveVideo(db, admin.session, input);
  await confirmDriveVideo(db, admin.session, input, preview.digest, proof());
  return { input, preview };
}
test('Drive draft persists without a local asset and is absent from reader list/direct URL', options, async () => {
  const before = await db.videoAsset.count(), f = await fixture();
  assert.equal(await db.videoAsset.count(), before);
  assert.equal((await driveVideoSetup(db, admin.session, f.id)).current!.state, 'DRAFT');
  assert.equal((await listDriveVideos(db, f.reader.session)).some(row => row.id === f.id), false);
  await assert.rejects(readDriveVideo(db, f.reader.session, f.id));
});
test('published Drive reference is readable only by exact selected identities; no management is inherited', options, async () => {
  const f = await fixture(), other = await syntheticPerson(db, 'Synthetic outsider', 'commerciale');
  await transition(f, 'PUBLISH');
  assert.equal((await readDriveVideo(db, f.reader.session, f.id)).url, f.details.url);
  await assert.rejects(readDriveVideo(db, other.session, f.id));
  await assert.rejects(driveVideoSetup(db, f.reader.session, f.id));
  await assert.rejects(readDriveVideo(db, { ...f.reader.session, role: 'admin' }, f.id, true));
});
test('all technical profiles require selected permission and content review with no management override', options, async () => {
  for (const role of ['consulente', 'backoffice', 'direzione'] as const) {
    const f = await fixture(role);
    if (role === 'direzione') await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission: 'technical.write', allowed: true } });
    const setup = await driveVideoSetup(db, admin.session, f.id);
    const command: DriveVideoCommand = { protocol: 'DRIVE_VIDEO_REFERENCE_V1', commandId: randomUUID(), videoId: f.id,
      expectedVersion: setup.current!.revision, operation: 'PUBLISH', details: { ...f.details, selection: { ...f.details.selection, technicalContentReviewed: false } } };
    await assert.rejects(previewDriveVideo(db, admin.session, command), /CONTENT_REVIEW_REQUIRED/);
    await transition(f, 'PUBLISH');
    assert.equal((await readDriveVideo(db, f.reader.session, f.id)).id, f.id);
    await db.userPermissionOverride.updateMany({ where: { userId: f.reader.user.id, permission: 'video.read' }, data: { allowed: false } });
    await assert.rejects(readDriveVideo(db, f.reader.session, f.id));
    await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission: 'video.manage', allowed: true } });
    await assert.rejects(driveVideoSetup(db, f.reader.session, f.id));
  }
});
test('frozen publication does not include future group members and user generations revoke old references', options, async () => {
  const f = await fixture();
  await transition(f, 'PUBLISH', { selection: { people: [], areas: ['commerciali'], technicalContentReviewed: true } });
  const later = await syntheticPerson(db, 'Synthetic later colleague', 'commerciale');
  await assert.rejects(readDriveVideo(db, later.session, f.id));
  await db.user.update({ where: { id: f.reader.user.id }, data: { name: 'Synthetic changed identity' } });
  await assert.rejects(readDriveVideo(db, f.reader.session, f.id));
});
test('all eight role codes obey named selection; unselected Admin has no viewer bypass', options, async () => {
  const f = await fixture(), viewers = [];
  for (const role of ['admin','direzione','commerciale','consulente','backoffice','amministrazione','revisore','collaboratore_limitato'] as const) {
    const viewer = await syntheticPerson(db, 'Synthetic matrix ' + role, role);
    if (role !== 'admin') await db.userPermissionOverride.create({ data: { userId: viewer.user.id, permission: 'video.read', allowed: true } });
    viewers.push(viewer);
  }
  await transition(f, 'PUBLISH', { selection: { people: viewers.map(p => p.user.id), areas: [], technicalContentReviewed: true } });
  for (const viewer of viewers) assert.equal((await readDriveVideo(db, viewer.session, f.id)).id, f.id);
  await assert.rejects(readDriveVideo(db, admin.session, f.id));
  await transition(f, 'PUBLISH', { selection: { people: [f.reader.user.id], areas: [], technicalContentReviewed: true } });
  for (const viewer of viewers) await assert.rejects(readDriveVideo(db, viewer.session, f.id));
});
test('a missing atomic audit rolls back the journal and cannot make a publication visible', options, async () => {
  const f = await fixture(), setup = await driveVideoSetup(db, admin.session, f.id);
  const input: DriveVideoCommand = { protocol: 'DRIVE_VIDEO_REFERENCE_V1', commandId: randomUUID(), videoId: f.id,
    expectedVersion: setup.current!.revision, operation: 'PUBLISH', details: f.details };
  const preview = await previewDriveVideo(db, admin.session, input);
  await db.$executeRawUnsafe(`CREATE FUNCTION drive_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."entityType"='DriveVideoReference' THEN RAISE EXCEPTION 'SYNTHETIC_DRIVE_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER drive_test_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION drive_test_audit_fault()');
  try {
    await assert.rejects(confirmDriveVideo(db, admin.session, input, preview.digest, proof()));
    assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 0);
    await assert.rejects(readDriveVideo(db, f.reader.session, f.id));
  } finally { await db.$executeRawUnsafe('DROP TRIGGER drive_test_audit_fault ON "AuditLog"'); await db.$executeRawUnsafe('DROP FUNCTION drive_test_audit_fault()'); }
});
test('archive withdraws list and direct view; restore stays private until a new exact publication', options, async () => {
  const f = await fixture(); await transition(f, 'PUBLISH'); await transition(f, 'ARCHIVE');
  await assert.rejects(readDriveVideo(db, f.reader.session, f.id));
  assert.equal((await listDriveVideos(db, f.reader.session)).some(row => row.id === f.id), false);
  await transition(f, 'RESTORE_DRAFT'); await assert.rejects(readDriveVideo(db, f.reader.session, f.id));
  await transition(f, 'PUBLISH'); assert.equal((await readDriveVideo(db, f.reader.session, f.id)).id, f.id);
});
test('source replacement first creates a private draft; old audience never follows a changed file silently', options, async () => {
  const f = await fixture(); await transition(f, 'PUBLISH');
  await assert.rejects(transition(f, 'PUBLISH', { url: f.details.url.replace('/view', 'x/view') }));
  await transition(f, 'SAVE_DRAFT', { url: f.details.url.replace('/view', 'x/view') });
  await assert.rejects(readDriveVideo(db, f.reader.session, f.id));
  await transition(f, 'PUBLISH');
  assert.notEqual((await readDriveVideo(db, f.reader.session, f.id)).url, f.details.url);
});
test('exact command replay and receipt reconciliation preserve a single immutable revision and audit', options, async () => {
  const f = await fixture();
  const count = await db.adminRecordRevision.count({ where: { model: driveVideoModel, recordId: f.id } });
  assert.equal((await confirmDriveVideo(db, admin.session, f.input, f.token, proof())).confirmed, true);
  assert.equal((await settleDriveVideo(db, admin.session, f.input, f.token)).confirmed, true);
  assert.equal(await db.adminRecordRevision.count({ where: { model: driveVideoModel, recordId: f.id } }), count);
  await assert.rejects(db.adminRecordRevision.delete({ where: { commandId: f.input.commandId } }));
  await assert.rejects(db.adminRecordRevision.update({ where: { commandId: f.input.commandId }, data: { reason: 'Synthetic mutation' } }));
  assert.equal(await db.auditLog.count({ where: { id: 'admin-record:' + f.input.commandId } }), 1);
});
test('settling an absent command creates terminal closure and prevents a late commit', options, async () => {
  const f = await fixture(), setup = await driveVideoSetup(db, admin.session, f.id);
  const input: DriveVideoCommand = { protocol: 'DRIVE_VIDEO_REFERENCE_V1', commandId: randomUUID(), videoId: f.id,
    expectedVersion: setup.current!.revision, operation: 'ARCHIVE' };
  const preview = await previewDriveVideo(db, admin.session, input);
  assert.equal((await settleDriveVideo(db, admin.session, input, preview.digest)).closed, true);
  await assert.rejects(confirmDriveVideo(db, admin.session, input, preview.digest, proof()), /CLOSED/);
  assert.equal((await driveVideoSetup(db, admin.session, f.id)).current!.state, 'DRAFT');
});
test('changed permissions invalidate preview, and stale privileged proof cannot write', options, async () => {
  const f = await fixture(), setup = await driveVideoSetup(db, admin.session, f.id);
  const input: DriveVideoCommand = { protocol: 'DRIVE_VIDEO_REFERENCE_V1', commandId: randomUUID(), videoId: f.id,
    expectedVersion: setup.current!.revision, operation: 'PUBLISH', details: f.details };
  const preview = await previewDriveVideo(db, admin.session, input);
  await db.userPermissionOverride.updateMany({ where: { userId: f.reader.user.id, permission: 'video.read' }, data: { allowed: false } });
  await assert.rejects(confirmDriveVideo(db, admin.session, input, preview.digest, proof()));
  await assert.rejects(confirmDriveVideo(db, admin.session, f.input, f.token, { ...proof(),
    stepUpToken: createPrivilegedStepUpToken({ key, role: 'admin', userId: admin.user.id, sessionToken: admin.token, nowSeconds: Math.floor(Date.now() / 1000) - 1801 }) }));
  assert.equal((await driveVideoSetup(db, admin.session, f.id)).current!.revision, 1);
});
test('expiry denies direct access and metadata without changing the Google file', options, async () => {
  const f = await fixture();
  await transition(f, 'PUBLISH', { expiresAt: new Date(Date.now() + 1800).toISOString() });
  assert.equal((await readDriveVideo(db, f.reader.session, f.id)).id, f.id);
  await new Promise(resolve => setTimeout(resolve, 1850));
  await assert.rejects(readDriveVideo(db, f.reader.session, f.id));
  assert.equal((await listDriveVideos(db, f.reader.session)).some(row => row.id === f.id), false);
});
