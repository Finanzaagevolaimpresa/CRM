import assert from 'node:assert/strict';
import test from 'node:test';
import { editableRolePermission, normalizeRoleProfile, originalRoleProfile, profileRole, roleProfileDigest } from '../src/lib/admin-role-profile-contract';
test('role presets reject Admin and permissions whose native protection cannot be overridden', () => {
  assert.equal(profileRole.safeParse('admin').success, false);
  for (const code of ['payment.write', 'lead.inbox.assign', 'lead.duplicate.resolve', 'ai.execution.consume', 'video.manage'] as const)
    assert.equal(editableRolePermission('commerciale', code), false);
  assert.equal(editableRolePermission('amministrazione', 'payment.write'), true);
});
test('permission presets reject duplicates and unknown capabilities instead of silently combining decisions', () => {
  assert.throws(() => normalizeRoleProfile('commerciale', [{ permission: 'lead.write', allowed: true }, { permission: 'lead.write', allowed: false }]));
  assert.throws(() => normalizeRoleProfile('commerciale', [{ permission: 'invented.action', allowed: true }]));
  assert.throws(() => normalizeRoleProfile('commerciale', [{ permission: 'ai.execution.request', allowed: true }]));
});
test('equivalent choices have one stable profile representation and retain explicit denials', () => {
  assert.deepEqual(normalizeRoleProfile('commerciale', [{ permission: 'lead.write', allowed: true }]), []);
  const a = normalizeRoleProfile('commerciale', [{ permission: 'lead.write', allowed: false }, { permission: 'company.write', allowed: true }]);
  const b = normalizeRoleProfile('commerciale', [...a].reverse());
  assert.equal(roleProfileDigest(a), roleProfileDigest(b));
  assert.deepEqual(a, [{ permission: 'company.write', allowed: true }, { permission: 'lead.write', allowed: false }]);
});
test('profile baseline binds the role and its supported permission catalogue without granting a new capability', () => {
  const commercial = originalRoleProfile('commerciale'), technician = originalRoleProfile('consulente');
  assert.equal(commercial.revision, 0); assert.deepEqual(commercial.overrides, []);
  assert.notEqual(commercial.catalogueHash, technician.catalogueHash);
});
