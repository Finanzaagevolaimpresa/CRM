import assert from 'node:assert/strict';
import test from 'node:test';
import { commercialProgressProjection, type CommercialProgressActor, type CommercialProgressContext } from '../src/lib/commercial-progress-policy';

const actor: CommercialProgressActor = { userId: 'sales_a', role: 'commerciale', active: true, permissionOverrides: [] };
const context: CommercialProgressContext = {
  client: { id: 'client_a', salesOwnerId: 'sales_a', deletedAt: null },
  practice: { id: 'practice_a', clientId: 'client_a', projectId: 'project_a', clientServiceId: 'service_a',
    commercialOwnerId: 'sales_a', technicalOwnerId: 'tech_a', status: 'in_progettazione', deletedAt: null,
    dueDate: new Date('2026-11-01Z'), nextClientUpdateAt: null, updatedAt: new Date('2026-10-22Z') },
  project: { id: 'project_a', clientId: 'client_a', status: 'in_lavorazione', deletedAt: null },
  service: { id: 'service_a', clientId: 'client_a', projectId: 'project_a', status: 'nuova', deletedAt: null },
};
const clone = () => structuredClone(context);
test('two distinct sales references retain their own progress through a technical handoff', () => {
  const own = commercialProgressProjection(actor, context);
  assert.ok(own);
  const other = clone();
  other.client.id = other.practice.clientId = other.project!.clientId = other.service!.clientId = 'client_b';
  other.client.salesOwnerId = other.practice.commercialOwnerId = 'sales_b';
  const actorB = { ...actor, userId: 'sales_b' };
  assert.equal(commercialProgressProjection(actor, other), null);
  assert.equal(commercialProgressProjection(actorB, context), null);
  assert.ok(commercialProgressProjection(actorB, other));
  const changed = clone(); changed.practice.technicalOwnerId = 'tech_b';
  assert.deepEqual(commercialProgressProjection(actor, changed), own);
  for (const userId of ['tech_a', 'tech_b']) assert.equal(commercialProgressProjection({ ...actor, userId, role: 'consulente' }, context), null);
});
test('changing either sales reference immediately removes the previous view; no fallback to the client', () => {
  for (const side of ['client', 'practice'] as const) {
    const changed = clone();
    if (side === 'client') changed.client.salesOwnerId = 'sales_b'; else changed.practice.commercialOwnerId = 'sales_b';
    assert.equal(commercialProgressProjection(actor, changed), null);
    assert.equal(commercialProgressProjection({ ...actor, userId: 'sales_b' }, changed), null);
  }
  const changed = clone(); changed.client.salesOwnerId = changed.practice.commercialOwnerId = 'sales_b';
  assert.equal(commercialProgressProjection(actor, changed), null);
  assert.ok(commercialProgressProjection({ ...actor, userId: 'sales_b' }, changed));
});
test('selective restrictions remain binding; role or ordinary ownership cannot bypass a revoked selection', () => {
  for (const patch of [{ selectiveClientIds: ['client_a'] }, { selectivePracticeIds: ['practice_a'] },
    { selectiveProjectIds: ['project_a'] }, { selectiveServiceIds: ['service_a'] },
    { active: false }, { permissionOverrides: [{ permission: 'client.read', allowed: false }] }]) {
    assert.equal(commercialProgressProjection({ ...actor, ...patch }, context), null);
  }
});
test('cross-client, missing, trashed and archived parents never produce a progress record', () => {
  const changes: Array<(c: CommercialProgressContext) => void> = [
    c => { c.practice.clientId = 'client_b'; }, c => { c.project!.clientId = 'client_b'; },
    c => { c.service!.clientId = 'client_b'; }, c => { c.project = null; },
    c => { c.service = null; }, c => { c.project!.status = 'archiviato'; },
    c => { c.service!.status = 'archiviato'; }, c => { c.practice.status = 'archiviata'; },
    c => { c.client.deletedAt = new Date(); }, c => { c.practice.deletedAt = new Date(); },
    c => { c.project!.deletedAt = new Date(); }, c => { c.service!.deletedAt = new Date(); },
    c => { c.service!.projectId = 'other_project'; },
  ];
  for (const change of changes) { const c = clone(); change(c); assert.equal(commercialProgressProjection(actor, c), null); }
});
test('projection never serializes financial data, notes, documents or arbitrary communication text', () => {
  const extended = { ...context, practice: { ...context.practice, internalNotes: 'PRIVATE',
    clientVisibleStatus: 'UNREVIEWED_TEXT', contractId: 'SECRET_CONTRACT', protocolNumber: 'PRIVATE_PROTOCOL',
    financialAmount: 1000, documentIds: ['SECRET_FILE'] } };
  const result = commercialProgressProjection(actor, extended);
  assert.deepEqual(Object.keys(result!).sort(), ['id','clientId','status','statusLabel','dueDate','nextClientUpdateAt','updatedAt'].sort());
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|UNREVIEWED|1000/);
  for (const role of ['admin', 'amministrazione', 'collaboratore_limitato'] as const) {
    assert.equal(commercialProgressProjection({ ...actor, role }, extended), null);
  }
});
