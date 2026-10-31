import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { previewAdminOperationalLink, saveAdminOperationalLink, reconcileAdminOperationalLink, readAdminOperationalLink } from '../src/lib/admin-operational-links';
import type { LinkChoice } from '../src/lib/admin-operational-link-contract';
import { loadAdminRecord } from '../src/lib/admin-records';
const enabled = process.env.RUN_DB_TESTS === '1' && process.env.ADMIN_OPERATIONAL_LINK_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person;
before(async () => {
  if (!enabled) return; await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const existing = await db.selectiveAccessAuthority.findFirst();
  if (existing) { const user = await db.user.findUniqueOrThrow({ where: { id: existing.userId } }); admin = { user, ...await syntheticSession(db, user) }; }
  else admin = await syntheticAuthority(db);
});
after(async () => db.$disconnect());
function proof(person = admin, secondsAgo = 0) {
  return { key, sessionToken: person.token, stepUpToken: createPrivilegedStepUpToken({
    key, userId: person.user.id, role: person.user.role, sessionToken: person.token, nowSeconds: Math.floor(Date.now() / 1000) - secondsAgo,
  }) };
}
async function prepare(input: LinkChoice) {
  const preview = await previewAdminOperationalLink(db, admin.session, { model: input.model, id: input.id, values: input.values });
  return { ...input, commandId: randomUUID(), expectedVersion: preview.version, reason: 'Rettifica sintetica isolata', confirmed: true as const };
}
async function pair(label: string) {
  const lead = await db.lead.create({ data: { firstName: 'Lead', lastName: label, assignedToId: admin.user.id } });
  const client = await db.client.create({ data: { displayName: 'Cliente ' + label, type: 'societa', leadId: lead.id, salesOwnerId: admin.user.id } });
  await db.lead.update({ where: { id: lead.id }, data: { clientId: client.id } });
  return { lead, client };
}
async function serviceCase() {
  const client = await db.client.create({ data: { displayName: 'Cliente servizio sintetico', type: 'societa' } });
  const catalog = await db.serviceCatalog.create({ data: { code: randomUUID(), name: 'Catalogo sintetico', category: 'synthetic' } });
  const alternative = await db.serviceCatalog.create({ data: { code: randomUUID(), name: 'Altro catalogo sintetico', category: 'synthetic' } });
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: randomUUID(), serviceName: 'Contratto sintetico',
    serviceDescription: 'Solo dati di prova', taxableAmount: 100, vatAmount: 22, totalAmount: 122 } });
  const payment = await db.payment.create({ data: { contractId: contract.id, clientId: client.id, taxableAmount: 100, vatAmount: 22, totalAmount: 122 } });
  const service = await db.clientService.create({ data: { clientId: client.id, serviceCatalogId: catalog.id } });
  return { client, catalog, alternative, contract, payment, service };
}
test('reciprocal operational relinking explicitly detaches displaced references while preserving owners and history', options, async () => {
  const a = await pair('A'), b = await pair('B');
  const before = await db.lead.findUniqueOrThrow({ where: { id: a.lead.id } });
  const input = await prepare({ model: 'Lead', id: a.lead.id, values: { clientId: b.client.id } });
  const preview = await previewAdminOperationalLink(db, admin.session, { model: input.model, id: input.id, values: input.values });
  assert.equal(preview.changes.length, 4);
  await saveAdminOperationalLink(db, admin.session, input, proof());
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: a.lead.id } })).clientId, b.client.id);
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: b.lead.id } })).clientId, null);
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: a.client.id } })).leadId, null);
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: b.client.id } })).leadId, a.lead.id);
  const after = await db.lead.findUniqueOrThrow({ where: { id: a.lead.id } });
  assert.equal(after.status, before.status); assert.equal(after.assignedToId, before.assignedToId);
  assert.equal((await readAdminOperationalLink(db, admin.session, 'Lead', a.lead.id)).history[0].commandId, input.commandId);
  assert.equal(await db.auditLog.count({ where: { id: 'admin-record:' + input.commandId } }), 1);
  for (const [model, id] of [['Lead', a.lead.id], ['Client', b.client.id]]) {
    const record = await loadAdminRecord(db, admin.session, model, id);
    assert(record.relationships.some(link => link.href === '/admin/links/' + model + '/' + id));
  }
});
test('the client-side editor detaches and restores the principal link with a new revision', options, async () => {
  const a = await pair('Ripristino');
  const unlink = await prepare({ model: 'Client', id: a.client.id, values: { leadId: '' } });
  await saveAdminOperationalLink(db, admin.session, unlink, proof());
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: a.lead.id } })).clientId, null);
  const restore = await prepare({ model: 'Client', id: a.client.id, values: { leadId: a.lead.id } });
  await saveAdminOperationalLink(db, admin.session, restore, proof());
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: a.lead.id } })).clientId, a.client.id);
  assert.equal((await readAdminOperationalLink(db, admin.session, 'Client', a.client.id)).history.length, 2);
});
test('preview binds every affected row and rejects intervening changes without a partial unlink', options, async () => {
  const a = await pair('StaleA'), b = await pair('StaleB');
  const input = await prepare({ model: 'Lead', id: a.lead.id, values: { clientId: b.client.id } });
  await db.client.update({ where: { id: b.client.id }, data: { notes: 'Modifica concorrente sintetica' } });
  await assert.rejects(saveAdminOperationalLink(db, admin.session, input, proof()), /STALE/);
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: a.client.id } })).leadId, a.lead.id);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 0);
});
test('expiry, response recovery and closure use one persisted decision and reject a late command', options, async () => {
  const a = await pair('Ripresa'), input = await prepare({ model: 'Lead', id: a.lead.id, values: { clientId: '' } });
  await assert.rejects(saveAdminOperationalLink(db, admin.session, input, proof(admin, 1800)));
  await saveAdminOperationalLink(db, admin.session, input, proof());
  assert.equal((await saveAdminOperationalLink(db, admin.session, input, proof())).replayed, true);
  assert.equal((await reconcileAdminOperationalLink(db, admin.session, { model: 'Lead', id: a.lead.id, commandId: input.commandId, close: true })).status, 'RECORDED');
  const late = await prepare({ model: 'Lead', id: a.lead.id, values: { clientId: a.client.id } });
  assert.equal((await reconcileAdminOperationalLink(db, admin.session, { model: 'Lead', id: a.lead.id, commandId: late.commandId, close: true })).status, 'CLOSED');
  await assert.rejects(saveAdminOperationalLink(db, admin.session, late, proof()), /CLOSED/);
});
test('non Admin, missing permission, archived destinations and command substitution cannot change links', options, async () => {
  const a = await pair('Permessi'), b = await pair('Archivio'), reader = await syntheticPerson(db, 'Commerciale isolato', 'commerciale');
  const input = await prepare({ model: 'Lead', id: a.lead.id, values: { clientId: '' } });
  await assert.rejects(saveAdminOperationalLink(db, reader.session, input, proof(reader)));
  await db.client.update({ where: { id: b.client.id }, data: { deletedAt: new Date() } });
  await assert.rejects(prepare({ model: 'Lead', id: a.lead.id, values: { clientId: b.client.id } }));
  await saveAdminOperationalLink(db, admin.session, input, proof());
  const other = await syntheticPerson(db, 'Altro Admin');
  await assert.rejects(reconcileAdminOperationalLink(db, other.session, { model: 'Lead', id: a.lead.id, commandId: input.commandId, close: false }), /DENIED/);
  await assert.rejects(saveAdminOperationalLink(db, admin.session, { ...input, reason: 'Contenuto diverso' }, proof()), /STALE/);
});
test('service bindings change real catalogue contract and payment references without changing financial evidence', options, async () => {
  const c = await serviceCase(), beforePayment = await db.payment.findUniqueOrThrow({ where: { id: c.payment.id } });
  const input = await prepare({ model: 'ClientService', id: c.service.id, values: { serviceCatalogId: c.alternative.id, contractId: c.contract.id, paymentId: c.payment.id } });
  await saveAdminOperationalLink(db, admin.session, input, proof());
  const reopened = await readAdminOperationalLink(db, admin.session, 'ClientService', c.service.id);
  assert.deepEqual(reopened.values, input.values);
  const record = await loadAdminRecord(db, admin.session, 'ClientService', c.service.id);
  assert(record.relationships.some(link => link.href === '/admin/links/ClientService/' + c.service.id));
  assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: c.payment.id } }), beforePayment);
  const clear = await prepare({ model: 'ClientService', id: c.service.id, values: { serviceCatalogId: c.catalog.id, contractId: '', paymentId: '' } });
  await saveAdminOperationalLink(db, admin.session, clear, proof());
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: c.service.id } })).paymentId, null);
});
test('a service cannot attach another client contract or a payment from another contract', options, async () => {
  const a = await serviceCase(), b = await serviceCase();
  await assert.rejects(prepare({ model: 'ClientService', id: a.service.id, values: { serviceCatalogId: a.catalog.id, contractId: b.contract.id, paymentId: '' } }), /CONTEXT/);
  await assert.rejects(prepare({ model: 'ClientService', id: a.service.id, values: { serviceCatalogId: a.catalog.id, contractId: a.contract.id, paymentId: b.payment.id } }), /PAYMENT/);
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: a.service.id } })).contractId, null);
});
test('an audit failure rolls back every affected reciprocal reference', options, async () => {
  const a = await pair('AuditA'), b = await pair('AuditB');
  const input = await prepare({ model: 'Lead', id: a.lead.id, values: { clientId: b.client.id } });
  await db.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: admin.user.id, event: 'synthetic_collision', entityType: 'Synthetic', entityId: input.id } });
  await assert.rejects(saveAdminOperationalLink(db, admin.session, input, proof()));
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: a.client.id } })).leadId, a.lead.id);
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: b.client.id } })).leadId, b.lead.id);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 0);
});
test('competing exact previews produce at most one committed reciprocal change', options, async () => {
  const a = await pair('ConcurrentA'), b = await pair('ConcurrentB'), c = await pair('ConcurrentC');
  const first = await prepare({ model: 'Lead', id: a.lead.id, values: { clientId: b.client.id } });
  const second = await prepare({ model: 'Lead', id: a.lead.id, values: { clientId: c.client.id } });
  const result = await Promise.allSettled([saveAdminOperationalLink(db, admin.session, first, proof()), saveAdminOperationalLink(db, admin.session, second, proof())]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
});
