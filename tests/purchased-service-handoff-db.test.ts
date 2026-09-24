import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { purchasedFixture, cleanupPurchasedFixtures, type PurchasedFixture } from './purchased-service-fixture';
import { handoffPurchasedService, getHandoffReceipt, previewPurchasedServiceHandoff } from '../src/lib/purchased-service-handoff';
import { acceptResponsibility, readResponsibility, requireUnboundServiceAssignment, savePracticeResponsibility } from '../src/lib/responsibility';
import { withSerializableTransaction } from '../src/lib/serializable';
import { revokeAllInternalSessions } from '../src/lib/internal-session-registry';
import { canViewDocument, canViewClient } from '../src/lib/access-control';
import { localPathFromStoragePath } from '../src/lib/storage';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1', fixtures: PurchasedFixture[] = [];
const priorMode = process.env.INTERNAL_SESSION_MODE; let admitted = false;
before(async () => { if (!enabled) return; await assertAiOrchestratorEphemeralDatabaseIdentity(db); admitted = true; process.env.INTERNAL_SESSION_MODE = 'registry'; });
after(async () => { if (admitted) { await cleanupPurchasedFixtures(db, fixtures); if (priorMode === undefined) delete process.env.INTERNAL_SESSION_MODE; else process.env.INTERNAL_SESSION_MODE = priorMode; } await db.$disconnect(); });
async function fixture() { const f = await purchasedFixture(db); fixtures.push(f); return f; }
const tx = <T>(work: Parameters<typeof withSerializableTransaction<T>>[1]) => withSerializableTransaction(db, work);

test('existing paid purchase opens one practice without a lead, sale or commercial owner; personal acceptance is separate', { skip: !enabled }, async () => {
  const f = await fixture(), serviceBefore = await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } });
  const entry = await tx(t => handoffPurchasedService(t, f.admin, f.input, true)), r = entry.receipt;
  assert.equal((await tx(t => handoffPurchasedService(t, f.admin, f.input, true))).id, entry.id);
  assert.equal(await db.technicalPractice.count({ where: { clientServiceId: f.service.id } }), 1);
  const practice = await db.technicalPractice.findUniqueOrThrow({ where: { id: r.technicalPracticeId } });
  assert.equal(practice.commercialOwnerId, null); assert.equal(practice.technicalOwnerId, f.tech.id);
  assert.deepEqual(await db.client.findUniqueOrThrow({ where: { id: f.client.id } }), f.client);
  assert.equal(await db.commercialOffer.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.lead.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.contract.count({ where: { clientId: f.client.id } }), 1); assert.equal(await db.payment.count({ where: { clientId: f.client.id } }), 1);
  const service = await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } });
  assert.equal(service.assignedToId, f.tech.id); assert.equal(service.status, serviceBefore.status); assert.equal(service.operationalStatus, serviceBefore.operationalStatus);
  const tasks = await db.task.findMany({ where: { clientServiceId: service.id } });
  assert.equal(tasks.length, 2); assert.ok(tasks.every(task => task.assignedToId === null && task.dueAt?.toISOString() === f.input.dueDate));
  assert.equal((await readResponsibility(db, 'TechnicalPractice', practice.id)).accepted.length, 0);
  await tx(t => acceptResponsibility(t, f.tech, { kind: 'TechnicalPractice', id: practice.id, role: 'tecnico', decisionId: r.decisionId }));
  assert.equal((await readResponsibility(db, 'TechnicalPractice', practice.id)).accepted.length, 1);
  assert.equal((await getHandoffReceipt(db, service.id))!.id, entry.id);
});

test('one existing practice is attached without losing the commercial owner or duplicating the client', { skip: !enabled }, async () => {
  const f = await fixture();
  const practice = await db.technicalPractice.create({ data: { clientId: f.client.id, clientServiceId: f.service.id, commercialOwnerId: f.admin.id,
    title: 'Existing synthetic practice', practiceType: 'Existing variant', targetEntity: 'Existing target', createdById: f.admin.id } });
  const preview = await previewPurchasedServiceHandoff(db, f.service.id);
  const entry = await tx(t => handoffPurchasedService(t, f.admin, { ...f.input, expectedHash: preview.expectedHash }, true));
  assert.equal(entry.receipt.technicalPracticeId, practice.id);
  assert.equal((await db.technicalPractice.findUniqueOrThrow({ where: { id: practice.id } })).commercialOwnerId, f.admin.id);
  assert.equal(await db.technicalPractice.count({ where: { clientServiceId: f.service.id } }), 1);
});

test('stale evidence, missing file, altered bytes and an unpaid declaration cannot admit a handoff', { skip: !enabled }, async () => {
  const f = await fixture();
  await db.contract.update({ where: { id: f.contract.id }, data: { serviceDescription: 'Changed scope requiring a new administrative confirmation' } });
  await assert.rejects(tx(t => handoffPurchasedService(t, f.admin, f.input, true)), /cambiati/);
  const current = { ...f.input, expectedHash: (await previewPurchasedServiceHandoff(db, f.service.id)).expectedHash };
  await writeFile(localPathFromStoragePath(f.documents[0].storagePath), 'tampered synthetic proof');
  await assert.rejects(tx(t => handoffPurchasedService(t, f.admin, current, true)), /non corrisponde/);
  await db.payment.update({ where: { id: f.payment.id }, data: { status: 'da_incassare' } });
  await assert.rejects(previewPurchasedServiceHandoff(db, f.service.id), /rata incassata/);
  assert.equal(await db.technicalPractice.count({ where: { clientServiceId: f.service.id } }), 0);
  assert.equal(await db.task.count({ where: { clientServiceId: f.service.id } }), 0);
  const missing = await fixture(), storagePath = `${missing.client.id}/${missing.service.id}/absent-proof.txt`;
  await db.document.update({ where: { id: missing.documents[0].id }, data: { storagePath } });
  await db.documentVersion.update({ where: { id: missing.documents[0].version.id }, data: { storagePath } });
  const missingPreview = await previewPurchasedServiceHandoff(db, missing.service.id);
  await assert.rejects(tx(t => handoffPurchasedService(t, missing.admin, { ...missing.input, expectedHash: missingPreview.expectedHash }, true)), /non è disponibile/);
});

test('authority, revoked session, inactive target and foreign evidence fail before any work is assigned', { skip: !enabled }, async () => {
  const f = await fixture(), foreign = await fixture();
  await assert.rejects(tx(t => handoffPurchasedService(t, f.tech, f.input, true)));
  await assert.rejects(tx(t => handoffPurchasedService(t, f.admin, f.input, false)));
  await db.user.update({ where: { id: f.tech.id }, data: { active: false } });
  await assert.rejects(tx(t => handoffPurchasedService(t, f.admin, f.input, true)));
  await db.user.update({ where: { id: f.tech.id }, data: { active: true } });
  await db.contract.update({ where: { id: f.contract.id }, data: { signedDocumentId: foreign.documents[0].id } });
  await assert.rejects(previewPurchasedServiceHandoff(db, f.service.id), /coerente/);
  await db.$transaction(t => revokeAllInternalSessions(t, f.admin.id, 'INTERNAL_GLOBAL', f.admin.id));
  await assert.rejects(tx(t => handoffPurchasedService(t, f.admin, f.input, true)));
  assert.equal(await getHandoffReceipt(db, f.service.id), null);
});

test('a concurrent duplicate produces one committed practice; a transaction failure preserves all prior business records', { skip: !enabled }, async () => {
  const f = await fixture();
  await assert.rejects(tx(async t => { await handoffPurchasedService(t, f.admin, f.input, true); throw new Error('INJECTED_AUDIT_BOUNDARY_FAILURE'); }));
  assert.equal(await getHandoffReceipt(db, f.service.id), null);
  assert.equal(await db.task.count({ where: { clientServiceId: f.service.id } }), 0);
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } })).assignedToId, null);
  const results = await Promise.allSettled([tx(t => handoffPurchasedService(t, f.admin, f.input, true)), tx(t => handoffPurchasedService(t, f.admin, f.input, true))]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal(await db.technicalPractice.count({ where: { clientServiceId: f.service.id } }), 1);
  assert.equal(await db.task.count({ where: { clientServiceId: f.service.id } }), 2);
  assert.equal((await tx(t => handoffPurchasedService(t, f.admin, f.input, true))).id, (await getHandoffReceipt(db, f.service.id))!.id);
});

test('technical reassignment moves service document scope atomically, preserves receipts and prevents a separate service transfer', { skip: !enabled }, async () => {
  const f = await fixture(), entry = await tx(t => handoffPurchasedService(t, f.admin, f.input, true));
  const current = await readResponsibility(db, 'TechnicalPractice', entry.receipt.technicalPracticeId);
  await assert.rejects(tx(t => requireUnboundServiceAssignment(t, f.service.id)));
  await tx(t => savePracticeResponsibility(t, f.admin, { id: entry.receipt.technicalPracticeId, expectedEntryId: current.current!.id,
    expectedUpdatedAt: current.context!.updatedAt.toISOString(), commercialOwnerId: null, technicalOwnerId: f.other.id,
    departmentCode: 'Reparto sostitutivo', reason: 'Riassegnazione amministrativa del servizio già affidato' }, true));
  const service = await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } });
  assert.equal(service.assignedToId, f.other.id);
  const doc = { ...f.documents[2], client: f.client, clientService: { ...service, client: f.client }, project: null };
  assert.equal(canViewDocument(f.tech, doc), false); assert.equal(canViewDocument(f.other, doc), true); assert.equal(canViewClient(f.other, f.client), false);
  assert.deepEqual(await getHandoffReceipt(db, f.service.id), entry);
  await tx(t => handoffPurchasedService(t, f.admin, f.input, true));
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: service.id } })).assignedToId, f.other.id);
});
