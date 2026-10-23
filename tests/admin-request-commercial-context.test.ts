import assert from 'node:assert/strict';
import test from 'node:test';
import { commercialAdminRequestContext, type CommercialAdminRequestSnapshot } from '../src/lib/admin-request-commercial-context';
import { admitsAdminRequestSubmission, type CurrentCommercialRequestAdmission } from '../src/lib/admin-request-contract';

const lead = { id: 'lead-a', recordUpdateEpoch: 4, deletedAt: null, status: 'qualificato', assignedToId: 'sales-a', clientId: null };
const client = { id: 'client-a', recordUpdateEpoch: 7, deletedAt: null, status: 'attivo', salesOwnerId: 'sales-a' };
const fromLead = (): CommercialAdminRequestSnapshot => ({ kind: 'Lead', targetId: lead.id, lead: { ...lead }, client: null });
const fromClient = (): CommercialAdminRequestSnapshot => ({ kind: 'Client', targetId: client.id, lead: null, client: { ...client } });

test('unconverted assigned lead and owned client have distinct canonical contexts', () => {
  const l = commercialAdminRequestContext(fromLead())!, c = commercialAdminRequestContext(fromClient())!;
  assert.equal(l.commercialOwnerId, 'sales-a'); assert.equal(c.commercialOwnerId, 'sales-a');
  assert.equal(l.clientId, null); assert.equal(c.clientId, 'client-a');
  assert.notEqual(l.contextSha256, c.contextSha256);
  assert.deepEqual(Object.keys(l).sort(), ['subject', 'commercialOwnerId', 'clientId', 'accessRevision', 'contextSha256'].sort());
});

test('linking a lead to a client requires the exact live parent and same commercial owner', () => {
  const linked = { ...fromLead(), lead: { ...lead, clientId: client.id }, client };
  assert.ok(commercialAdminRequestContext(linked));
  for (const changed of [null, { ...client, id: 'foreign-client' }, { ...client, salesOwnerId: 'sales-b' },
    { ...client, deletedAt: new Date() }, { ...client, status: 'sospeso' }]) {
    assert.equal(commercialAdminRequestContext({ ...linked, client: changed }), null);
  }
  assert.equal(commercialAdminRequestContext({ ...fromLead(), client }), null);
});

test('no owner, wrong root and inconsistent subject are rejected', () => {
  for (const s of [{ ...fromLead(), targetId: 'lead-b' }, { ...fromClient(), targetId: 'client-b' },
    { ...fromLead(), lead: { ...lead, assignedToId: null } },
    { ...fromClient(), client: { ...client, salesOwnerId: null } },
    { ...fromClient(), lead }, { ...fromLead(), kind: 'Project' }]) {
    assert.equal(commercialAdminRequestContext(s), null);
  }
});

test('trash, archive and suspended parents cannot reopen a request', () => {
  for (const s of [fromLead(), fromClient()]) {
    const key = s.kind === 'Lead' ? 'lead' : 'client';
    for (const delta of [{ deletedAt: new Date() }, { status: 'archiviato' }, { status: 'archiviata' }, { status: 'sospeso' }]) {
      assert.equal(commercialAdminRequestContext({ ...s, [key]: { ...s[key], ...delta } }), null);
    }
  }
});

test('A to B to A ownership/lifecycle remains stale through canonical epochs', () => {
  const original = commercialAdminRequestContext(fromClient())!;
  const changed = commercialAdminRequestContext({ ...fromClient(), client: { ...client, salesOwnerId: 'sales-b', recordUpdateEpoch: 8 } })!;
  const returned = commercialAdminRequestContext({ ...fromClient(), client: { ...client, recordUpdateEpoch: 9 } })!;
  assert.notEqual(original.contextSha256, changed.contextSha256);
  assert.notEqual(original.contextSha256, returned.contextSha256);
});

test('ordinary progress changes do not supply a new ownership context; private columns are rejected', () => {
  const before = commercialAdminRequestContext(fromLead())!;
  const after = commercialAdminRequestContext({ ...fromLead(), lead: { ...lead, status: 'contattato' } })!;
  assert.equal(before.contextSha256, after.contextSha256);
  for (const privateColumns of [{ email: 'not-returned@example.test' }, { notes: 'private' }, { updatedAt: new Date() }, { payment: 100 }]) {
    assert.equal(commercialAdminRequestContext({ ...fromLead(), lead: { ...lead, ...privateColumns } }), null);
  }
});

test('invalid or missing canonical epochs fail closed', () => {
  for (const value of [undefined, 0, -1, 1.5, Number.NaN, 2_147_483_648]) {
    assert.equal(commercialAdminRequestContext({ ...fromClient(), client: { ...client, recordUpdateEpoch: value } }), null);
  }
});

test('canonical context admits only its commercial owner with the current user epoch and permission ceiling', () => {
  const context = commercialAdminRequestContext(fromClient())!;
  const current: CurrentCommercialRequestAdmission = { role: 'commerciale', userId: 'sales-a', active: true,
    sessionLive: true, registryCurrent: true, recordWorkable: true, selectiveCeilingAllows: true,
    ...context, recipientEpoch: 3 };
  const command = { commandId: '41000000-0000-4000-8000-000000000001', subject: context.subject,
    expectedContextSha256: context.contextSha256, expectedRecipientEpoch: 3, expectedAccessRevision: 7,
    kind: 'DOCUMENT', title: 'Documento richiesto', details: 'Esaminare la richiesta interna.' };
  const now = new Date('2026-10-23T14:00:00Z');
  assert.equal(admitsAdminRequestSubmission({ kind: 'COMMERCIAL_OWNER', current }, command, now), true);
  for (const delta of [{ userId: 'sales-b' }, { role: 'admin' }, { recipientEpoch: 4 },
    { selectiveCeilingAllows: false }, { sessionLive: false }, { registryCurrent: false }]) {
    assert.equal(admitsAdminRequestSubmission({ kind: 'COMMERCIAL_OWNER', current: { ...current, ...delta } }, command, now), false);
  }
});
