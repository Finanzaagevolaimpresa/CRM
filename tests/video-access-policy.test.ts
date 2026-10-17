import test from 'node:test';
import assert from 'node:assert/strict';
import { canDownloadPublishedVideo, canReadPublishedVideo, resolveVideoAudience, type VideoPerson, type VideoPublication } from '../src/lib/video-access-policy';

const now = new Date('2026-10-17T12:00:00Z');
const person = (id: string, role = 'commerciale'): VideoPerson => ({ id, name: id, role, active: true, deleted: false, epoch: 1, canRead: true, canManage: role === 'admin' });
const admin = person('admin', 'admin'), reader = person('reader'), hidden = person('hidden', 'amministrazione');
const publication = (): VideoPublication => ({ state: 'PUBLISHED', fileReady: true, expiresAt: null,
  authorId: admin.id, authorEpoch: 1, audience: [{ id: reader.id, epoch: 1, role: reader.role }], downloadAllowed: false });

test('areas expand only to named current readers and deduplicate explicit people', () => {
  const result = resolveVideoAudience({ people: ['reader'], areas: ['commerciali'] }, [admin, reader, hidden]);
  assert.deepEqual(result.people, [{ id: 'reader', name: 'reader', role: 'commerciale' }]);
  assert.deepEqual(result.audience, [{ id: 'reader', epoch: 1, role: 'commerciale' }]);
  assert.equal(canReadPublishedVideo(publication(), hidden, admin, now), false);
});
test('empty, unknown, duplicate, unavailable and oversized choices fail closed', () => {
  for (const choice of [{ people: [], areas: [] }, { people: ['unknown'], areas: [] }, { people: ['reader', 'reader'], areas: [] },
    { people: [], areas: ['invented'] }, { people: [], areas: ['tecnico'] }, { people: ['reader'], areas: [], override: true }]) {
    assert.throws(() => resolveVideoAudience(choice, [reader]));
  }
  assert.throws(() => resolveVideoAudience({ people: ['reader'], areas: [] }, [{ ...reader, active: false }]));
  assert.throws(() => resolveVideoAudience({ people: [], areas: ['commerciali'] }, Array.from({ length: 101 }, (_, i) => person('u' + i))));
});
test('preview binding changes when a group member joins, leaves or changes generation', () => {
  const selection = { people: [], areas: ['commerciali'] };
  const before = resolveVideoAudience(selection, [reader, hidden]).binding;
  assert.notEqual(resolveVideoAudience(selection, [reader, hidden, person('new')]).binding, before);
  assert.notEqual(resolveVideoAudience(selection, [{ ...reader, epoch: 2 }, hidden]).binding, before);
  assert.notEqual(resolveVideoAudience(selection, [reader, { ...hidden, role: 'commerciale' }]).binding, before);
});
test('new area members do not inherit an already published audience', () => {
  assert.equal(canReadPublishedVideo(publication(), person('new'), admin, now), false);
  assert.equal(canReadPublishedVideo(publication(), reader, admin, now), true);
});
test('open-session revocation and later reactivation do not resurrect access', () => {
  for (const changed of [{ ...reader, epoch: 2 }, { ...reader, active: false }, { ...reader, deleted: true },
    { ...reader, canRead: false }, { ...reader, role: 'consulente' }]) {
    assert.equal(canReadPublishedVideo(publication(), changed, admin, now), false);
  }
  assert.equal(canReadPublishedVideo(publication(), { ...reader, epoch: 3 }, admin, now), false);
});
test('publisher revocation, role or permission change stops publication access', () => {
  for (const author of [null, { ...admin, epoch: 2 }, { ...admin, active: false }, { ...admin, canManage: false },
    { ...admin, role: 'direzione' }, { ...admin, id: 'different-admin' }]) {
    assert.equal(canReadPublishedVideo(publication(), reader, author, now), false);
  }
});
test('archive, draft, incomplete file and expiry block metadata and media policy', () => {
  for (const patch of [{ state: 'ARCHIVED' as const }, { state: 'DRAFT' as const }, { fileReady: false },
    { expiresAt: now }, { expiresAt: new Date('invalid') }]) {
    assert.equal(canReadPublishedVideo({ ...publication(), ...patch }, reader, admin, now), false);
  }
  assert.equal(canReadPublishedVideo({ ...publication(), expiresAt: new Date(now.getTime() + 1) }, reader, admin, now), true);
});
test('download is a separate choice and never bypasses the current viewing policy', () => {
  assert.equal(canDownloadPublishedVideo(publication(), reader, admin, now), false);
  assert.equal(canDownloadPublishedVideo({ ...publication(), downloadAllowed: true }, reader, admin, now), true);
  assert.equal(canDownloadPublishedVideo({ ...publication(), downloadAllowed: true }, hidden, admin, now), false);
});
