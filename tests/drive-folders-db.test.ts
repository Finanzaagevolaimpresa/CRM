import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from './selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { previewDriveFolder, confirmDriveFolder, settleDriveFolder, readDriveFolder, listDriveFolders, driveFolderSetup } from '../src/lib/drive-folder-library';
import { driveFolderModel, type DriveFolderCommand, type DriveFolderDetails } from '../src/lib/drive-folder-contract';
import { readClientSharing } from '../src/lib/selective-client-access';
import { listDriveVideos } from '../src/lib/drive-video-library';
import { revokeAllInternalSessions } from '../src/lib/internal-session-registry';

const enabled = process.env.RUN_DB_TESTS === '1' && process.env.DRIVE_FOLDER_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
let admin: Awaited<ReturnType<typeof syntheticPerson>>;
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
before(async () => { if (enabled) { await assertAiOrchestratorEphemeralDatabaseIdentity(db); admin = await syntheticAuthority(db); } });
after(async () => db.$disconnect());
const proof = () => ({ key, sessionToken: admin.token, stepUpToken: createPrivilegedStepUpToken({ key, role: 'admin', userId: admin.user.id, sessionToken: admin.token }) });
async function fixture(role: RoleCode = 'commerciale') {
  const reader = await syntheticPerson(db, 'Synthetic folder reader', role);
  if (role !== 'admin') await db.userPermissionOverride.create({ data: { userId: reader.user.id, permission: 'drive_folders.read', allowed: true } });
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Synthetic folder client ' + randomUUID() } });
  const id = randomUUID(), details: DriveFolderDetails = { url: 'https://drive.google.com/drive/folders/synthetic_' + id.replaceAll('-', ''),
    title: 'Synthetic client folder', clientId: client.id, people: [reader.user.id], technicalContentReviewed: true, expiresAt: null };
  const input: DriveFolderCommand = { protocol: 'DRIVE_FOLDER_REFERENCE_V1', commandId: randomUUID(), folderId: id, expectedVersion: 0, operation: 'SAVE_DRAFT', details };
  const preview = await previewDriveFolder(db, admin.session, input);
  await confirmDriveFolder(db, admin.session, input, preview.digest, proof());
  return { reader, client, id, details, input, token: preview.digest };
}
async function transition(f: Awaited<ReturnType<typeof fixture>>, operation: DriveFolderCommand['operation'], changes: Partial<DriveFolderDetails> = {}) {
  const setup = await driveFolderSetup(db, admin.session, f.id);
  const base = { protocol: 'DRIVE_FOLDER_REFERENCE_V1' as const, commandId: randomUUID(), folderId: f.id, expectedVersion: setup.current!.revision };
  const input: DriveFolderCommand = operation === 'DISABLE' ? { ...base, operation } : { ...base, operation, details: { ...setup.current!.details, ...changes } };
  const preview = await previewDriveFolder(db, admin.session, input);
  await confirmDriveFolder(db, admin.session, input, preview.digest, proof());
  return { input, preview };
}

test('folder draft persists in its own journal, creates no documents/videos and stays private', options, async () => {
  const before = await Promise.all([db.document.count(), db.documentVersion.count(), db.videoEntry.count(), db.videoAsset.count(), db.adminRecordRevision.count({ where: { model: 'DriveVideoReference' } })]);
  const f = await fixture();
  assert.equal((await driveFolderSetup(db, admin.session, f.id)).current!.state, 'DRAFT');
  assert.equal((await listDriveFolders(db, f.reader.session)).some(row => row.id === f.id), false);
  await assert.rejects(readDriveFolder(db, f.reader.session, f.id));
  assert.deepEqual(await Promise.all([db.document.count(), db.documentVersion.count(), db.videoEntry.count(), db.videoAsset.count(), db.adminRecordRevision.count({ where: { model: 'DriveVideoReference' } })]), before);
});
test('list, search, direct read and client box use exactly the same authorized reference', options, async () => {
  const f = await fixture(); await transition(f, 'ACTIVATE');
  const direct = await readDriveFolder(db, f.reader.session, f.id);
  const personal = (await listDriveFolders(db, f.reader.session, { query: f.client.displayName })).find(row => row.id === f.id)!;
  const box = await listDriveFolders(db, f.reader.session, { clientId: f.client.id });
  assert.equal(direct.url, f.details.url); assert.equal(personal.id, direct.id); assert.equal(box.length, 1);
  assert.equal(box[0].version, direct.version); assert.equal(box[0].url, personal.url);
  assert.equal((await listDriveFolders(db, f.reader.session, { clientId: 'another-client' })).length, 0);
  assert.equal((await listDriveFolders(db, f.reader.session, { query: 'absent-search-value' })).length, 0);
});
test('section alone and record responsibility never add a folder; folder never adds client or video rights', options, async () => {
  const f = await fixture(), other = await syntheticPerson(db, 'Synthetic outside reader', 'commerciale');
  await db.userPermissionOverride.create({ data: { userId: other.user.id, permission: 'drive_folders.read', allowed: true } });
  await db.client.update({ where: { id: f.client.id }, data: { salesOwnerId: other.user.id } });
  await transition(f, 'ACTIVATE');
  assert.equal((await listDriveFolders(db, other.session, { query: f.client.displayName })).length, 0);
  await assert.rejects(readDriveFolder(db, other.session, f.id));
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  assert.equal((await listDriveVideos(db, f.reader.session)).length, 0);
  await assert.rejects(readDriveFolder(db, { ...f.reader.session, role: 'admin' }, f.id, true));
  await assert.rejects(driveFolderSetup(db, f.reader.session, f.id));
});
test('all eight roles need named selection; only current Admin manages', options, async () => {
  const f = await fixture(), people = [];
  for (const role of ['admin', 'commerciale', 'consulente', 'backoffice', 'direzione', 'amministrazione', 'revisore', 'collaboratore_limitato'] as const) {
    const user = await syntheticPerson(db, 'Synthetic folder ' + role, role);
    if (role !== 'admin') await db.userPermissionOverride.create({ data: { userId: user.user.id, permission: 'drive_folders.read', allowed: true } });
    people.push(user);
  }
  await transition(f, 'ACTIVATE', { people: people.map(p => p.user.id) });
  for (const person of people) {
    assert.equal((await readDriveFolder(db, person.session, f.id)).id, f.id);
    if (person.user.role !== 'admin') {
      await db.userPermissionOverride.create({ data: { userId: person.user.id, permission: 'drive_folders.manage', allowed: true } });
      await assert.rejects(driveFolderSetup(db, person.session, f.id));
    }
  }
  await assert.rejects(readDriveFolder(db, admin.session, f.id));
  await transition(f, 'ACTIVATE', { people: [f.reader.user.id] });
  for (const person of people) await assert.rejects(readDriveFolder(db, person.session, f.id));
});
test('technical profiles and technical membership require explicit content review without broad overrides', options, async () => {
  for (const role of ['consulente', 'backoffice', 'direzione', 'commerciale'] as const) {
    const f = await fixture(role);
    if (role === 'direzione' || role === 'commerciale') await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission: 'technical.write', allowed: true } });
    await assert.rejects(transition(f, 'ACTIVATE', { technicalContentReviewed: false }), /CONTENT_REVIEW_REQUIRED/);
    await transition(f, 'ACTIVATE'); assert.equal((await readDriveFolder(db, f.reader.session, f.id)).id, f.id);
  }
});
test('disable revokes list, client box and direct read; reactivation uses the same ID and fresh audience', options, async () => {
  const f = await fixture(); await transition(f, 'ACTIVATE'); await transition(f, 'DISABLE');
  await assert.rejects(readDriveFolder(db, f.reader.session, f.id));
  assert.equal((await listDriveFolders(db, f.reader.session, { clientId: f.client.id })).length, 0);
  assert.equal((await driveFolderSetup(db, admin.session, f.id)).current!.state, 'DISABLED');
  await transition(f, 'ACTIVATE'); assert.equal((await readDriveFolder(db, f.reader.session, f.id)).id, f.id);
  assert.equal(await db.adminRecordRevision.count({ where: { model: driveFolderModel, recordId: f.id, operation: 'CREATE' } }), 1);
});
test('expiry denies both list and direct metadata; an expired activation cannot be confirmed', options, async () => {
  const f = await fixture(); await transition(f, 'ACTIVATE', { expiresAt: new Date(Date.now() + 1800).toISOString() });
  assert.equal((await readDriveFolder(db, f.reader.session, f.id)).id, f.id);
  await new Promise(resolve => setTimeout(resolve, 1850));
  await assert.rejects(readDriveFolder(db, f.reader.session, f.id));
  assert.equal((await listDriveFolders(db, f.reader.session)).some(row => row.id === f.id), false);
  await assert.rejects(transition(f, 'ACTIVATE', { expiresAt: new Date(Date.now() - 1000).toISOString() }));
});
test('global account denial is effective immediately and reenabling never resurrects the old generation', options, async () => {
  const f = await fixture(); await transition(f, 'ACTIVATE');
  await db.userPermissionOverride.updateMany({ where: { userId: f.reader.user.id, permission: 'drive_folders.read' }, data: { allowed: false } });
  await assert.rejects(readDriveFolder(db, f.reader.session, f.id));
  await assert.rejects(listDriveFolders(db, f.reader.session));
  await db.userPermissionOverride.updateMany({ where: { userId: f.reader.user.id, permission: 'drive_folders.read' }, data: { allowed: true } });
  await assert.rejects(readDriveFolder(db, f.reader.session, f.id));
  await transition(f, 'ACTIVATE'); assert.equal((await readDriveFolder(db, f.reader.session, f.id)).id, f.id);
});
test('current session registry and account state prevail over a stale role assertion', options, async () => {
  const f = await fixture(); await transition(f, 'ACTIVATE');
  await db.$transaction(tx => revokeAllInternalSessions(tx, f.reader.user.id, 'INTERNAL_GLOBAL', admin.user.id));
  await assert.rejects(readDriveFolder(db, f.reader.session, f.id));
  const f2 = await fixture(); await transition(f2, 'ACTIVATE');
  await db.user.update({ where: { id: f2.reader.user.id }, data: { active: false } });
  await assert.rejects(readDriveFolder(db, f2.reader.session, f2.id));
});
test('client deletion/restore or responsibility change cannot revive the old client binding', options, async () => {
  const f = await fixture(); await transition(f, 'ACTIVATE');
  await db.client.update({ where: { id: f.client.id }, data: { deletedAt: new Date() } });
  await assert.rejects(readDriveFolder(db, f.reader.session, f.id));
  await transition(f, 'DISABLE');
  await db.client.update({ where: { id: f.client.id }, data: { deletedAt: null } });
  await transition(f, 'ACTIVATE');
  await db.client.update({ where: { id: f.client.id }, data: { salesOwnerId: f.reader.user.id } });
  await assert.rejects(readDriveFolder(db, f.reader.session, f.id));
  await transition(f, 'ACTIVATE'); assert.equal((await readDriveFolder(db, f.reader.session, f.id)).id, f.id);
});
test('a new or converted client starts with no references and no grants', options, async () => {
  const f = await fixture(), other = await db.client.create({ data: { type: 'persona_fisica', displayName: 'Synthetic newly converted client' } });
  await db.lead.create({ data: { firstName: 'Synthetic', lastName: 'Converted', status: 'vinto', clientId: other.id } });
  assert.deepEqual(await listDriveFolders(db, admin.session, { clientId: other.id, manage: true }), []);
  assert.deepEqual(await listDriveFolders(db, f.reader.session, { clientId: other.id }), []);
});
test('replacing a URL or client requires private draft; the old audience never silently follows it', options, async () => {
  const f = await fixture(); await transition(f, 'ACTIVATE');
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Synthetic other company' } });
  const url = f.details.url + '_replacement';
  await assert.rejects(transition(f, 'ACTIVATE', { url }));
  await assert.rejects(transition(f, 'ACTIVATE', { clientId: client.id }));
  await transition(f, 'SAVE_DRAFT', { url, clientId: client.id });
  await assert.rejects(readDriveFolder(db, f.reader.session, f.id));
  await transition(f, 'ACTIVATE');
  assert.equal((await readDriveFolder(db, f.reader.session, f.id)).url, url);
  assert.equal((await listDriveFolders(db, f.reader.session, { clientId: f.client.id })).length, 0);
  assert.equal((await listDriveFolders(db, f.reader.session, { clientId: client.id }))[0].id, f.id);
});
test('duplicate canonical folder is rejected even under a different account hint, key or disabled reference', options, async () => {
  const f = await fixture(); await transition(f, 'DISABLE');
  const input = { ...f.input, commandId: randomUUID(), folderId: randomUUID(), details: { ...f.details,
    url: f.details.url.replace('/drive/folders/', '/drive/u/2/folders/') + '?resourcekey=synthetic_key_123456' } };
  await assert.rejects(previewDriveFolder(db, admin.session, input), /DUPLICATE/);
});
test('exact retry and lost response settlement persist a single revision and matching immutable audit', options, async () => {
  const f = await fixture();
  assert.equal((await confirmDriveFolder(db, admin.session, f.input, f.token, proof())).confirmed, true);
  assert.equal((await settleDriveFolder(db, admin.session, f.input, f.token)).confirmed, true);
  assert.equal(await db.adminRecordRevision.count({ where: { model: driveFolderModel, recordId: f.id } }), 1);
  assert.equal(await db.auditLog.count({ where: { id: 'admin-record:' + f.input.commandId } }), 1);
  await assert.rejects(db.adminRecordRevision.delete({ where: { commandId: f.input.commandId } }));
  await assert.rejects(confirmDriveFolder(db, admin.session, { ...f.input, folderId: randomUUID() }, f.token, proof()));
});
test('settlement of absent command closes it atomically and rejects a late mutation', options, async () => {
  const f = await fixture();
  const input: DriveFolderCommand = { protocol: 'DRIVE_FOLDER_REFERENCE_V1', folderId: f.id, commandId: randomUUID(), expectedVersion: 1, operation: 'DISABLE' };
  const preview = await previewDriveFolder(db, admin.session, input);
  assert.equal((await settleDriveFolder(db, admin.session, input, preview.digest)).closed, true);
  await assert.rejects(confirmDriveFolder(db, admin.session, input, preview.digest, proof()), /CLOSED/);
  assert.equal((await driveFolderSetup(db, admin.session, f.id)).current!.revision, 1);
});
test('30-minute proof expiration preserves draft and old decision cannot act after recipient changes', options, async () => {
  const f = await fixture();
  const input: DriveFolderCommand = { protocol: 'DRIVE_FOLDER_REFERENCE_V1', folderId: f.id, commandId: randomUUID(), expectedVersion: 1, operation: 'ACTIVATE', details: f.details };
  const preview = await previewDriveFolder(db, admin.session, input);
  const oldProof = { ...proof(), stepUpToken: createPrivilegedStepUpToken({ key, role: 'admin', userId: admin.user.id,
    sessionToken: admin.token, nowSeconds: Math.floor(Date.now() / 1000) - 1801 }) };
  await assert.rejects(confirmDriveFolder(db, admin.session, input, preview.digest, oldProof));
  assert.equal((await driveFolderSetup(db, admin.session, f.id)).current!.revision, 1);
  await db.user.update({ where: { id: f.reader.user.id }, data: { name: 'Synthetic renamed recipient' } });
  await assert.rejects(confirmDriveFolder(db, admin.session, input, preview.digest, proof()));
  assert.equal((await settleDriveFolder(db, admin.session, input, preview.digest)).closed, true);
  await transition(f, 'ACTIVATE'); assert.equal((await readDriveFolder(db, f.reader.session, f.id)).id, f.id);
});
test('missing paired audit rolls back the whole reference mutation', options, async () => {
  const f = await fixture();
  const input: DriveFolderCommand = { protocol: 'DRIVE_FOLDER_REFERENCE_V1', folderId: f.id, commandId: randomUUID(), expectedVersion: 1, operation: 'ACTIVATE', details: f.details };
  const preview = await previewDriveFolder(db, admin.session, input);
  await db.$executeRawUnsafe(`CREATE FUNCTION folder_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."entityType"='DriveFolderReference' THEN RAISE EXCEPTION 'SYNTHETIC_FOLDER_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER folder_test_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION folder_test_audit_fault()');
  try {
    await assert.rejects(confirmDriveFolder(db, admin.session, input, preview.digest, proof()));
    assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 0);
    await assert.rejects(readDriveFolder(db, f.reader.session, f.id));
  } finally { await db.$executeRawUnsafe('DROP TRIGGER folder_test_audit_fault ON "AuditLog"'); await db.$executeRawUnsafe('DROP FUNCTION folder_test_audit_fault()'); }
});
test('concurrent activations from the same version produce only one committed transition', options, async () => {
  const f = await fixture(), base = { protocol: 'DRIVE_FOLDER_REFERENCE_V1' as const, folderId: f.id, expectedVersion: 1, operation: 'ACTIVATE' as const, details: f.details };
  const first = { ...base, commandId: randomUUID() }, second = { ...base, commandId: randomUUID() };
  const previews = await Promise.all([previewDriveFolder(db, admin.session, first), previewDriveFolder(db, admin.session, second)]);
  const results = await Promise.allSettled([confirmDriveFolder(db, admin.session, first, previews[0].digest, proof()), confirmDriveFolder(db, admin.session, second, previews[1].digest, proof())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await driveFolderSetup(db, admin.session, f.id)).current!.revision, 2);
});
