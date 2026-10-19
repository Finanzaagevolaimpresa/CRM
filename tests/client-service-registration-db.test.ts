import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { registrationFixture } from './service-registration/fixture';
import { cleanupPurchasedFixtures } from './purchased-service-fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { previewServiceRegistration, confirmServiceRegistration, serviceRegistrationSetup, readServiceRegistrationReceipt } from '../src/lib/client-service-registration';
import { previewPurchasedServiceHandoff, handoffPurchasedService } from '../src/lib/purchased-service-handoff';
import { withSerializableTransaction } from '../src/lib/serializable';
import type { ServiceRegistrationCommand } from '../src/lib/client-service-registration-contract';
import { syntheticAuthority, syntheticSession } from './selective-sharing/fixtures';
import { grantClient, clientProof } from './selective-clients/fixtures';
import { revokeClientSharing } from '../src/lib/selective-client-access';
import { confirmSelectiveAccess, previewSelectiveAccess } from '../src/lib/selective-project-access';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
type Fixture = Awaited<ReturnType<typeof registrationFixture>>;
const fixtures: Fixture[] = [];
let admitted = false;
let authority: Awaited<ReturnType<typeof syntheticAuthority>>;
before(async () => { if (enabled) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); admitted = true; process.env.INTERNAL_SESSION_MODE = 'registry';
  authority = await syntheticAuthority(db);
  await db.selectiveClientAuthority.create({ data: { userId: authority.user.id, enabled: true } });
} });
after(async () => {
  if (admitted) {
    const clients = fixtures.map(f => f.client.id), users = fixtures.flatMap(f => [f.admin.id, f.tech.id, f.other.id]);
    await db.auditLog.deleteMany({ where: { event: 'client_service_registration_v1', actorId: { in: users } } });
    await db.selectiveClientGrant.deleteMany({ where: { clientId: { in: clients } } });
    await db.selectiveProjectGrant.deleteMany({ where: { recipientId: { in: users } } });
    await db.project.deleteMany({ where: { clientId: { in: clients } } });
    await cleanupPurchasedFixtures(db, fixtures);
  }
  await db.$disconnect();
});
async function fixture() { const f = await registrationFixture(db); fixtures.push(f); return f; }
async function save(f: Fixture, input: ServiceRegistrationCommand = f.command) {
  const preview = await previewServiceRegistration(db, f.session, input);
  return confirmServiceRegistration(db, f.session, input, preview.digest);
}
const options = { skip: !enabled };
test('empty dossier registration preserves contract, payment and documents; handoff is a separate explicit operation', options, async () => {
  const f = await fixture(), contract = await db.contract.findUnique({ where: { id: f.contract.id } }), payment = await db.payment.findUnique({ where: { id: f.payment.id } });
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 0);
  const setup = await serviceRegistrationSetup(db, f.session, f.client.id);
  assert.ok(setup.contracts.some(c => c.id === f.contract.id));
  const result = await save(f), row = await db.clientService.findUniqueOrThrow({ where: { id: result.serviceId } });
  assert.equal(row.status, 'richiesto'); assert.equal(row.paymentStatus, 'parziale'); assert.equal(row.assignedToId, null);
  assert.equal(await db.technicalPractice.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.task.count({ where: { clientId: f.client.id } }), 0);
  assert.deepEqual(await db.contract.findUnique({ where: { id: f.contract.id } }), contract);
  assert.deepEqual(await db.payment.findUnique({ where: { id: f.payment.id } }), payment);
  const handoff = await previewPurchasedServiceHandoff(db, row.id);
  const receipt = await withSerializableTransaction(db, tx => handoffPurchasedService(tx, f.admin, { ...f.input, serviceId: row.id, expectedHash: handoff.expectedHash }, true));
  assert.equal(receipt.receipt.clientServiceId, row.id);
});
test('registration without payment remains unassigned; later linking reuses the same service and preserves its purchase', options, async () => {
  const f = await fixture(); f.command.paymentId = null;
  const result = await save(f), before = await db.clientService.findUniqueOrThrow({ where: { id: result.serviceId } });
  assert.equal(before.paymentStatus, 'da_incassare');
  await assert.rejects(previewPurchasedServiceHandoff(db, result.serviceId));
  const input = { operation: 'LINK_PAYMENT' as const, commandId: randomUUID(), clientId: f.client.id, serviceId: result.serviceId, paymentId: f.payment.id };
  assert.equal((await save(f, input)).serviceId, result.serviceId);
  const after = await db.clientService.findUniqueOrThrow({ where: { id: result.serviceId } });
  assert.equal(after.contractId, before.contractId); assert.deepEqual(after.purchasedAt, before.purchasedAt); assert.equal(after.assignedToId, null);
  await previewPurchasedServiceHandoff(db, result.serviceId);
});
test('same request, double click and lost response create one service and one minimal receipt', options, async () => {
  const f = await fixture(), p = await previewServiceRegistration(db, f.session, f.command);
  const attempts = await Promise.allSettled([1, 2].map(() => confirmServiceRegistration(db, f.session, f.command, p.digest)));
  assert.ok(attempts.some(r => r.status === 'fulfilled'));
  const result = await confirmServiceRegistration(db, f.session, f.command, p.digest);
  assert.deepEqual(await readServiceRegistrationReceipt(db, f.session, f.client.id, f.command.commandId), result);
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 1);
  const rows = await db.auditLog.findMany({ where: { event: 'client_service_registration_v1', entityId: result.serviceId } });
  assert.equal(rows.length, 1);
  const receipt = JSON.stringify(rows[0].after);
  for (const secret of [f.client.displayName, f.contract.contractNumber, f.catalog.name, f.admin.email]) assert.equal(receipt.includes(secret), false);
  assert.deepEqual(Object.keys(rows[0].after as object).sort(), ['type', 'action', 'sourceHash', 'sessionHash', 'serviceId', 'clientId', 'beforeHash', 'afterHash'].sort());
});
test('two tabs with distinct command IDs cannot register the same contract service twice', options, async () => {
  const f = await fixture(), other = { ...f.command, commandId: randomUUID() };
  const [a, b] = await Promise.all([previewServiceRegistration(db, f.session, f.command), previewServiceRegistration(db, f.session, other)]);
  const results = await Promise.allSettled([confirmServiceRegistration(db, f.session, f.command, a.digest), confirmServiceRegistration(db, f.session, other, b.digest)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 1);
});
test('audit failure rolls back service and client epoch together', options, async () => {
  const f = await fixture(), p = await previewServiceRegistration(db, f.session, f.command), before = await db.client.findUnique({ where: { id: f.client.id } });
  const broken = db.$extends({ query: { auditLog: { create() { throw new Error('SYNTHETIC_AUDIT_FAILURE'); } } } }) as unknown as PrismaClient;
  await assert.rejects(confirmServiceRegistration(broken, f.session, f.command, p.digest), /SYNTHETIC_AUDIT_FAILURE/);
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 0);
  assert.deepEqual(await db.client.findUnique({ where: { id: f.client.id } }), before);
});
test('reconciliation during a committing request never reports false absence', options, async () => {
  const f = await fixture(), p = await previewServiceRegistration(db, f.session, f.command);
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const paused = db.$extends({ query: { auditLog: { async create({ args, query }) { entered(); await hold; return query(args); } } } }) as unknown as PrismaClient;
  const write = confirmServiceRegistration(paused, f.session, f.command, p.digest);
  await reached;
  const read = readServiceRegistrationReceipt(db, f.session, f.client.id, f.command.commandId).then(result => ({ result }), () => ({ retry: true }));
  await new Promise(resolve => setTimeout(resolve, 100)); release();
  await write; const outcome = await read;
  assert.ok('retry' in outcome || outcome.result !== null);
  assert.ok(await readServiceRegistrationReceipt(db, f.session, f.client.id, f.command.commandId));
});
const staleCases: Array<[string, (f: Fixture) => Promise<unknown>]> = [
  ['client', f => db.client.update({ where: { id: f.client.id }, data: { displayName: 'Changed synthetic client' } })],
  ['catalog', f => db.serviceCatalog.update({ where: { id: f.catalog.id }, data: { active: false } })],
  ['contract', f => db.contract.update({ where: { id: f.contract.id }, data: { serviceDescription: 'Changed scope' } })],
  ['payment', f => db.payment.update({ where: { id: f.payment.id }, data: { status: 'da_incassare' } })],
  ['client trash', f => db.client.update({ where: { id: f.client.id }, data: { deletedAt: new Date() } })],
  ['client suspended', f => db.client.update({ where: { id: f.client.id }, data: { status: 'sospeso' } })],
  ['session revoked', f => db.internalSession.update({ where: { id: f.admin.sessionId }, data: { revokedAt: new Date() } })],
  ['session expired', f => db.internalSession.update({ where: { id: f.admin.sessionId }, data: { createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) } })],
  ['role revoked', f => db.user.update({ where: { id: f.admin.id }, data: { role: 'commerciale' } })],
  ['explicit permission denial', f => db.userPermissionOverride.create({ data: { userId: f.admin.id, permission: 'service.write', allowed: false } })],
];
for (const [name, mutate] of staleCases) test(`open preview fails closed after ${name}`, options, async () => {
  const f = await fixture(), p = await previewServiceRegistration(db, f.session, f.command);
  await mutate(f); await assert.rejects(confirmServiceRegistration(db, f.session, f.command, p.digest));
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 0);
});
test('foreign contract/payment, future purchase and forged financial fields are rejected', options, async () => {
  const f = await fixture(), other = await fixture();
  for (const input of [{ ...f.command, contractId: other.contract.id }, { ...f.command, paymentId: other.payment.id },
    { ...f.command, purchasedOn: '2999-01-01' }, { ...f.command, paymentStatus: 'incassato' }])
    await assert.rejects(previewServiceRegistration(db, f.session, input));
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 0);
});
test('signed contract project is preserved and archiving after preview blocks registration', options, async () => {
  const f = await fixture(), project = await db.project.create({ data: { clientId: f.client.id, title: 'Synthetic project' } });
  await db.contract.update({ where: { id: f.contract.id }, data: { projectId: project.id } });
  const p = await previewServiceRegistration(db, f.session, f.command);
  await db.project.update({ where: { id: project.id }, data: { status: 'archiviato' } });
  await assert.rejects(confirmServiceRegistration(db, f.session, f.command, p.digest));
  assert.equal((await serviceRegistrationSetup(db, f.session, f.client.id)).contracts.length, 0);
});
test('completed command cannot be reused with changed input or viewed by another session', options, async () => {
  const f = await fixture(), p = await previewServiceRegistration(db, f.session, f.command); await save(f);
  await assert.rejects(confirmServiceRegistration(db, f.session, { ...f.command, paymentId: null }, p.digest));
  await assert.rejects(readServiceRegistrationReceipt(db, { ...f.session, userId: f.tech.id, sessionId: f.tech.sessionId }, f.client.id, f.command.commandId));
  const renewed = await syntheticSession(db, f.admin);
  assert.ok(await readServiceRegistrationReceipt(db, renewed.session, f.client.id, f.command.commandId));
  await assert.rejects(confirmServiceRegistration(db, renewed.session, f.command, p.digest));
});
test('linking cannot overwrite a payment or a service already in progress', options, async () => {
  const f = await fixture(); f.command.paymentId = null; const result = await save(f);
  const input = { operation: 'LINK_PAYMENT' as const, commandId: randomUUID(), clientId: f.client.id, serviceId: result.serviceId, paymentId: f.payment.id };
  const p = await previewServiceRegistration(db, f.session, input);
  await db.clientService.update({ where: { id: result.serviceId }, data: { operationalStatus: 'in_valutazione' } });
  await assert.rejects(confirmServiceRegistration(db, f.session, input, p.digest));
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: result.serviceId } })).paymentId, null);
});
for (const revoked of [false, true]) test(`selective client perimeter blocks Admin registration, revoked=${revoked}`, options, async () => {
  // Retained grant history stays in the ephemeral database until its disposal.
  const f = await registrationFixture(db), p = await previewServiceRegistration(db, f.session, f.command);
  const { receipt } = await grantClient(db, authority, { clientId: f.client.id, recipientId: f.admin.id,
    revision: 0, commandId: randomUUID(), fields: ['displayName'], expiresAt: null });
  if (revoked) await revokeClientSharing(db, authority.session, { grantId: receipt.grantId, revision: 1, commandId: randomUUID() }, clientProof(authority));
  await assert.rejects(serviceRegistrationSetup(db, f.session, f.client.id));
  await assert.rejects(confirmServiceRegistration(db, f.session, f.command, p.digest));
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 0);
});
test('restricted contract through a sibling project cannot be selected from a general client', options, async () => {
  const f = await registrationFixture(db), project = await db.project.create({ data: { clientId: f.client.id, title: 'Restricted synthetic' } });
  await db.clientService.create({ data: { clientId: f.client.id, serviceCatalogId: f.catalog.id, projectId: project.id, contractId: f.contract.id } });
  const preview = await previewSelectiveAccess(db, authority.session, { projectId: project.id, recipientId: f.admin.id,
    revision: 0, fields: ['title'], documents: [], expiresAt: null });
  await confirmSelectiveAccess(db, authority.session, preview.token, true);
  assert.equal((await serviceRegistrationSetup(db, f.session, f.client.id)).contracts.length, 0);
  await assert.rejects(previewServiceRegistration(db, f.session, f.command));
});
