import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { activitiesFixture } from './contract-activities/fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { previewContractActivities, confirmContractActivities, contractActivitiesSetup, readContractActivitiesReceipt } from '../src/lib/contract-activities';
import { SerializableConflictError } from '../src/lib/serializable';
import { collectionKey } from './payment-collection/fixture';
import { grantClient } from './selective-clients/fixtures';
import { syntheticPerson } from './selective-sharing/fixtures';
import { previewSelectiveAccess, confirmSelectiveAccess } from '../src/lib/selective-project-access';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1', options = { skip: !enabled };
type Fixture = Awaited<ReturnType<typeof activitiesFixture>>;
let authority: Awaited<ReturnType<typeof syntheticPerson>>;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); await collectionKey(db);
  authority = await syntheticPerson(db, 'Autorità sintetica per i dinieghi');
  await db.selectiveClientAuthority.create({ data: { userId: authority.user.id, enabled: true } });
  await db.selectiveAccessAuthority.create({ data: { userId: authority.user.id, enabled: true } });
});
after(() => db.$disconnect());
const fixture = () => activitiesFixture(db);
const preview = (f: Fixture) => previewContractActivities(db, f.session, f.command);
const save = async (f: Fixture) => confirmContractActivities(db, f.session, f.command, (await preview(f)).digest);
const event = 'contract_activities_completed_v1';
async function unchanged(f: Fixture) {
  assert.equal((await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).serviceDescription, null);
  assert.equal(await db.auditLog.count({ where: { entityId: f.contract.id, event } }), 0);
}
function intercepted(transform: (tx: Prisma.TransactionClient) => Prisma.TransactionClient) {
  return { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, config: object) =>
    db.$transaction(tx => fn(transform(tx)), config) } as unknown as PrismaClient;
}
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('setup and preview do not fill the contract or create an audit receipt', options, async () => {
  const f = await fixture(), p = await preview(f);
  assert.equal(p.activities, f.command.activities);
  assert.equal((await contractActivitiesSetup(db, f.session, f.contract.id)).reconciliationOnly, false);
  await unchanged(f);
});
test('completion changes only missing activities and effective audit hashes; signature declaration, payment and client are preserved', options, async () => {
  const f = await fixture(), declaration = await db.auditLog.findUniqueOrThrow({ where: { id: f.declared.declarationId } });
  await save(f);
  const row = await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  assert.deepEqual({ ...row, serviceDescription: null, updatedAt: f.contract.updatedAt }, f.contract);
  assert.equal(row.serviceDescription, f.command.activities);
  assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } }), f.payment);
  assert.deepEqual(await db.client.findUniqueOrThrow({ where: { id: f.client.id } }), f.client);
  assert.deepEqual(await db.auditLog.findUniqueOrThrow({ where: { id: f.declared.declarationId } }), declaration);
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: 'contract_activities_' + f.command.commandId } });
  const evidence = audit.after as Record<string, string>;
  assert.deepEqual(Object.keys(evidence).sort(), ['action', 'afterHash', 'beforeHash', 'clientId', 'sessionHash', 'sourceHash', 'type']);
  for (const key of ['afterHash', 'beforeHash', 'sessionHash', 'sourceHash']) assert.match(evidence[key], /^[a-f0-9]{64}$/);
  for (const privateValue of [f.command.activities, f.contract.notes!, f.person.user.email]) assert.ok(!JSON.stringify(audit).includes(privateValue));
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.technicalPractice.count({ where: { clientId: f.client.id } }), 0);
});
test('a historic signed contract with missing activities is completed without changing signature data', options, async () => {
  const f = await fixture();
  const signed = await db.contract.update({ where: { id: f.contract.id }, data: { status: 'firmato', signedAt: new Date('2020-01-01') } });
  await save(f);
  const row = await db.contract.findUniqueOrThrow({ where: { id: signed.id } });
  assert.deepEqual({ ...row, serviceDescription: null, updatedAt: signed.updatedAt }, signed);
});
test('exact replay reconciles once while a changed replay cannot replace activities', options, async () => {
  const f = await fixture(), p = await preview(f), result = await confirmContractActivities(db, f.session, f.command, p.digest);
  assert.deepEqual(await confirmContractActivities(db, f.session, f.command, p.digest), result);
  await assert.rejects(confirmContractActivities(db, f.session, { ...f.command, activities: 'Diverse' }, p.digest));
  assert.equal(await db.auditLog.count({ where: { entityId: f.contract.id, event } }), 1);
});
test('a forged Admin claim cannot promote the current non-Admin user', options, async () => {
  const f = await fixture(); await db.user.update({ where: { id: f.person.user.id }, data: { role: 'consulente' } });
  await assert.rejects(preview(f)); await assert.rejects(contractActivitiesSetup(db, f.session, f.contract.id)); await unchanged(f);
});
test('explicit permission revocation after preview prevents the write', options, async () => {
  const f = await fixture(), p = await preview(f);
  await db.userPermissionOverride.create({ data: { userId: f.person.user.id, permission: 'contract.write', allowed: false } });
  await assert.rejects(confirmContractActivities(db, f.session, f.command, p.digest)); await unchanged(f);
});
test('registry session revocation or expiration closes a prepared command', options, async () => {
  for (const state of ['revoked', 'expired']) {
    const f = await fixture(), p = await preview(f);
    const data = state === 'revoked'
      ? { revokedAt: new Date() }
      : { createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) };
    await db.internalSession.update({ where: { id: f.session.sessionId! }, data });
    await assert.rejects(confirmContractActivities(db, f.session, f.command, p.digest)); await unchanged(f);
  }
});
test('Admin recipient of selective client access cannot complete the contract', options, async () => {
  const f = await fixture();
  await grantClient(db, authority, { clientId: f.client.id, recipientId: f.person.user.id, revision: 0,
    commandId: randomUUID(), fields: ['displayName'], expiresAt: null });
  await assert.rejects(preview(f)); await assert.rejects(contractActivitiesSetup(db, f.session, f.contract.id)); await unchanged(f);
});
test('indirect selective project restriction is enforced even for a contract without its own project', options, async () => {
  const f = await fixture(), project = await db.project.create({ data: { clientId: f.client.id, title: 'Perimetro sintetico indiretto' } });
  const catalog = await db.serviceCatalog.findFirstOrThrow();
  await db.clientService.create({ data: { clientId: f.client.id, contractId: f.contract.id, serviceCatalogId: catalog.id, projectId: project.id } });
  const p = await previewSelectiveAccess(db, authority.session, { projectId: project.id, recipientId: f.person.user.id,
    revision: 0, fields: ['title'], documents: [], expiresAt: null });
  await confirmSelectiveAccess(db, authority.session, p.token, true);
  await assert.rejects(preview(f)); await assert.rejects(contractActivitiesSetup(db, f.session, f.contract.id)); await unchanged(f);
});
test('client tombstone closes an open preview and receipt access', options, async () => {
  const f = await fixture(), p = await preview(f);
  await db.client.update({ where: { id: f.client.id }, data: { deletedAt: new Date() } });
  await assert.rejects(confirmContractActivities(db, f.session, f.command, p.digest));
  await assert.rejects(readContractActivitiesReceipt(db, f.session, f.client.id, f.contract.id, f.command.commandId)); await unchanged(f);
});
test('closed contracts cannot be completed', options, async () => {
  for (const status of ['non_firmato', 'annullato', 'archiviato'] as const) {
    const f = await fixture(); await db.contract.update({ where: { id: f.contract.id }, data: { status } });
    await assert.rejects(preview(f)); assert.equal((await contractActivitiesSetup(db, f.session, f.contract.id)).reconciliationOnly, true); await unchanged(f);
  }
});
test('existing activities cannot be overwritten but whitespace-only legacy fields can be filled', options, async () => {
  const f = await fixture(); await db.contract.update({ where: { id: f.contract.id }, data: { serviceDescription: 'Attività preesistenti' } });
  await assert.rejects(preview(f));
  assert.equal((await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).serviceDescription, 'Attività preesistenti');
  const blank = await fixture(); await db.contract.update({ where: { id: blank.contract.id }, data: { serviceDescription: ' \n\t' } });
  await save(blank); assert.equal((await db.contract.findUniqueOrThrow({ where: { id: blank.contract.id } })).serviceDescription, blank.command.activities);
});
test('a service linked after preview prevents completion, including an archived service', options, async () => {
  const f = await fixture(), p = await preview(f), catalog = await db.serviceCatalog.findFirstOrThrow();
  await db.clientService.create({ data: { clientId: f.client.id, contractId: f.contract.id, serviceCatalogId: catalog.id, deletedAt: new Date() } });
  await assert.rejects(confirmContractActivities(db, f.session, f.command, p.digest)); await unchanged(f);
});
test('a command cannot relink the contract to a different client', options, async () => {
  const f = await fixture(), other = await fixture();
  await assert.rejects(previewContractActivities(db, f.session, { ...f.command, clientId: other.client.id })); await unchanged(f);
});
test('a changed signature or financial snapshot invalidates the preview', options, async () => {
  const f = await fixture(), p = await preview(f);
  await db.contract.update({ where: { id: f.contract.id }, data: { status: 'firmato', signedAt: new Date('2020-01-01') } });
  await assert.rejects(confirmContractActivities(db, f.session, f.command, p.digest)); await unchanged(f);
});
test('changed text requires a new preview', options, async () => {
  const f = await fixture(), p = await preview(f);
  await assert.rejects(confirmContractActivities(db, f.session, { ...f.command, activities: 'Attività diverse' }, p.digest)); await unchanged(f);
});
test('simultaneous confirmations yield one update and one receipt', options, async () => {
  const f = await fixture(), p = await preview(f);
  const results = await Promise.allSettled([1, 2].map(() => confirmContractActivities(db, f.session, f.command, p.digest)));
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (const result of results) if (result.status === 'rejected') assert.ok(result.reason instanceof SerializableConflictError);
  assert.equal(await db.auditLog.count({ where: { entityId: f.contract.id, event } }), 1);
});
test('audit persistence failure rolls back the activities', options, async () => {
  const f = await fixture(), p = await preview(f);
  const failing = intercepted(tx => new Proxy(tx, { get(target, property) {
    if (property === 'auditLog') return new Proxy(target.auditLog, { get(delegate, key) {
      if (key === 'create') return async () => { throw new Error('Synthetic audit failure'); };
      return Reflect.get(delegate, key);
    } });
    return Reflect.get(target, property);
  } }));
  await assert.rejects(confirmContractActivities(failing, f.session, f.command, p.digest), /Synthetic audit failure/); await unchanged(f);
});
test('receipt lookup concurrent with an unacknowledged commit never reports false absence', options, async () => {
  const f = await fixture(), p = await preview(f), held = latch(), release = latch();
  const gated = intercepted(tx => new Proxy(tx, { get(target, property) {
    if (property === 'contract') return new Proxy(target.contract, { get(delegate, key) {
      if (key === 'update') return async (...args: Parameters<typeof target.contract.update>) => {
        const result = await target.contract.update(...args); held.release(); await release.promise; return result;
      };
      return Reflect.get(delegate, key);
    } });
    return Reflect.get(target, property);
  } }));
  const write = confirmContractActivities(gated, f.session, f.command, p.digest); await held.promise;
  const lookup = readContractActivitiesReceipt(db, f.session, f.client.id, f.contract.id, f.command.commandId);
  const pending = Promise.allSettled([write, lookup]);
  try {
    let waiting = false;
    for (let i = 0; i < 40; i++) {
      const rows = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%Client%' OR query LIKE '%User%' OR query LIKE '%Contract%')`;
      if (rows[0].count > 0n) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true);
  } finally { release.release(); }
  const results = await pending; assert.equal(results[0].status, 'fulfilled');
  if (results[1].status === 'fulfilled') assert.equal(results[1].value?.contractId, f.contract.id);
  else assert.ok(results[1].reason instanceof SerializableConflictError);
  assert.equal((await readContractActivitiesReceipt(db, f.session, f.client.id, f.contract.id, f.command.commandId))?.contractId, f.contract.id);
});
test('receipt reconciliation remains bound to its author and current permissions', options, async () => {
  const f = await fixture(); await save(f);
  await assert.rejects(readContractActivitiesReceipt(db, authority.session, f.client.id, f.contract.id, f.command.commandId));
  await db.userPermissionOverride.create({ data: { userId: f.person.user.id, permission: 'contract.read', allowed: false } });
  await assert.rejects(readContractActivitiesReceipt(db, f.session, f.client.id, f.contract.id, f.command.commandId));
});
