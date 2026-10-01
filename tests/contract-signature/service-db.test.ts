import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, type RoleCode } from '@prisma/client';
import { recordContractSignature } from '../../src/lib/contract-signature';
import { ContractSignatureError } from '../../src/lib/contract-signature-policy';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
const enabled = process.env.CONTRACT_SIGNATURE_DB_CONFIRMED === '1' && assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient();
test.before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.after(async () => { await db.$disconnect(); });
const failure = (code: string) => (error: unknown) => error instanceof ContractSignatureError && error.code === code;
async function user(role: RoleCode) {
  const row = await db.user.create({ data: { name: 'Synthetic signature', email: `signature-${randomUUID()}@example.test`, role, active: true, passwordHash: 'synthetic-unusable' } });
  const session = await db.internalSession.create({ data: { userId: row.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { userId: row.id, role, active: true, permissionOverrides: [], sessionId: session.id, expiresAt: Math.floor(session.expiresAt.getTime() / 1000) };
}
async function fixture() {
  const admin = await user('admin'), accounting = await user('amministrazione');
  const client = await db.client.create({ data: { displayName: 'Synthetic signature client', type: 'societa' } });
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: randomUUID(), serviceName: 'Synthetic service', taxableAmount: '100', vatAmount: '22', totalAmount: '122' } });
  const payment = await db.payment.create({ data: { clientId: client.id, contractId: contract.id, taxableAmount: '100', vatAmount: '22', totalAmount: '122', status: 'da_incassare' } });
  const document = await db.document.create({ data: { clientId: client.id, serviceArea: 'contratti', documentCategory: 'contratti', type: 'contratti', title: 'Synthetic signed contract',
    fileName: 'synthetic.pdf', mimeType: 'application/pdf', sizeBytes: 100, storagePath: `synthetic/${randomUUID()}`, checksum: 'a'.repeat(64), uploadedById: admin.userId, containsSensitiveData: true } });
  const version = await db.documentVersion.create({ data: { documentId: document.id, version: 1, storagePath: document.storagePath, checksum: document.checksum } });
  const input = { contractId: contract.id, expectedVersion: contract.updatedAt.toISOString(), signedDocumentVersionId: version.id, signedOn: '2026-01-01', confirmed: true };
  return { admin, accounting, client, contract, payment, document, version, input };
}
test('signature and audit commit together; pending payment and service state stay unchanged', { skip: !enabled }, async () => {
  const f = await fixture();
  await recordContractSignature(db, f.accounting, f.input);
  const saved = await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  assert.equal(saved.status, 'firmato'); assert.equal(saved.signedDocumentId, f.document.id); assert.equal(saved.signedAt?.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(saved.sentAt, null); assert.equal(saved.totalAmount.toString(), '122');
  assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } }), f.payment);
  assert.equal(await db.clientService.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.practiceReadiness.count({ where: { clientId: f.client.id } }), 0);
  const audits = await db.auditLog.findMany({ where: { entityId: f.contract.id, event: 'contract_signature_recorded' } });
  assert.equal(audits.length, 1); assert.equal((audits[0].after as Prisma.JsonObject).signedDocumentVersionId, f.version.id);
  assert.equal(JSON.stringify(audits).includes(f.document.storagePath), false);
});
test('parallel submissions create one signature and one audit', { skip: !enabled }, async () => {
  const f = await fixture(); const results = await Promise.allSettled([recordContractSignature(db, f.admin, f.input), recordContractSignature(db, f.admin, f.input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await db.auditLog.count({ where: { entityId: f.contract.id, event: 'contract_signature_recorded' } }), 1);
});
test('revoked sessions and current permission changes reject an already-open form', { skip: !enabled }, async () => {
  const f = await fixture();
  await db.userPermissionOverride.create({ data: { userId: f.accounting.userId, permission: 'contract.write', allowed: false } });
  await assert.rejects(recordContractSignature(db, f.accounting, f.input), failure('DENIED'));
  await db.internalSession.update({ where: { id: f.admin.sessionId }, data: { revokedAt: new Date() } });
  await assert.rejects(recordContractSignature(db, f.admin, f.input), failure('DENIED'));
  assert.equal((await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).status, 'da_preparare');
});
test('read-only grants and reassigned clients do not become writable through claimed overrides', { skip: !enabled }, async () => {
  const f = await fixture(), sales = await user('commerciale');
  await db.userPermissionOverride.createMany({ data: ['contract.read', 'contract.write', 'document.download', 'document.sensitive.read'].map(permission => ({ userId: sales.userId, permission, allowed: true })) });
  await assert.rejects(recordContractSignature(db, { ...sales, clientReadScope: [f.client.id] }, f.input), failure('DENIED'));
  await db.client.update({ where: { id: f.client.id }, data: { salesOwnerId: sales.userId } });
  await db.document.update({ where: { id: f.document.id }, data: { uploadedById: sales.userId } });
  // A live authoritative allow and ownership still cannot exceed the role ceiling.
  await assert.rejects(recordContractSignature(db, sales, f.input), failure('DENIED'));
  assert.equal(await db.auditLog.count({ where: { entityId: f.contract.id } }), 0);
  assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } }), f.payment);
  await db.client.update({ where: { id: f.client.id }, data: { salesOwnerId: f.admin.userId } });
  await assert.rejects(recordContractSignature(db, sales, f.input), failure('DENIED'));
});
test('foreign, deleted, rejected and replaced document evidence cannot be attached', { skip: !enabled }, async () => {
  for (const change of ['foreign', 'deleted', 'rejected', 'replaced'] as const) {
    const f = await fixture();
    if (change === 'foreign') {
      const other = await db.client.create({ data: { type: 'societa', displayName: 'Other synthetic' } });
      await db.document.update({ where: { id: f.document.id }, data: { clientId: other.id } });
    } else if (change === 'deleted') await db.document.update({ where: { id: f.document.id }, data: { deletedAt: new Date() } });
    else if (change === 'rejected') await db.document.update({ where: { id: f.document.id }, data: { status: 'respinto' } });
    else await db.documentVersion.create({ data: { documentId: f.document.id, version: 2, storagePath: f.document.storagePath, checksum: f.document.checksum } });
    await assert.rejects(recordContractSignature(db, f.admin, f.input), failure('DOCUMENT_CHANGED'));
    assert.equal((await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).signedDocumentId, null);
  }
});
test('stale contracts, closed contracts and future dates leave no signature audit', { skip: !enabled }, async () => {
  const f = await fixture();
  await assert.rejects(recordContractSignature(db, f.admin, { ...f.input, signedOn: '9999-01-01' }), failure('INVALID_DATE'));
  const cancelled = await db.contract.update({ where: { id: f.contract.id }, data: { status: 'annullato', updatedAt: new Date(f.contract.updatedAt.getTime() + 1000) } });
  await assert.rejects(recordContractSignature(db, f.admin, f.input), failure('STALE'));
  await assert.rejects(recordContractSignature(db, f.admin, { ...f.input, expectedVersion: cancelled.updatedAt.toISOString() }), failure('CLOSED'));
  assert.equal(await db.auditLog.count({ where: { entityId: f.contract.id } }), 0);
});
test('audit failure rolls back the contract mutation and leaves payment unchanged', { skip: !enabled }, async () => {
  const f = await fixture();
  const failing = db.$extends({ query: { auditLog: { async create() { throw new Error('SYNTHETIC_AUDIT_FAILURE'); } } } }) as unknown as PrismaClient;
  await assert.rejects(recordContractSignature(failing, f.admin, f.input), /SYNTHETIC_AUDIT_FAILURE/);
  assert.deepEqual(await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } }), f.contract);
  assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } }), f.payment);
});

test('session expiry while waiting for the client lock leaves no signature or audit', { skip: !enabled }, async () => {
  const f = await fixture(), connection = `signature-expiry-${randomUUID()}`;
  await db.internalSession.update({ where: { id: f.admin.sessionId }, data: { expiresAt: new Date(Date.now() + 1800) } });
  let locked!: () => void, release!: () => void;
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const blocker = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${f.client.id} FOR UPDATE`;
    locked(); await released;
  }, { timeout: 10_000 });
  await Promise.race([acquired, blocker]);
  const named = { $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('application_name', ${connection}, true)`;
    return work(tx);
  }, options) } as unknown as PrismaClient;
  const writer = Promise.allSettled([recordContractSignature(named, f.admin, f.input)]);
  try {
    let blocked = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=${connection} AND wait_event_type='Lock') AS blocked`;
      if (row.blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(blocked, true, 'Actual PostgreSQL lock contention must be observed');
    await new Promise(resolve => setTimeout(resolve, 2200));
  } finally { release(); await blocker; }
  const [result] = await writer;
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.ok(failure('DENIED')(result.reason));
  assert.equal((await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).status, 'da_preparare');
  assert.equal(await db.auditLog.count({ where: { entityId: f.contract.id } }), 0);
});
