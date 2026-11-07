import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseDriveFolderLink, driveFolderCommand, driveFolderSnapshot, type DriveFolderDetails } from '../src/lib/drive-folder-contract';
import { canReadFolder, resolveFolderAudience, type FolderPerson } from '../src/lib/drive-folder-policy';
import { createFolderDecision, verifyFolderDecision } from '../src/lib/drive-folder-decision';
import { createVideoDecision } from '../src/lib/video-decision';
import { evaluatePermission, permissionOverrideControl } from '../src/lib/permission-evaluator';
import { technicalPageMode, technicalActionAllowed, technicalFileRouteAllowed } from '../src/lib/technical-surface-policy';

const canonical = 'https://drive.google.com/drive/folders/synthetic_folder_001';
const details: DriveFolderDetails = { clientId: 'synthetic-client', title: 'Synthetic folder', url: canonical,
  people: ['reader'], technicalContentReviewed: false, expiresAt: null };
const reader: FolderPerson = { id: 'reader', name: 'Synthetic reader', email: 'reader@example.invalid', role: 'commerciale',
  active: true, deleted: false, epoch: 1, canRead: true, canManage: false };
const author: FolderPerson = { ...reader, id: 'admin', role: 'admin', canManage: true };
const client = { id: details.clientId, displayName: 'Synthetic client', status: 'attivo', deletedAt: null, recordUpdateEpoch: 1 };
const now = new Date('2026-01-01T12:00:00Z');
const row = driveFolderSnapshot.parse({ id: randomUUID(), revision: 1, state: 'ACTIVE', details, clientName: client.displayName,
  clientEpoch: 1, audience: [{ id: reader.id, role: reader.role, epoch: 1 }], publisherId: author.id, publisherEpoch: 1, updatedAt: now.toISOString() });

test('folder links accept only Drive folders and canonicalize account hint/tracking, retaining resource key', () => {
  assert.equal(parseDriveFolderLink(canonical + '?usp=sharing').url, canonical);
  assert.equal(parseDriveFolderLink(canonical.replace('/drive/folders/', '/drive/u/2/folders/') + '/').url, canonical);
  assert.equal(parseDriveFolderLink(canonical + '?resourcekey=synthetic_resource_01').url, canonical + '?resourcekey=synthetic_resource_01');
  for (const invalid of ['http:' + canonical.slice(6), canonical.replace('drive.google.com', 'drive.google.com.evil.test'),
    canonical.replace('drive.google.com', 'docs.google.com'), canonical.replace('drive.google.com', 'user@drive.google.com'),
    canonical.replace('/drive/folders/', '/file/d/'), canonical + '?redirect=https://evil.invalid', canonical + '#x',
    canonical + '?usp=x&usp=y', canonical + '?resourcekey=short', canonical + '?resourcekey=synthetic_resource_01&resourcekey=synthetic_resource_02',
    canonical.replace('synthetic_folder_001', '%73ynthetic_folder_001'), canonical.replace('/drive/', '\\drive/'),
    canonical.replace('drive.google.com', 'drive.google.com:8443'), canonical + '\nextra', canonical + '/child']) {
    assert.throws(() => parseDriveFolderLink(invalid), /DRIVE_FOLDER_LINK_INVALID/, invalid);
  }
});
test('folder commands reject file payloads, groups, duplicate recipients and unknown fields', () => {
  const base = { protocol: 'DRIVE_FOLDER_REFERENCE_V1', commandId: randomUUID(), folderId: randomUUID(), expectedVersion: 0, operation: 'SAVE_DRAFT', details };
  assert.ok(driveFolderCommand.safeParse(base).success);
  for (const extra of [{ file: 'bytes' }, { description: 'free notes' }, { areas: ['commerciali'] }, { people: ['reader', 'reader'] }]) {
    assert.equal(driveFolderCommand.safeParse({ ...base, details: { ...details, ...extra } }).success, false);
  }
});
test('section permission defaults closed and individual override never grants management or records', () => {
  for (const role of ['commerciale', 'consulente', 'backoffice', 'direzione', 'amministrazione', 'revisore', 'collaboratore_limitato'] as const) {
    const actor = { role, active: true, permissionOverrides: [] };
    assert.equal(evaluatePermission(actor, 'drive_folders.read').allowed, false);
    assert.equal(permissionOverrideControl(actor, 'drive_folders.read').editable, true);
    const selected = { ...actor, permissionOverrides: [{ permission: 'drive_folders.read', allowed: true }, { permission: 'drive_folders.manage', allowed: true }] };
    assert.equal(evaluatePermission(selected, 'drive_folders.read').allowed, true);
    assert.equal(evaluatePermission(selected, 'drive_folders.manage').allowed, false);
    assert.equal(evaluatePermission({ ...selected, active: false }, 'drive_folders.read').allowed, false);
  }
  for (const permission of ['payment.read', 'contract.read', 'audit.read'] as const) {
    assert.equal(evaluatePermission({ role: 'consulente', active: true, permissionOverrides: [
      { permission: 'drive_folders.read', allowed: true }, { permission, allowed: true }] }, permission).allowed, false);
  }
});
test('only exact selected current users read an active folder; client access and Video rights are irrelevant', () => {
  assert.equal(canReadFolder(row, client, reader, author, now), true);
  for (const altered of [{ id: 'outsider' }, { canRead: false }, { epoch: 2 }, { role: 'admin' }, { active: false }, { deleted: true }]) {
    assert.equal(canReadFolder(row, client, { ...reader, ...altered }, author, now), false);
  }
  assert.equal(canReadFolder(row, client, author, author, now), false);
  for (const altered of [{ state: 'DRAFT' as const }, { state: 'DISABLED' as const }, { details: { ...details, expiresAt: now.toISOString() } }]) {
    assert.equal(canReadFolder({ ...row, ...altered }, client, reader, author, now), false);
  }
  for (const altered of [null, { ...client, deletedAt: now }, { ...client, status: 'sospeso' }, { ...client, status: 'archiviato' }, { ...client, recordUpdateEpoch: 2 }, { ...client, id: 'another' }]) {
    assert.equal(canReadFolder(row, altered, reader, author, now), false);
  }
  for (const altered of [null, { ...author, epoch: 2 }, { ...author, active: false }, { ...author, canManage: false }]) {
    assert.equal(canReadFolder(row, client, reader, altered, now), false);
  }
});
test('technical function and secondary membership cannot bypass content review through a selected folder', () => {
  for (const technical of [{ ...reader, role: 'consulente' }, { ...reader, role: 'backoffice' }, { ...reader, technicalRestricted: true }]) {
    const selected = { ...row, audience: [{ id: technical.id, role: technical.role, epoch: technical.epoch }] };
    assert.throws(() => resolveFolderAudience(details, [technical], true), /CONTENT_REVIEW_REQUIRED/);
    assert.equal(canReadFolder(selected, client, technical, author, now), false);
    assert.equal(canReadFolder({ ...selected, details: { ...details, technicalContentReviewed: true } }, client, technical, author, now), true);
  }
  assert.equal(resolveFolderAudience({ ...details, people: [] }, [reader], false), null);
  assert.throws(() => resolveFolderAudience({ ...details, people: [] }, [reader], true), /RECIPIENT_UNAVAILABLE/);
  assert.throws(() => resolveFolderAudience(details, [{ ...reader, canRead: false }], true), /RECIPIENT_UNAVAILABLE/);
});
test('technical routes expose only admitted folder views and never management/actions/other records', () => {
  for (const route of ['/drive-folders', '/drive-folders/[id]']) assert.equal(technicalPageMode(route), 'original');
  for (const route of ['/drive-folders/manage', '/drive-folders/manage/[id]', '/clients/[id]', '/contracts', '/payments']) assert.equal(technicalPageMode(route), 'denied');
  assert.equal(technicalFileRouteAllowed('/drive-folders/[id]/open'), true);
  assert.equal(technicalActionAllowed({ role: 'consulente' }, 'drive-folder-actions:confirmDriveFolderAction'), false);
});
test('folder decisions bind exact proposal, identity and key; expiry permits only reconciliation, never mutation', () => {
  const key = { version: 1, secret: 'synthetic-folder-decision-secret-not-production-00000000' };
  const identity = { actorId: author.id, sessionId: randomUUID(), actorEpoch: 1 };
  const command = driveFolderCommand.parse({ protocol: 'DRIVE_FOLDER_REFERENCE_V1', commandId: randomUUID(), folderId: row.id, expectedVersion: 0, operation: 'SAVE_DRAFT', details });
  const digest = 'a'.repeat(64), token = createFolderDecision(key, identity, command, digest, now);
  assert.equal(verifyFolderDecision(key, identity, command, token, new Date(+now + 299000)).decisionHash, digest);
  const expiry = new Date(+now + 300000);
  assert.throws(() => verifyFolderDecision(key, identity, command, token, expiry));
  assert.equal(verifyFolderDecision(key, identity, command, token, expiry, { closing: true }).decisionHash, digest);
  assert.throws(() => verifyFolderDecision(key, identity, { ...command, commandId: randomUUID() }, token, now));
  assert.throws(() => verifyFolderDecision(key, { ...identity, sessionId: randomUUID() }, command, token, now));
  assert.throws(() => verifyFolderDecision({ ...key, version: 2 }, identity, command, token, now));
  // An otherwise valid decision signed for the existing Video resource is not a folder decision.
  const videoToken = createVideoDecision(key, identity, { ...command, protocol: 'VIDEO_LIBRARY_V1' } as never, digest, now);
  assert.throws(() => verifyFolderDecision(key, identity, command, videoToken, now));
});
