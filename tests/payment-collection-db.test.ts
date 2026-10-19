import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Prisma, PrismaClient } from '@prisma/client';
import { collectionFixture, collectionKey } from './payment-collection/fixture';
import { cleanupPurchasedFixtures } from './purchased-service-fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { previewPaymentCollection, confirmPaymentCollection, paymentCollectionSetup, readPaymentCollectionReceipt } from '../src/lib/payment-collection';
import { previewServiceRegistration, confirmServiceRegistration } from '../src/lib/client-service-registration';
import { previewPurchasedServiceHandoff, handoffPurchasedService } from '../src/lib/purchased-service-handoff';
import { withSerializableTransaction, SerializableConflictError } from '../src/lib/serializable';
import { localPathFromStoragePath } from '../src/lib/storage';
import { clientProof, grantClient } from './selective-clients/fixtures';
import { syntheticPerson } from './selective-sharing/fixtures';
import { previewSelectiveAccess, confirmSelectiveAccess } from '../src/lib/selective-project-access';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1', options = { skip: !enabled };
type Fixture = Awaited<ReturnType<typeof collectionFixture>>;
const fixtures: Fixture[] = [];
let admitted = false, authority: Awaited<ReturnType<typeof syntheticPerson>>;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); admitted = true;
  await collectionKey(db); authority = await syntheticPerson(db, 'Collection scope test authority');
  await db.selectiveClientAuthority.create({ data: { userId: authority.user.id, enabled: true } });
  await db.selectiveAccessAuthority.create({ data: { userId: authority.user.id, enabled: true } });
});
after(async () => {
  if (admitted) {
    const clients = fixtures.map(f => f.client.id), users = fixtures.flatMap(f => [f.admin.id, f.tech.id, f.other.id]);
    await db.auditLog.deleteMany({ where: { event: { in: ['payment_collection_v1', 'client_service_registration_v1'] }, actorId: { in: users } } });
    await db.selectiveClientGrant.deleteMany({ where: { clientId: { in: clients } } });
    await db.selectiveProjectGrant.deleteMany({ where: { recipientId: { in: users } } });
    await db.project.deleteMany({ where: { clientId: { in: clients } } });
    await cleanupPurchasedFixtures(db, fixtures);
  }
  await db.$disconnect();
});
async function fixture() { const f = await collectionFixture(db); fixtures.push(f); return f; }
async function preview(f: Fixture) { return previewPaymentCollection(db, f.session, f.command); }
async function save(f: Fixture) { return confirmPaymentCollection(db, f.session, f.command, (await preview(f)).digest, f.proof); }
async function unchanged(f: Fixture) {
  const row = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  assert.equal(row.status, 'da_incassare'); assert.equal(row.collectedAt, null); assert.equal(row.accountingDocumentId, null);
  assert.equal(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } }), 0);
}
function intercepted(transform: (tx: Prisma.TransactionClient) => Prisma.TransactionClient) {
  return { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, config: object) =>
    db.$transaction(tx => fn(transform(tx)), config) } as unknown as PrismaClient;
}
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('preview is read-only and limits choices to current separate verified evidence', options, async () => {
  const f = await fixture(), before = await db.payment.findUnique({ where: { id: f.payment.id } });
  const setup = await paymentCollectionSetup(db, f.session, f.payment.id), p = await preview(f);
  assert.equal(setup.reconciliationOnly, false); assert.ok(setup.documents.some(d => d.id === f.command.documentVersionId));
  assert.ok(!setup.documents.some(d => d.id === f.documents[0].version.id));
  assert.equal(p.amount, '61.00'); assert.equal(p.documentVersion, 1); assert.match(p.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await db.payment.findUnique({ where: { id: f.payment.id } }), before); await unchanged(f);
});
test('collection changes only the existing payment with a real minimized atomic N04 receipt', options, async () => {
  const f = await fixture(), contract = await db.contract.findUnique({ where: { id: f.contract.id } });
  const docs = await db.document.findMany({ where: { clientId: f.client.id }, orderBy: { id: 'asc' } });
  await save(f);
  const row = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  assert.equal(row.status, 'incassato'); assert.equal(row.collectedAt?.toISOString(), f.command.collectedAt);
  assert.equal(row.accountingDocumentId, f.documents[1].id); assert.equal(row.totalAmount.toFixed(2), '61.00');
  assert.deepEqual(await db.contract.findUnique({ where: { id: f.contract.id } }), contract);
  assert.deepEqual(await db.document.findMany({ where: { clientId: f.client.id }, orderBy: { id: 'asc' } }), docs);
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.technicalPractice.count({ where: { clientId: f.client.id } }), 0);
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: 'payment_collection_' + f.command.commandId } });
  assert.deepEqual(Object.keys(audit.after as object).sort(), ['action','afterHash','beforeHash','clientId','documentVersionId','paymentId','sessionHash','sourceHash','type'].sort());
  for (const excluded of [f.admin.email, f.client.displayName, f.documents[1].title, f.documents[1].storagePath]) assert.ok(!JSON.stringify(audit.after).includes(excluded));
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: f.client.id } })).recordUpdateEpoch, f.client.recordUpdateEpoch + 1);
});
test('same command is idempotent while a changed replay is rejected', options, async () => {
  const f = await fixture(), p = await preview(f), first = await confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof);
  assert.deepEqual(await confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof), first);
  await assert.rejects(confirmPaymentCollection(db, f.session, { ...f.command, collectedAt: new Date(1).toISOString() }, p.digest, f.proof));
  assert.equal(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } }), 1);
});
test('a step-up proof for the current session is mandatory', options, async () => {
  const f = await fixture(), p = await preview(f);
  await assert.rejects(confirmPaymentCollection(db, f.session, f.command, p.digest, undefined as never));
  await assert.rejects(confirmPaymentCollection(db, f.session, f.command, p.digest, { ...f.proof, sessionToken: authority.token }));
  await unchanged(f);
});
test('expired step-up and expired registry session are rejected after preview', options, async () => {
  const f = await fixture(), p = await preview(f);
  await assert.rejects(confirmPaymentCollection(db, f.session, f.command, p.digest, clientProof(f.person, Math.floor(Date.now() / 1000) - 3600)));
  await db.internalSession.update({ where: { id: f.session.sessionId! }, data: { expiresAt: new Date(1) } });
  await assert.rejects(confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof)); await unchanged(f);
});
test('session revocation and explicit permission denial close an open preview', options, async () => {
  const f = await fixture(), p = await preview(f);
  await db.userPermissionOverride.create({ data: { userId: f.admin.id, permission: 'payment.write', allowed: false } });
  await assert.rejects(confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof));
  await db.internalSession.update({ where: { id: f.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(readPaymentCollectionReceipt(db, f.session, f.client.id, f.payment.id, f.command.commandId)); await unchanged(f);
});
test('a forged role in the claimed session does not promote a technician', options, async () => {
  const f = await fixture(); await db.user.update({ where: { id: f.admin.id }, data: { role: 'consulente' } });
  await assert.rejects(preview(f)); await assert.rejects(paymentCollectionSetup(db, f.session, f.payment.id)); await unchanged(f);
});
test('Admin who receives only a selective client scope cannot declare financial collection', options, async () => {
  const f = await fixture();
  await grantClient(db, authority, { clientId: f.client.id, recipientId: f.admin.id, revision: 0, commandId: randomUUID(), fields: ['displayName'], expiresAt: null });
  await assert.rejects(preview(f)); await assert.rejects(paymentCollectionSetup(db, f.session, f.payment.id)); await unchanged(f);
});
test('indirect accounting evidence cannot cross a selective project perimeter', options, async () => {
  const f = await fixture();
  const project = await db.project.create({ data: { clientId: f.client.id, title: 'Collection selective project' } });
  await db.document.update({ where: { id: f.documents[1].id }, data: { projectId: project.id } });
  const input = { projectId: project.id, recipientId: f.admin.id, revision: 0, fields: ['title'], documents: [], expiresAt: null };
  const p = await previewSelectiveAccess(db, authority.session, input);
  await confirmSelectiveAccess(db, authority.session, p.token, true);
  await assert.rejects(preview(f));
  const setup = await paymentCollectionSetup(db, f.session, f.payment.id);
  assert.ok(!setup.documents.some(d => d.id === f.command.documentVersionId)); await unchanged(f);
});
test('client lifecycle change closes a prepared collection and receipt access', options, async () => {
  const f = await fixture(), p = await preview(f);
  await db.client.update({ where: { id: f.client.id }, data: { deletedAt: new Date() } });
  await assert.rejects(confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof));
  await assert.rejects(paymentCollectionSetup(db, f.session, f.payment.id)); await unchanged(f);
});
test('contract changes require a new preview and cannot be silently accepted', options, async () => {
  const f = await fixture(), p = await preview(f);
  await db.contract.update({ where: { id: f.contract.id }, data: { serviceDescription: 'Changed synthetic scope' } });
  await assert.rejects(confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof)); await unchanged(f);
});
test('a collected payment is not overwritten and remains available only for reconciliation', options, async () => {
  const f = await fixture(); await save(f);
  const before = await db.payment.findUnique({ where: { id: f.payment.id } });
  const setup = await paymentCollectionSetup(db, f.session, f.payment.id);
  assert.equal(setup.reconciliationOnly, true); assert.deepEqual(setup.documents, []);
  await assert.rejects(previewPaymentCollection(db, f.session, { ...f.command, commandId: randomUUID() }));
  assert.deepEqual(await db.payment.findUnique({ where: { id: f.payment.id } }), before);
});
test('a payment already linked to a service cannot be rewritten behind the handoff', options, async () => {
  const f = await fixture();
  await db.clientService.create({ data: { clientId: f.client.id, serviceCatalogId: f.catalog.id, contractId: f.contract.id, paymentId: f.payment.id } });
  await assert.rejects(preview(f)); await unchanged(f);
});
test('future date and invalid payment amount fail without any financial change', options, async () => {
  const f = await fixture();
  await assert.rejects(previewPaymentCollection(db, f.session, { ...f.command, collectedAt: new Date(Date.now() + 86400_000).toISOString() }));
  for (const amount of [0, -1, 123]) {
    await db.payment.update({ where: { id: f.payment.id }, data: { totalAmount: amount } });
    await assert.rejects(preview(f)); await unchanged(f);
  }
});
test('proof from another client and the signed contract itself are refused', options, async () => {
  const f = await fixture(), other = await fixture();
  for (const id of [other.documents[1].version.id, f.documents[0].version.id]) {
    await assert.rejects(previewPaymentCollection(db, f.session, { ...f.command, documentVersionId: id }));
  }
  await unchanged(f);
});
test('an obsolete document version cannot commit after a new version appears', options, async () => {
  const f = await fixture(), p = await preview(f);
  await db.documentVersion.create({ data: { documentId: f.documents[1].id, version: 2, storagePath: f.documents[1].storagePath, checksum: f.documents[1].checksum } });
  await assert.rejects(confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof)); await unchanged(f);
});
test('private bytes are verified, not merely trusted from metadata', options, async () => {
  const f = await fixture(), p = await preview(f), path = localPathFromStoragePath(f.documents[1].storagePath), bytes = await readFile(path);
  try {
    await writeFile(path, Buffer.alloc(bytes.length, 88));
    await assert.rejects(confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof)); await unchanged(f);
  } finally { await writeFile(path, bytes); }
});
test('proof expiry, tombstone and verification revocation invalidate an open preview', options, async () => {
  const f = await fixture(), p = await preview(f);
  for (const data of [{ validUntil: new Date(1) }, { validUntil: null, deletedAt: new Date() }, { deletedAt: null, status: 'da_verificare' as const }]) {
    await db.document.update({ where: { id: f.documents[1].id }, data });
    await assert.rejects(confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof)); await unchanged(f);
  }
});
test('a changed date or proof never uses a previously approved preview', options, async () => {
  const f = await fixture(), p = await preview(f);
  await assert.rejects(confirmPaymentCollection(db, f.session, { ...f.command, collectedAt: new Date(1).toISOString() }, p.digest, f.proof));
  await assert.rejects(confirmPaymentCollection(db, f.session, { ...f.command, documentVersionId: f.documents[2].version.id }, p.digest, f.proof)); await unchanged(f);
});
test('simultaneous double confirmation yields one payment transition and one receipt', options, async () => {
  const f = await fixture(), p = await preview(f);
  const results = await Promise.allSettled([1, 2].map(() => confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof)));
  assert.ok(results.some(r => r.status === 'fulfilled'));
  for (const result of results) if (result.status === 'rejected') assert.ok(result.reason instanceof SerializableConflictError);
  assert.equal(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } }), 1);
  assert.deepEqual(await readPaymentCollectionReceipt(db, f.session, f.client.id, f.payment.id, f.command.commandId), { clientId: f.client.id, paymentId: f.payment.id });
});
test('audit storage failure rolls back both payment and client epoch', options, async () => {
  const f = await fixture(), p = await preview(f);
  const failing = intercepted(tx => new Proxy(tx, { get(target, property) {
    if (property === 'auditLog') return new Proxy(target.auditLog, { get(delegate, key) {
      if (key === 'create') return async () => { throw new Error('Synthetic audit persistence failure'); };
      return Reflect.get(delegate, key);
    } });
    return Reflect.get(target, property);
  } }));
  await assert.rejects(confirmPaymentCollection(failing, f.session, f.command, p.digest, f.proof), /Synthetic audit persistence failure/);
  await unchanged(f); assert.equal((await db.client.findUniqueOrThrow({ where: { id: f.client.id } })).recordUpdateEpoch, f.client.recordUpdateEpoch);
});
test('receipt lookup racing an unacknowledged commit never reports a false absence', options, async () => {
  const f = await fixture(), p = await preview(f), held = latch(), release = latch();
  const gated = intercepted(tx => new Proxy(tx, { get(target, property) {
    if (property === 'payment') return new Proxy(target.payment, { get(delegate, key) {
      if (key === 'update') return async (...args: Parameters<typeof target.payment.update>) => {
        const result = await target.payment.update(...args); held.release(); await release.promise; return result;
      };
      return Reflect.get(delegate, key);
    } });
    return Reflect.get(target, property);
  } }));
  const write = confirmPaymentCollection(gated, f.session, f.command, p.digest, f.proof); await held.promise;
  const lookup = readPaymentCollectionReceipt(db, f.session, f.client.id, f.payment.id, f.command.commandId);
  const handled = Promise.allSettled([write, lookup]);
  try {
    let waiting = false;
    for (let i = 0; i < 40; i++) {
      const rows = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%Client%' OR query LIKE '%User%')`;
      if (rows[0].count > 0n) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, 'receipt transaction must actually wait for an authorization or client lock');
  } finally { release.release(); }
  const results = await handled; assert.equal(results[0].status, 'fulfilled');
  const read = results[1];
  if (read.status === 'fulfilled') assert.equal(read.value?.paymentId, f.payment.id);
  else assert.ok(read.reason instanceof SerializableConflictError);
  assert.equal((await readPaymentCollectionReceipt(db, f.session, f.client.id, f.payment.id, f.command.commandId))?.paymentId, f.payment.id);
});
test('concurrent amount amendment cannot accept the old financial preview', options, async () => {
  const f = await fixture(), p = await preview(f), ready = latch(), release = latch();
  const edit = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${f.payment.id} FOR UPDATE`;
    await tx.payment.update({ where: { id: f.payment.id }, data: { totalAmount: 62 } }); ready.release(); await release.promise;
  });
  await ready.promise;
  const confirm = confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof);
  const handled = Promise.allSettled([edit, confirm]);
  await new Promise(resolve => setTimeout(resolve, 100)); release.release();
  const results = await handled; assert.equal(results[1].status, 'rejected'); await unchanged(f);
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).totalAmount.toFixed(2), '62.00');
});
test('receipt recovery remains tied to its actor and current authorization', options, async () => {
  const f = await fixture(); await save(f);
  await assert.rejects(readPaymentCollectionReceipt(db, authority.session, f.client.id, f.payment.id, f.command.commandId));
  await db.userPermissionOverride.create({ data: { userId: f.admin.id, permission: 'payment.read', allowed: false } });
  await assert.rejects(readPaymentCollectionReceipt(db, f.session, f.client.id, f.payment.id, f.command.commandId));
});
test('collection, later payment link and technical handoff are three explicit synthetic operations', options, async () => {
  const f = await fixture(), input = { ...f.registrationCommand, paymentId: null };
  const p = await previewServiceRegistration(db, f.session, input);
  const service = await confirmServiceRegistration(db, f.session, input, p.digest);
  await assert.rejects(previewPurchasedServiceHandoff(db, service.serviceId));
  await save(f);
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: service.serviceId } })).paymentId, null);
  const link = { ...f.registrationCommand, operation: 'LINK_PAYMENT' as const, serviceId: service.serviceId, commandId: randomUUID() };
  const linkPreview = await previewServiceRegistration(db, f.session, link);
  await confirmServiceRegistration(db, f.session, link, linkPreview.digest);
  assert.equal(await db.technicalPractice.count({ where: { clientId: f.client.id } }), 0);
  const handoff = await previewPurchasedServiceHandoff(db, service.serviceId);
  const result = await withSerializableTransaction(db, tx => handoffPurchasedService(tx, f.admin, { ...f.input, serviceId: service.serviceId, expectedHash: handoff.expectedHash }, true));
  assert.equal(result.receipt.clientServiceId, service.serviceId);
  assert.equal(await db.technicalPractice.count({ where: { clientId: f.client.id } }), 1);
  assert.equal(await db.payment.count({ where: { clientId: f.client.id } }), 1);
});
