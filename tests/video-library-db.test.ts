import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from './selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { uploadVideo, previewVideo, confirmVideo, readVideoReceipt, readVideoSetup, readVideo, readVideoBytes, listVideos, readVideoPreview } from '../src/lib/video-library';
import { type VideoCommand, type VideoDetails } from '../src/lib/video-input';
import { localPathFromStoragePath } from '../src/lib/storage';
import { videoStoragePath } from '../src/lib/video-storage';
import { videoLibraryQuotaBytes, videoMaxBytes } from '../src/lib/video-file-contract';
import { revokeAllInternalSessions } from '../src/lib/internal-session-registry';

const enabled = process.env.RUN_DB_TESTS === '1' && process.env.VIDEO_LIBRARY_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person;
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
before(async () => { if (enabled) { await assertAiOrchestratorEphemeralDatabaseIdentity(db); admin = await syntheticAuthority(db); } });
after(async () => db.$disconnect());
function proof(p = admin, nowSeconds?: number) { return { key, sessionToken: p.token,
  stepUpToken: createPrivilegedStepUpToken({ key, userId: p.user.id, sessionToken: p.token, nowSeconds }) }; }
function file(bytes = 256, name = 'synthetic.mp4') {
  const data = Buffer.alloc(bytes); data.writeUInt32BE(24, 0); data.write('ftypisom', 4, 'ascii');
  // Header-only fixtures exercise persistence; native browser separately tests a playable WebM.
  return new File([data], name, { type: 'video/mp4' });
}
async function fixture(p = admin) {
  const viewer = await syntheticPerson(db, 'Synthetic video viewer', 'commerciale');
  const other = await syntheticPerson(db, 'Synthetic unselected viewer', 'backoffice');
  const id = randomUUID(); await uploadVideo(db, p.session, id, file(), proof(p));
  return { id, viewer, other, publisher: p };
}
async function command(f: Awaited<ReturnType<typeof fixture>>, operation: VideoCommand['operation'] = 'PUBLISH'): Promise<VideoCommand> {
  const setup = await readVideoSetup(db, f.publisher.session, f.id);
  const common = { commandId: randomUUID(), videoId: f.id, expectedVersion: setup.version };
  return operation === 'PUBLISH' || operation === 'SAVE_DRAFT' ? { ...common, operation,
    details: { ...setup.details, title: 'Synthetic private video', description: 'Synthetic operational instructions',
      selection: { people: [f.viewer.user.id], areas: [] }, downloadAllowed: false } } : { ...common, operation };
}
async function confirm(f: Awaited<ReturnType<typeof fixture>>, proposed?: VideoCommand) {
  const input = proposed ?? await command(f);
  const p = await previewVideo(db, f.publisher.session, input);
  return confirmVideo(db, f.publisher.session, input, p.digest, proof(f.publisher));
}

test('schema54 prefix, restrictive relations and no implicit publication', options, async () => {
  const [r] = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  assert.equal(r.count, 54);
  assert.equal(await db.videoEntry.count(), 0);
  const f = await fixture();
  assert.equal((await readVideoSetup(db, admin.session, f.id)).state, 'DRAFT');
  assert.deepEqual(await listVideos(db, f.viewer.session), []);
  await assert.rejects(readVideo(db, f.viewer.session, f.id));
  await assert.rejects(db.videoAsset.delete({ where: { id: f.id } }));
  await assert.rejects(db.videoEntry.delete({ where: { id: f.id } }));
});

test('current non-Admin cannot forge manage role; missing/expired proof writes nothing', options, async () => {
  const p = await syntheticPerson(db, 'Synthetic non manager', 'commerciale');
  const count = await db.videoAsset.count();
  await assert.rejects(uploadVideo(db, { ...p.session, role: 'admin' }, randomUUID(), file(), proof(p)));
  await assert.rejects(uploadVideo(db, admin.session, randomUUID(), file(), proof(admin, Math.floor(Date.now() / 1000) - 360)));
  assert.equal(await db.videoAsset.count(), count);
});

test('upload receipt and exact replay preserve one draft; changed bytes cannot reuse a command', options, async () => {
  const id = randomUUID(), data = file();
  await uploadVideo(db, admin.session, id, data, proof());
  assert.equal((await readVideoReceipt(db, admin.session, id)).videoId, id);
  await uploadVideo(db, admin.session, id, data, proof());
  await assert.rejects(uploadVideo(db, admin.session, id, file(257), proof()));
  assert.equal(await db.videoCommand.count({ where: { id } }), 1);
  assert.equal(await db.videoRevision.count({ where: { videoId: id } }), 1);
});

test('preview is read-only; published metadata, search, bytes and separate download obey frozen audience', options, async () => {
  const f = await fixture(), input = await command(f), commands = await db.videoCommand.count(), audit = await db.auditLog.count();
  const p = await previewVideo(db, admin.session, input);
  assert.deepEqual(p.people.map(x => x.id), [f.viewer.user.id]);
  assert.equal(await db.videoCommand.count(), commands); assert.equal(await db.auditLog.count(), audit);
  await confirmVideo(db, admin.session, input, p.digest, proof());
  assert.ok((await listVideos(db, f.viewer.session, 'private')).some(x => x.id === f.id));
  assert.ok(!(await listVideos(db, f.other.session, 'private')).some(x => x.id === f.id));
  assert.equal((await readVideoBytes(db, f.viewer.session, f.id)).bytes.length, 256);
  await assert.rejects(readVideoBytes(db, f.viewer.session, f.id, { download: true }));
  await assert.rejects(readVideoBytes(db, f.other.session, f.id));
  const published = (await readVideoSetup(db, admin.session, f.id));
  assert.equal(published.state, 'PUBLISHED');
  const logs = await db.auditLog.findMany({ where: { entityType: 'VideoEntry', entityId: f.id } });
  assert.equal(logs.length, 2); assert.doesNotMatch(JSON.stringify(logs), /Synthetic private video|operational instructions|selective.invalid/);
});

test('changes to recipient directory or proposed content invalidate the exact preview', options, async () => {
  const f = await fixture(), input = await command(f);
  const p = await previewVideo(db, admin.session, input);
  await db.user.update({ where: { id: f.viewer.user.id }, data: { name: 'Changed synthetic viewer' } });
  await assert.rejects(confirmVideo(db, admin.session, input, p.digest, proof()));
  const p2 = await previewVideo(db, admin.session, input);
  assert.ok('details' in input);
  await assert.rejects(confirmVideo(db, admin.session, { ...input, details: { ...input.details, title: 'Changed title' } }, p2.digest, proof()));
  assert.equal((await readVideoSetup(db, admin.session, f.id)).state, 'DRAFT');
});

test('recipient revocation and restoration do not revive a publication; fresh explicit publication can', options, async () => {
  const f = await fixture(); await confirm(f);
  await db.userPermissionOverride.create({ data: { userId: f.viewer.user.id, permission: 'video.read', allowed: false } });
  await assert.rejects(readVideo(db, f.viewer.session, f.id));
  await db.userPermissionOverride.deleteMany({ where: { userId: f.viewer.user.id, permission: 'video.read' } });
  await assert.rejects(readVideoBytes(db, f.viewer.session, f.id));
  await confirm(f); assert.equal((await readVideo(db, f.viewer.session, f.id)).id, f.id);
});

test('publisher authority revocation blocks old publications after reactivation', options, async () => {
  const publisher = await syntheticPerson(db, 'Synthetic publisher', 'admin'), f = await fixture(publisher);
  await confirm(f);
  await db.userPermissionOverride.create({ data: { userId: publisher.user.id, permission: 'video.manage', allowed: false } });
  await assert.rejects(readVideo(db, f.viewer.session, f.id));
  await db.userPermissionOverride.deleteMany({ where: { userId: publisher.user.id, permission: 'video.manage' } });
  await assert.rejects(readVideo(db, f.viewer.session, f.id));
});

test('archive and explicit restore preserve history and restore only a private draft', options, async () => {
  const f = await fixture(); await confirm(f); await confirm(f, await command(f, 'ARCHIVE'));
  await assert.rejects(readVideo(db, f.viewer.session, f.id));
  await confirm(f, await command(f, 'RESTORE_DRAFT'));
  const row = await db.videoEntry.findUniqueOrThrow({ where: { id: f.id } });
  assert.equal(row.state, 'DRAFT'); assert.deepEqual(row.audience, []); assert.equal(row.publishedById, null);
  await assert.rejects(readVideoBytes(db, f.viewer.session, f.id));
  assert.equal(await db.videoRevision.count({ where: { videoId: f.id } }), 4);
});

test('revoking publication remains possible when a recipient or the stored file is no longer available', options, async () => {
  const f = await fixture(); await confirm(f);
  await db.user.update({ where: { id: f.viewer.user.id }, data: { active: false } });
  await writeFile(localPathFromStoragePath(videoStoragePath(f.id)), Buffer.alloc(256));
  await confirm(f, await command(f, 'ARCHIVE'));
  await confirm(f, await command(f, 'RESTORE_DRAFT'));
  assert.equal((await readVideoSetup(db, admin.session, f.id)).state, 'DRAFT');
  await assert.rejects(confirm(f));
  await assert.rejects(readVideoBytes(db, f.viewer.session, f.id));
});

test('Admin preview as recipient checks actual access and never mutates publication', options, async () => {
  const f = await fixture(); await confirm(f); const version = (await readVideoSetup(db, admin.session, f.id)).version;
  assert.equal((await readVideoPreview(db, admin.session, f.id, proof(), f.viewer.user.id)).allowed, true);
  assert.equal((await readVideoPreview(db, admin.session, f.id, proof(), f.other.user.id)).allowed, false);
  await assert.rejects(readVideoBytes(db, admin.session, f.id, { preview: true }));
  await assert.rejects(readVideoBytes(db, admin.session, f.id, { preview: true, asRecipient: f.other.user.id, proof: proof() }));
  assert.equal((await readVideoSetup(db, admin.session, f.id)).version, version);
});

test('double confirmation and concurrent edits record one atomic revision and audit', options, async () => {
  const f = await fixture(), input = await command(f), p = await previewVideo(db, admin.session, input);
  const results = await Promise.allSettled([1, 2].map(() => confirmVideo(db, admin.session, input, p.digest, proof())));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(await db.videoCommand.count({ where: { id: input.commandId } }), 1);
  assert.equal(await db.videoRevision.count({ where: { videoId: f.id } }), 2);
  assert.equal(await db.auditLog.count({ where: { entityId: f.id, event: 'VIDEO_LIBRARY_MUTATION' } }), 2);
});

test('audit failure rolls back publication, command and revision; direct unlogged edits are rejected', options, async () => {
  const f = await fixture(), input = await command(f), p = await previewVideo(db, admin.session, input);
  await db.$executeRawUnsafe(`CREATE FUNCTION video_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER video_test_reject_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW.event='VIDEO_LIBRARY_MUTATION') EXECUTE FUNCTION video_test_reject_audit()`);
  try { await assert.rejects(confirmVideo(db, admin.session, input, p.digest, proof())); }
  finally {
    await db.$executeRawUnsafe('DROP TRIGGER video_test_reject_audit ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION video_test_reject_audit()');
  }
  assert.equal(await db.videoCommand.count({ where: { id: input.commandId } }), 0);
  assert.equal((await db.videoEntry.findUniqueOrThrow({ where: { id: f.id } })).version, 1);
  await assert.rejects(db.videoEntry.update({ where: { id: f.id }, data: { title: 'Silent mutation', version: { increment: 1 } } }));
  await assert.rejects(db.videoRevision.deleteMany({ where: { videoId: f.id } }));
});

test('current session revocation and private-file corruption deny existing playback', options, async () => {
  const f = await fixture(); await confirm(f);
  await db.$transaction(tx => revokeAllInternalSessions(tx, f.viewer.user.id, 'INTERNAL_GLOBAL', admin.user.id));
  await assert.rejects(readVideoBytes(db, f.viewer.session, f.id));
  await writeFile(localPathFromStoragePath(videoStoragePath(f.id)), Buffer.alloc(256));
  await assert.rejects(readVideoBytes(db, admin.session, f.id, { preview: true, proof: proof() }));
});

test('separate download publication is explicit; expired publication is denied at read', options, async () => {
  const f = await fixture(), input = await command(f); assert.ok('details' in input);
  const enabledDownload = { ...input, details: { ...input.details, downloadAllowed: true } };
  await confirm(f, enabledDownload); assert.equal((await readVideoBytes(db, f.viewer.session, f.id, { download: true })).bytes.length, 256);
  const next = await command(f); assert.ok('details' in next);
  const expiring: VideoDetails = { ...next.details, expiresAt: new Date(Date.now() + 1100).toISOString() };
  await confirm(f, { ...next, details: expiring });
  await new Promise(resolve => setTimeout(resolve, 1200));
  await assert.rejects(readVideoBytes(db, f.viewer.session, f.id));
  assert.ok(!(await listVideos(db, f.viewer.session)).some(x => x.id === f.id));
});

test('quota reserves before storage and serializes two concurrent remaining-capacity uploads', options, async () => {
  for (let n = 0; n < 51; n++) await db.videoAsset.create({ data: { id: randomUUID(), ownerId: admin.user.id, ownerEpoch: admin.user.recordUpdateEpoch,
    fileName: 'synthetic-reserved.mp4', mimeType: 'video/mp4', sizeBytes: videoMaxBytes, sha256: '0'.repeat(64) } });
  const ids = [randomUUID(), randomUUID()];
  const result = await Promise.allSettled(ids.map(id => uploadVideo(db, admin.session, id, file(3 * 1024 * 1024), proof())));
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok((await db.videoAsset.aggregate({ _sum: { sizeBytes: true } }))._sum.sizeBytes! <= videoLibraryQuotaBytes);
  assert.equal(await db.videoEntry.count({ where: { id: { in: ids } } }), 1);
});
