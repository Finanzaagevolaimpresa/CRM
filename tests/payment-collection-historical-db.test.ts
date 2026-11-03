import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { collectionFixture, collectionKey } from './payment-collection/fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { clientProof } from './selective-clients/fixtures';
import { syntheticPerson } from './selective-sharing/fixtures';
import { historicalPaymentModel, type HistoricalPaymentCommand } from '../src/lib/payment-historical-attestation-contract';
import { confirmHistoricalPayment, previewHistoricalPayment, readHistoricalPaymentReceipt, historicalPaymentSetup, historicalPaymentSummaries } from '../src/lib/payment-historical-attestation';
import { confirmPaymentCollection, previewPaymentCollection } from '../src/lib/payment-collection';
import { SerializableConflictError } from '../src/lib/serializable';
const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1', options = { skip: !enabled };
before(async () => { if (enabled) { await assertAiOrchestratorEphemeralDatabaseIdentity(db); await collectionKey(db); } });
after(() => db.$disconnect());
async function fixture() {
  const f = await collectionFixture(db);
  await db.contract.update({ where: { id: f.contract.id }, data: { status: 'da_preparare', signedAt: null, signedDocumentId: null } });
  await db.payment.update({ where: { id: f.payment.id }, data: { method: 'precedente valore amministrativo' } });
  const historical: HistoricalPaymentCommand = { commandId: randomUUID(), clientId: f.client.id, paymentId: f.payment.id,
    expectedAmount: '61.00', effectiveDay: '2026-01-15', attestedOn: '2026-01-20', declarant: 'Titolare sintetico',
    provenance: 'Dichiarazione sintetica nel canale autorizzato', reason: 'Riconciliazione storica sintetica',
    expiresAt: new Date(Date.now() + 180_000).toISOString(), confirmed: true };
  return { ...f, historical };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const preview = (f: Fixture) => previewHistoricalPayment(db, f.session, f.historical);
async function save(f: Fixture) { return confirmHistoricalPayment(db, f.session, f.historical, (await preview(f)).digest, f.proof); }
async function unchanged(f: Fixture) {
  const p = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  assert.equal(p.status, 'da_incassare'); assert.equal(p.collectedAt, null); assert.equal(p.accountingDocumentId, null);
  assert.equal(await db.adminRecordRevision.count({ where: { model: historicalPaymentModel, recordId: p.id } }), 0);
}
function intercepted(transform: (tx: Prisma.TransactionClient) => Prisma.TransactionClient) {
  return { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, config: object) =>
    db.$transaction(tx => fn(transform(tx)), config) } as unknown as PrismaClient;
}
test('day-only Admin attestation preview is read-only despite an unsigned contract and absent bank proof', options, async () => {
  const f = await fixture(), before = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  const setup = await historicalPaymentSetup(db, f.session, f.payment.id), p = await preview(f);
  assert.equal(setup.eligible, true); assert.equal(p.amount, '61.00'); assert.equal(p.effectiveDay, '2026-01-15');
  assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } }), before); await unchanged(f);
});
test('attestation atomically updates only the existing payment and retains source, actor and before/after', options, async () => {
  const f = await fixture(), before = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  const contract = await db.contract.findUnique({ where: { id: f.contract.id } });
  const client = await db.client.findUnique({ where: { id: f.client.id } });
  const docs = await db.document.findMany({ where: { clientId: f.client.id }, orderBy: { id: 'asc' } });
  const result = await save(f), p = await db.payment.findUniqueOrThrow({ where: { id: before.id } });
  assert.equal(p.status, 'incassato'); assert.equal(p.totalAmount.toFixed(2), '61.00');
  assert.equal(p.collectedAt?.toISOString(), '2026-01-15T00:00:00.000Z'); assert.equal(p.method, null); assert.equal(p.accountingDocumentId, null);
  assert.equal(result.source.effectiveTime, null); assert.equal(result.source.declaredMethod, null); assert.equal(result.source.bankEvidenceVerified, false);
  assert.equal(result.source.precision, 'DAY'); assert.equal(result.source.declarant, f.historical.declarant);
  const journal = await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId: f.historical.commandId } });
  assert.equal(journal.actorId, f.admin.id); assert.equal(journal.sessionId, f.session.sessionId); assert.equal(journal.reason, f.historical.reason);
  assert.deepEqual(journal.before, JSON.parse(JSON.stringify(before)));
  assert.equal((journal.after as { historicalAttestation: { provenance: string } }).historicalAttestation.provenance, f.historical.provenance);
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: 'admin-record:' + f.historical.commandId } });
  assert.equal(audit.actorId, f.admin.id); assert.equal(audit.entityId, p.id); assert.equal(audit.event, 'admin_record_changed');
  assert.deepEqual(await db.contract.findUnique({ where: { id: f.contract.id } }), contract);
  assert.deepEqual(await db.client.findUnique({ where: { id: f.client.id } }), client);
  assert.deepEqual(await db.document.findMany({ where: { clientId: f.client.id }, orderBy: { id: 'asc' } }), docs);
  assert.equal(await db.payment.count({ where: { clientId: f.client.id } }), 1);
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.technicalPractice.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.auditLog.count({ where: { event: 'payment_collection_v1', entityId: p.id } }), 0);
});
test('a collection predating the recorded signature does not change signature or derive service activation', options, async () => {
  const f = await fixture();
  const contract = await db.contract.update({ where: { id: f.contract.id }, data: { status: 'firmato', signedAt: new Date('2026-01-18T12:00:00Z') } });
  await save(f); assert.deepEqual(await db.contract.findUnique({ where: { id: contract.id } }), contract);
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 0);
});
test('same command replays once and a changed payload or different command cannot duplicate collection', options, async () => {
  const f = await fixture(), p = await preview(f), first = await confirmHistoricalPayment(db, f.session, f.historical, p.digest, f.proof);
  assert.deepEqual(await confirmHistoricalPayment(db, f.session, f.historical, p.digest, f.proof), first);
  await assert.rejects(confirmHistoricalPayment(db, f.session, { ...f.historical, effectiveDay: '2026-01-14' }, p.digest, f.proof));
  await assert.rejects(previewHistoricalPayment(db, f.session, { ...f.historical, commandId: randomUUID() }));
  assert.equal(await db.adminRecordRevision.count({ where: { model: historicalPaymentModel, recordId: f.payment.id } }), 1);
});
test('historical collection does not forge an ordinary collection receipt or document verification', options, async () => {
  const f = await fixture(); await save(f);
  await assert.rejects(previewPaymentCollection(db, f.session, f.command));
  assert.equal(await db.auditLog.count({ where: { event: 'payment_collection_v1', entityId: f.payment.id } }), 0);
  assert.equal((await historicalPaymentSetup(db, f.session, f.payment.id)).result?.source.bankEvidenceVerified, false);
});
test('existing ordinary collection and source evidence prevent a historical rewrite', options, async () => {
  const f = await collectionFixture(db), p = await previewPaymentCollection(db, f.session, f.command);
  await confirmPaymentCollection(db, f.session, f.command, p.digest, f.proof);
  const historical = (await fixture()).historical;
  await assert.rejects(previewHistoricalPayment(db, f.session, { ...historical, clientId: f.client.id, paymentId: f.payment.id }));
  assert.equal((await historicalPaymentSetup(db, f.session, f.payment.id)).eligible, false);
});
test('Admin proof is required and expired or foreign session proof cannot change data', options, async () => {
  const f = await fixture(), p = await preview(f), other = await syntheticPerson(db, 'Altro Admin sintetico');
  for (const proof of [undefined, clientProof(f.person, Math.floor(Date.now()/1000)-3600), { ...f.proof, sessionToken: other.token }]) {
    await assert.rejects(confirmHistoricalPayment(db, f.session, f.historical, p.digest, proof as never));
  }
  await unchanged(f);
});
test('registry revocation and current permission revocation reject a prepared write', options, async () => {
  const f = await fixture(), p = await preview(f);
  await db.userPermissionOverride.create({ data: { userId: f.admin.id, permission: 'payment.write', allowed: false } });
  await assert.rejects(confirmHistoricalPayment(db, f.session, f.historical, p.digest, f.proof)); await unchanged(f);
  const g = await fixture(), q = await preview(g);
  await db.internalSession.update({ where: { id: g.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(confirmHistoricalPayment(db, g.session, g.historical, q.digest, g.proof)); await unchanged(g);
});
test('all non-Admin profiles and forged cached Admin claims deny setup, preview, save and receipts', options, async () => {
  const f = await fixture(), p = await preview(f); await save(f);
  for (const role of ['consulente','commerciale','backoffice'] as const) {
    const other = await syntheticPerson(db, 'Ruolo sintetico', role);
    await db.userPermissionOverride.createMany({ data: ['payment.read','payment.write','client.read','contract.read'].map(permission => ({ userId: other.user.id, permission, allowed: true })) });
    for (const session of [other.session, { ...other.session, role: 'admin' as const }]) {
      await assert.rejects(historicalPaymentSetup(db, session, f.payment.id));
      await assert.rejects(previewHistoricalPayment(db, session, f.historical));
      await assert.rejects(confirmHistoricalPayment(db, session, f.historical, p.digest, clientProof(other)));
      await assert.rejects(readHistoricalPaymentReceipt(db, session, f.client.id, f.payment.id, f.historical.commandId));
    }
    assert.equal((await historicalPaymentSummaries(db, other.session, [await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })])).size, 0);
  }
});
test('mismatched client, changed amount and changed context reject stale or substituted requests', options, async () => {
  const f = await fixture(), p = await preview(f), g = await fixture();
  await assert.rejects(previewHistoricalPayment(db, f.session, { ...f.historical, clientId: g.client.id }));
  await assert.rejects(previewHistoricalPayment(db, f.session, { ...f.historical, expectedAmount: '62.00' }));
  await db.payment.update({ where: { id: f.payment.id }, data: { notes: 'Cambio sintetico concorrente' } });
  await assert.rejects(confirmHistoricalPayment(db, f.session, f.historical, p.digest, f.proof)); await unchanged(f);
});
test('future, impossible and after-attestation collection days are rejected', options, async () => {
  const f = await fixture();
  for (const delta of [{ effectiveDay: '2999-01-01' }, { attestedOn: '2999-01-01' }, { effectiveDay: '2026-02-30' }, { effectiveDay: '2026-01-21' }]) {
    await assert.rejects(previewHistoricalPayment(db, f.session, { ...f.historical, ...delta }));
  }
  await unchanged(f);
});
test('expired preview cannot be revived by the longer Admin step-up window', options, async () => {
  const f = await fixture(); f.historical.expiresAt = new Date(Date.now()+5000).toISOString();
  const p = await preview(f);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(f.historical.expiresAt)-Date.now()+50)));
  await assert.rejects(confirmHistoricalPayment(db, f.session, f.historical, p.digest, f.proof));
  await unchanged(f);
});
test('database audit failure rolls back payment and typed receipt together', options, async () => {
  const f = await fixture(), p = await preview(f);
  const failing = intercepted(tx => new Proxy(tx, { get(target, name) {
    if (name === 'auditLog') return new Proxy(target.auditLog, { get(delegate, operation) {
      if (operation === 'create') return async () => { throw new Error('Synthetic historical audit failure'); };
      return Reflect.get(delegate, operation);
    } }); return Reflect.get(target, name);
  } }));
  await assert.rejects(confirmHistoricalPayment(failing, f.session, f.historical, p.digest, f.proof), /Synthetic historical audit failure/);
  await unchanged(f);
});
test('concurrent commands settle to one payment transition and one immutable source', options, async () => {
  const f = await fixture(), p = await preview(f), input = { ...f.historical, commandId: randomUUID() };
  const q = await previewHistoricalPayment(db, f.session, input);
  const results = await Promise.allSettled([confirmHistoricalPayment(db, f.session, f.historical, p.digest, f.proof), confirmHistoricalPayment(db, f.session, input, q.digest, f.proof)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await db.adminRecordRevision.count({ where: { model: historicalPaymentModel, recordId: f.payment.id } }), 1);
});
test('persisted receipt remains readable on reopening and day-only projections do not turn midnight into a fact', options, async () => {
  const f = await fixture(), result = await save(f);
  assert.deepEqual(await readHistoricalPaymentReceipt(db, f.session, f.client.id, f.payment.id, f.historical.commandId), result);
  assert.deepEqual((await historicalPaymentSetup(db, f.session, f.payment.id)).result, result);
  const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  const source = (await historicalPaymentSummaries(db, f.session, [payment])).get(payment.id)!;
  assert.equal(source.effectiveDay, '2026-01-15'); assert.equal(source.precision, 'DAY'); assert.equal(source.effectiveTime, null);
});

test('receipt verification racing an unacknowledged historical commit never reports false absence', options, async () => {
  const latch = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
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
  const write = confirmHistoricalPayment(gated, f.session, f.historical, p.digest, f.proof); await held.promise;
  const lookup = readHistoricalPaymentReceipt(db, f.session, f.client.id, f.payment.id, f.historical.commandId);
  const handled = Promise.allSettled([write, lookup]);
  try {
    let waiting = false;
    for (let i = 0; i < 40; i++) {
      const rows = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%Client%' OR query LIKE '%User%')`;
      if (rows[0].count > 0n) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, 'receipt must wait for the in-flight transaction');
  } finally { release.release(); }
  const results = await handled; assert.equal(results[0].status, 'fulfilled');
  const read = results[1];
  if (read.status === 'fulfilled') assert.equal(read.value?.commandId, f.historical.commandId);
  else assert.ok(read.reason instanceof SerializableConflictError);
  assert.equal((await readHistoricalPaymentReceipt(db, f.session, f.client.id, f.payment.id, f.historical.commandId))?.commandId, f.historical.commandId);
});
test('the typed journal and associated audit cannot be rewritten or deleted', options, async () => {
  const f = await fixture(); await save(f);
  await assert.rejects(db.adminRecordRevision.update({ where: { commandId: f.historical.commandId }, data: { reason: 'alterazione sintetica vietata' } }));
  await assert.rejects(db.adminRecordRevision.delete({ where: { commandId: f.historical.commandId } }));
  await assert.rejects(db.auditLog.delete({ where: { id: 'admin-record:' + f.historical.commandId } }));
});
test('a linked service blocks historical correction rather than detaching it to admit the write', options, async () => {
  const f = await fixture();
  const service = await db.clientService.create({ data: { clientId: f.client.id, contractId: f.contract.id, paymentId: f.payment.id, serviceCatalogId: f.catalog.id } });
  await assert.rejects(preview(f)); assert.ok(await db.clientService.findUnique({ where: { id: service.id } })); await unchanged(f);
});
