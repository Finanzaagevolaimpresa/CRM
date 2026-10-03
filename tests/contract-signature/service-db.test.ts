import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { storeUploadedDocument } from '../../src/lib/document-upload';
import { localPathFromStoragePath } from '../../src/lib/storage';
import { Prisma, PrismaClient, type RoleCode } from '@prisma/client';
import { declareContractSignature, recordContractSignature } from '../../src/lib/contract-signature';
import { ContractSignatureError } from '../../src/lib/contract-signature-policy';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
const enabled = process.env.CONTRACT_SIGNATURE_DB_CONFIRMED === '1' && assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient();
test.before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.after(async () => { await db.$disconnect(); });
const failure = (code: string) => (error: unknown) => error instanceof ContractSignatureError && error.code === code;
const declarationInput = (f: Awaited<ReturnType<typeof fixture>>) => ({ contractId: f.contract.id, expectedVersion: f.contract.updatedAt.toISOString(),
  expectedDeclarationId: null, signedOn: '2026-01-01', source: 'Comunicazione sintetica del cliente; PDF da acquisire', confirmed: true });

test('declaration is explicit and append-only; signature, payments and readiness stay unchanged', { skip: !enabled }, async () => {
  const f = await fixture();
  const first = await declareContractSignature(db, f.admin, declarationInput(f));
  const second = await declareContractSignature(db, f.admin, { ...declarationInput(f), expectedDeclarationId: first.declarationId, source: 'Fonte corretta, riferimento sintetico B' });
  assert.notEqual(first.declarationId, second.declarationId);
  const rows = await db.auditLog.findMany({ where: { entityId: f.contract.id, event: 'contract_signature_declared' } });
  assert.equal(rows.length, 2);
  assert.equal((rows[0].after as Prisma.JsonObject).declaredSignedAt, '2026-01-01');
  assert.equal((rows.find(row => row.id === first.declarationId)!.after as Prisma.JsonObject).source, declarationInput(f).source);
  assert.deepEqual(await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } }), f.contract);
  assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } }), f.payment);
  assert.equal(await db.practiceReadiness.count({ where: { clientId: f.client.id } }), 0);
  await assert.rejects(declareContractSignature(db, f.admin, { ...declarationInput(f), source: 'Stale different claim' }), failure('STALE'));
});
test('lost declaration response and identical parallel replay reconcile to one audit', { skip: !enabled }, async () => {
  const f = await fixture(), input = declarationInput(f);
  const results = await Promise.all([declareContractSignature(db, f.accounting, input), declareContractSignature(db, f.accounting, input)]);
  assert.equal(results[0].declarationId, results[1].declarationId);
  assert.equal(results.filter(row => row.reconciled).length, 1);
  const replay = await declareContractSignature(db, f.accounting, input);
  assert.equal(replay.reconciled, true);
  assert.equal(await db.auditLog.count({ where: { entityId: f.contract.id, event: 'contract_signature_declared' } }), 1);
  await db.userPermissionOverride.create({ data: { userId: f.accounting.userId, permission: 'contract.write', allowed: false } });
  await assert.rejects(declareContractSignature(db, f.accounting, input), failure('DENIED'));
});
test('declaration rejects other roles, future dates and revoked sessions before writing', { skip: !enabled }, async () => {
  const f = await fixture(), sales = await user('commerciale');
  await db.client.update({ where: { id: f.client.id }, data: { salesOwnerId: sales.userId } });
  await assert.rejects(declareContractSignature(db, sales, declarationInput(f)), failure('DENIED'));
  await assert.rejects(declareContractSignature(db, f.admin, { ...declarationInput(f), signedOn: '9999-01-01' }), failure('INVALID_DATE'));
  await db.internalSession.update({ where: { id: f.admin.sessionId }, data: { revokedAt: new Date() } });
  await assert.rejects(declareContractSignature(db, f.admin, declarationInput(f)), failure('DENIED'));
  assert.equal(await db.auditLog.count({ where: { entityId: f.contract.id } }), 0);
});
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

function uploadForm(clientId: string, requestId = randomUUID()) {
  const form = new FormData();
  form.set('clientId', clientId); form.set('title', 'Synthetic upload'); form.set('uploadRequestId', requestId);
  form.set('file', new File(['Synthetic document, never customer data.'], 'synthetic.txt', { type: 'text/plain' }));
  return form;
}
test('upload parallel and lost-response replays preserve one document, version, receipt and private file', { skip: !enabled }, async () => {
  const f = await fixture(), form = uploadForm(f.client.id);
  const [first, second] = await Promise.all([storeUploadedDocument(db, f.admin, form), storeUploadedDocument(db, f.admin, form)]);
  const third = await storeUploadedDocument(db, f.admin, form);
  assert.equal(first.id, second.id); assert.equal(first.id, third.id);
  assert.equal(await db.document.count({ where: { clientId: f.client.id, title: 'Synthetic upload' } }), 1);
  assert.equal(await db.documentVersion.count({ where: { documentId: first.id } }), 1);
  assert.equal(await db.auditLog.count({ where: { event: 'document_upload', entityId: first.id } }), 1);
  assert.equal((await readdir(dirname(localPathFromStoragePath(first.storagePath!)))).length, 1);
  form.set('title', 'Changed payload under the same key');
  await assert.rejects(storeUploadedDocument(db, f.admin, form), /dati diversi/);
  assert.equal(await db.document.count({ where: { clientId: f.client.id, title: 'Changed payload under the same key' } }), 0);
});
test('upload replay checks revoked sessions, current permission denial and current client assignment', { skip: !enabled }, async () => {
  const actor = await user('consulente');
  const client = await db.client.create({ data: { displayName: 'Synthetic upload scope', type: 'societa', consultantId: actor.userId } });
  const form = uploadForm(client.id);
  const document = await storeUploadedDocument(db, actor, form);
  await db.client.update({ where: { id: client.id }, data: { consultantId: null } });
  await assert.rejects(storeUploadedDocument(db, actor, form));
  await db.client.update({ where: { id: client.id }, data: { consultantId: actor.userId } });
  await db.userPermissionOverride.create({ data: { userId: actor.userId, permission: 'document.upload', allowed: false } });
  await assert.rejects(storeUploadedDocument(db, actor, form));
  await db.internalSession.update({ where: { id: actor.sessionId }, data: { revokedAt: new Date() } });
  await assert.rejects(storeUploadedDocument(db, actor, form));
  assert.equal(await db.auditLog.count({ where: { event: 'document_upload', entityId: document.id } }), 1);
});
test('upload audit failure rolls back metadata and retry reuses the exact private bytes', { skip: !enabled }, async () => {
  const f = await fixture(), form = uploadForm(f.client.id);
  const failing = db.$extends({ query: { auditLog: { async create() { throw new Error('SYNTHETIC_UPLOAD_AUDIT_FAILURE'); } } } }) as unknown as PrismaClient;
  await assert.rejects(storeUploadedDocument(failing, f.admin, form), /SYNTHETIC_UPLOAD_AUDIT_FAILURE/);
  assert.equal(await db.document.count({ where: { clientId: f.client.id, title: 'Synthetic upload' } }), 0);
  const saved = await storeUploadedDocument(db, f.admin, form);
  assert.equal((await readdir(dirname(localPathFromStoragePath(saved.storagePath!)))).length, 1);
  assert.equal(await db.auditLog.count({ where: { event: 'document_upload', entityId: saved.id } }), 1);
});
