import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoleCode } from '@prisma/client';
import { canViewLead, canEditLead, canAssignService } from '../src/lib/access-control';
import { changedAssignee } from '../src/lib/manual-assignment-guard';

test('the unassigned lead queue is admin-only, including direction and custom-permission roles', () => {
  const roles: RoleCode[] = ['admin', 'direzione', 'commerciale', 'consulente', 'backoffice', 'amministrazione', 'revisore', 'collaboratore_limitato'];
  for (const role of roles) {
    const user = { id: 'operator', role };
    assert.equal(canViewLead(user, { assignedToId: null }), role === 'admin');
    assert.equal(canEditLead(user, { assignedToId: null }), role === 'admin');
    assert.equal(canAssignService(user, { clientId: 'client', assignedToId: 'operator', client: { id: 'client', salesOwnerId: 'operator', consultantId: 'operator' } }), role === 'admin');
  }
});
test('normal form edits cannot silently clear or replay ownership; explicit clearing stays distinguishable', () => {
  assert.equal(changedAssignee('owner', false), undefined);
  assert.equal(changedAssignee('owner', true, 'owner'), undefined);
  assert.equal(changedAssignee(null, true, undefined), undefined);
  assert.equal(changedAssignee('owner', true, undefined), null);
  assert.equal(changedAssignee('owner', true, ''), null);
  assert.equal(changedAssignee('owner', true, 'next'), 'next');
});
