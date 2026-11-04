import test from 'node:test';
import assert from 'node:assert/strict';
import type { RoleCode } from '@prisma/client';
import { evaluatePermission, permissionOverrideControl } from '../src/lib/permission-evaluator';
import { permissionCodes } from '../src/lib/permissions';
import { internalDisclosureReader, internalDisclosureSchema } from '../src/lib/internal-content-disclosure';
import { canReadPublishedVideo, canDownloadPublishedVideo, type VideoPerson } from '../src/lib/video-access-policy';

const roles: RoleCode[] = ['admin', 'direzione', 'commerciale', 'consulente', 'backoffice', 'amministrazione', 'revisore', 'collaboratore_limitato'];
test('every editable selector actually controls allow and deny for every role and technical second function', () => {
  for (const role of roles) for (const technicalRestricted of [false, true]) {
    const actor = { role, active: true, technicalRestricted, permissionOverrides: [] };
    for (const permission of permissionCodes) {
      const control = permissionOverrideControl(actor, permission);
      if (!control.editable) { assert.ok(control.reason); continue; }
      for (const allowed of [true, false]) assert.equal(evaluatePermission({ ...actor, permissionOverrides: [{ permission, allowed }] }, permission).allowed, allowed);
    }
  }
});
test('selected text/video explicit consent works for technical profiles without financial, audit or management rights', () => {
  for (const role of roles.filter(role => role !== 'admin')) {
    const actor = { role, active: true, technicalRestricted: true, permissionOverrides: [] };
    for (const permission of ['video.read', 'communications.internal.read'] as const) {
      assert.equal(evaluatePermission(actor, permission).allowed, false);
      assert.equal(evaluatePermission({ ...actor, permissionOverrides: [{ permission, allowed: true }] }, permission).allowed, true);
      assert.equal(evaluatePermission({ ...actor, permissionOverrides: [{ permission, allowed: false }] }, permission).allowed, false);
    }
    for (const permission of ['payment.read', 'contract.read', 'audit.read', 'video.manage'] as const) {
      assert.equal(evaluatePermission({ ...actor, permissionOverrides: [{ permission, allowed: true }] }, permission).allowed, false);
    }
  }
});
test('selected text binds current participant, thread generation, identity and exact expiry', () => {
  const shared = internalDisclosureSchema.parse({ protocol: 'SELECTED_INTERNAL_TEXT_V1', reviewerUserId: 'owner',
    threadVersion: 2, participants: [{ userId: 'reader', version: 3, epoch: 4, role: 'consulente' }], expiresAt: '2026-11-04T12:00:00Z' });
  const reader = { userId: 'reader', participantVersion: 3, epoch: 4, role: 'consulente', threadVersion: 2, canRead: true };
  const now = new Date('2026-11-04T11:59:59Z');
  assert.equal(internalDisclosureReader(shared, reader, now), true);
  for (const patch of [{ userId: 'outsider' }, { participantVersion: 4 }, { epoch: 5 }, { role: 'backoffice' }, { threadVersion: 3 }, { canRead: false }]) {
    assert.equal(internalDisclosureReader(shared, { ...reader, ...patch }, now), false);
  }
  assert.equal(internalDisclosureReader(shared, reader, new Date('2026-11-04T12:00:00Z')), false);
});
test('technical video access needs exact selected audience and reviewed content; read never implies download', () => {
  const author: VideoPerson = { id: 'admin', name: '', email: '', role: 'admin', active: true, deleted: false, epoch: 1, canRead: true, canManage: true };
  for (const role of roles.filter(role => role !== 'admin')) {
    const reader: VideoPerson = { ...author, id: 'reader', role, technicalRestricted: true, canManage: false };
    const video = { state: 'PUBLISHED' as const, fileReady: true, expiresAt: null, authorId: author.id, authorEpoch: 1,
      audience: [{ id: reader.id, epoch: 1, role }], downloadAllowed: false };
    assert.equal(canReadPublishedVideo(video, reader, author, new Date()), false);
    assert.equal(canReadPublishedVideo({ ...video, technicalContentReviewed: true }, reader, author, new Date()), true);
    assert.equal(canDownloadPublishedVideo({ ...video, technicalContentReviewed: true }, reader, author, new Date()), false);
    assert.equal(canReadPublishedVideo({ ...video, technicalContentReviewed: true, audience: [] }, reader, author, new Date()), false);
  }
});
