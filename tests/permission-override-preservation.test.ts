import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalUneditableDenials, preserveUneditableOverrides } from '../src/lib/permission-override-preservation';
import { evaluatePermission, type PermissionSession } from '../src/lib/permission-evaluator';
import { permissionOverrideControl } from '../src/lib/permission-evaluator';
import { permissionCodes } from '../src/lib/permissions';
import type { RoleCode } from '@prisma/client';

const actor: PermissionSession = { role: 'consulente', active: true, permissionOverrides: [
  { permission: 'video.manage', allowed: false }, { permission: 'user.write', allowed: false },
  { permission: 'communications.internal.read', allowed: false },
] };
test('a form omitting disabled fields retains their exact values while changing only the editable choices', () => {
  const next = preserveUneditableOverrides(actor, [{ permission: 'communications.internal.read', allowed: true }]);
  assert.deepEqual(next, [{ permission: 'communications.internal.read', allowed: true }, ...actor.permissionOverrides.slice(0, 2)]);
  assert.equal(evaluatePermission({ ...actor, permissionOverrides: next }, 'video.manage').allowed, false);
});
test('omitted editable selections can inherit; forged readonly values are rejected', () => {
  assert.deepEqual(preserveUneditableOverrides(actor, []), actor.permissionOverrides.slice(0, 2));
  for (const allowed of [true, false]) assert.throws(() => preserveUneditableOverrides(actor, [{ permission: 'video.manage', allowed }]));
});
test('a retained historical allow never opens a technical financial capability', () => {
  const old = { ...actor, permissionOverrides: [{ permission: 'contract.read', allowed: true }] };
  const next = preserveUneditableOverrides(old, []);
  assert.deepEqual(next, old.permissionOverrides);
  assert.equal(evaluatePermission({ ...old, permissionOverrides: next }, 'contract.read').allowed, false);
});
test('recovery selects only absent immutable denials from an exact audit successor', () => {
  const current = { ...actor, permissionOverrides: [{ permission: 'communications.internal.read', allowed: true }] };
  assert.deepEqual(historicalUneditableDenials(current, actor.permissionOverrides, current.permissionOverrides), actor.permissionOverrides.slice(0, 2));
  assert.deepEqual(historicalUneditableDenials(current, actor.permissionOverrides, []), []);
  assert.deepEqual(historicalUneditableDenials({ ...current, role: 'admin' }, actor.permissionOverrides, current.permissionOverrides), []);
});
test('recovery cannot replay allow entries, editable choices or malformed/duplicate history', () => {
  const current = { ...actor, permissionOverrides: [] };
  assert.deepEqual(historicalUneditableDenials(current, [{ permission: 'contract.read', allowed: true }, { permission: 'video.read', allowed: false }], []), []);
  for (const history of [null, {}, [{ permission: 'unknown', allowed: false }], [actor.permissionOverrides[0], actor.permissionOverrides[0]]]) {
    assert.deepEqual(historicalUneditableDenials(current, history, []), []);
  }
});
test('recovery does not store an ignored deny for a role-protected capability that is currently allowed', () => {
  const current: PermissionSession = { role: 'direzione', active: true, permissionOverrides: [] };
  assert.deepEqual(historicalUneditableDenials(current, [{ permission: 'lead.inbox.assign', allowed: false }], []), []);
});
test('every role and technical second function retain the entire noneditable catalogue exactly', () => {
  const roles: RoleCode[] = ['admin', 'direzione', 'commerciale', 'consulente', 'backoffice', 'amministrazione', 'revisore', 'collaboratore_limitato'];
  for (const role of roles) for (const technicalRestricted of [false, true]) {
    const current: PermissionSession = { role, active: true, technicalRestricted,
      permissionOverrides: permissionCodes.map(permission => ({ permission, allowed: false })) };
    const retained = preserveUneditableOverrides(current, []);
    assert.deepEqual(retained, current.permissionOverrides.filter(row => !permissionOverrideControl(current, row.permission as typeof permissionCodes[number]).editable));
    assert.equal(new Set(retained.map(row => row.permission)).size, retained.length);
  }
});

test('entering any technical function retains prior allow and deny choices for every nontechnical operator role', () => {
  const roles: RoleCode[] = ['direzione', 'commerciale', 'amministrazione', 'revisore', 'collaboratore_limitato'];
  for (const role of roles) for (const trigger of ['technical.write', 'technical.status', 'technical.assign', 'technical.admin']) {
    for (const allowed of [true, false]) {
      const current: PermissionSession = { role, active: true, technicalRestricted: false,
        permissionOverrides: ['legal.read', 'user.write'].map(permission => ({ permission, allowed })) };
      for (const permission of ['legal.read', 'user.write'] as const) assert.equal(permissionOverrideControl(current, permission).editable, true);
      const requested = [{ permission: trigger, allowed: true }];
      const next = preserveUneditableOverrides(current, requested);
      assert.deepEqual(next, [...requested, ...current.permissionOverrides]);
      for (const permission of ['legal.read', 'user.write'] as const) {
        assert.equal(permissionOverrideControl({ ...current, permissionOverrides: next }, permission).editable, false);
        assert.equal(evaluatePermission({ ...current, permissionOverrides: next }, permission).allowed, false);
        assert.throws(() => preserveUneditableOverrides(current, [...requested, { permission, allowed: !allowed }]));
      }
    }
  }
});
