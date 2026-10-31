import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { lifecycleReadinessFixture } from './admin-lifecycle/fixtures';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { previewAdminOperationalLink, saveAdminOperationalLink, readAdminOperationalLink, reconcileAdminOperationalLink } from '../src/lib/admin-operational-links';
import { currentPracticeFormalization } from '../src/lib/admin-practice-formalization-store';
import { listAccessiblePracticeReadiness } from '../src/lib/practice-readiness';
const enabled = process.env.RUN_DB_TESTS === '1' && process.env.ADMIN_FORMALIZATION_DB_TESTS === '1', options = { skip: !enabled };
const db = new PrismaClient(), key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person;
before(async () => {
  if (!enabled) return; await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const existing = await db.selectiveAccessAuthority.findFirst();
  if (existing) { const user = await db.user.findUniqueOrThrow({ where: { id: existing.userId } }); admin = { user, ...await syntheticSession(db, user) }; }
  else admin = await syntheticAuthority(db);
});
after(() => db.$disconnect());
function proof(secondsAgo = 0) {
  return { key, sessionToken: admin.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: admin.user.id, role: 'admin',
    sessionToken: admin.token, nowSeconds: Math.floor(Date.now() / 1000) - secondsAgo }) };
}
async function fixture() {
  const f = await lifecycleReadinessFixture(db, admin.session);
  const practice = await db.practiceReadiness.findUniqueOrThrow({ where: { id: f.practice.id } });
  const original = await db.practiceFormalization.findUniqueOrThrow({ where: { id: practice.currentFormalizationId! } });
  const contract = await db.contract.findUniqueOrThrow({ where: { id: original.contractId } });
  const alternative = await db.contract.create({ data: { clientId: contract.clientId, projectId: contract.projectId, contractNumber: randomUUID(),
    serviceName: contract.serviceName, serviceDescription: contract.serviceDescription, taxableAmount: contract.taxableAmount,
    vatAmount: contract.vatAmount, totalAmount: contract.totalAmount, status: 'firmato', signedAt: contract.signedAt, signedDocumentId: contract.signedDocumentId } });
  return { ...f, practice, original, contract, alternative };
}
async function command(id: string, patch: Record<string, string>) {
  const data = await readAdminOperationalLink(db, admin.session, 'PracticeReadiness', id);
  const choice = { model: 'PracticeReadiness' as const, id, values: { ...data.values, ...patch } };
  const preview = await previewAdminOperationalLink(db, admin.session, choice);
  return { ...choice, commandId: randomUUID(), expectedVersion: preview.version, reason: 'Rettifica sintetica di collegamenti firmati', confirmed: true as const };
}
test('formalized and started practice uses corrected current references while retaining original signature, acceptance and start evidence', options, async () => {
  const f = await fixture(), acceptance = await db.practiceOfferAcceptance.findUniqueOrThrow({ where: { offerRevisionId: f.practice.acceptedOfferRevisionId } });
  const priorService = await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } });
  const input = await command(f.practice.id, { contractId: f.alternative.id });
  await saveAdminOperationalLink(db, admin.session, input, proof());
  const current = await db.practiceReadiness.findUniqueOrThrow({ where: { id: f.practice.id } });
  assert.equal(current.contractId, f.alternative.id); assert.equal(current.currentFormalizationId, f.original.id);
  assert.equal(current.acceptedOfferRevisionId, f.practice.acceptedOfferRevisionId);
  assert.deepEqual(current.startEvidence, f.practice.startEvidence); assert.deepEqual(current.startedAt, f.practice.startedAt);
  assert.deepEqual(await db.practiceFormalization.findUniqueOrThrow({ where: { id: f.original.id } }), f.original);
  assert.deepEqual(await db.practiceOfferAcceptance.findUniqueOrThrow({ where: { id: acceptance.id } }), acceptance);
  const service = await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } });
  assert.equal(service.contractId, f.alternative.id); assert.equal(service.assignedToId, priorService.assignedToId);
  assert(service.recordUpdateEpoch > priorService.recordUpdateEpoch);
  const effective = await db.$transaction(tx => currentPracticeFormalization(tx, current, f.original));
  assert.equal(effective?.contractId, f.alternative.id); assert.equal(effective?.administrativeCorrection?.commandId, input.commandId);
  const visible = (await listAccessiblePracticeReadiness(db, admin.session)).find(v => v.id === f.practice.id);
  assert.equal(visible?.contractId, f.alternative.id);
  assert.equal(visible?.prerequisites.missing.includes('incarico_formalizzato'), false);
});
test('restoration records another correction and keeps the complete operational-reference chain', options, async () => {
  const f = await fixture();
  await saveAdminOperationalLink(db, admin.session, await command(f.practice.id, { contractId: f.alternative.id }), proof());
  const restore = await command(f.practice.id, { contractId: f.contract.id });
  await saveAdminOperationalLink(db, admin.session, restore, proof());
  const current = await db.practiceReadiness.findUniqueOrThrow({ where: { id: f.practice.id } });
  const effective = await db.$transaction(tx => currentPracticeFormalization(tx, current, f.original));
  assert.equal(effective?.contractId, f.contract.id); assert.equal(effective?.administrativeCorrection?.commandId, restore.commandId);
  assert.equal((await readAdminOperationalLink(db, admin.session, 'PracticeReadiness', f.practice.id)).history.length, 2);
});
test('unsigned contracts, unrelated versions and other-client bindings cannot replace current formalization', options, async () => {
  const f = await fixture(), other = await fixture();
  await db.contract.update({ where: { id: f.alternative.id }, data: { status: 'non_firmato' } });
  await assert.rejects(command(f.practice.id, { contractId: f.alternative.id }), /CONTEXT/);
  await assert.rejects(command(f.practice.id, { signedDocumentVersionId: f.documentVersion.id }), /CONTEXT/);
  await assert.rejects(command(f.practice.id, { contractId: other.contract.id, signedDocumentVersionId: other.original.signedDocumentVersionId }), /CONTEXT/);
  assert.equal((await db.practiceReadiness.findUniqueOrThrow({ where: { id: f.practice.id } })).contractId, f.contract.id);
});
test('an unaccepted offer revision cannot become accepted through Admin correction', options, async () => {
  const f = await fixture(), original = await db.practiceOfferRevision.findUniqueOrThrow({ where: { id: f.practice.acceptedOfferRevisionId } });
  const unaccepted = await db.practiceOfferRevision.create({ data: { ...original, id: randomUUID(), revision: original.revision + 1,
    inclusions: original.inclusions as Prisma.InputJsonValue, exclusions: original.exclusions as Prisma.InputJsonValue, deliverables: original.deliverables as Prisma.InputJsonValue,
    payloadHash: 'a' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 31) } });
  await assert.rejects(command(f.practice.id, { acceptedOfferRevisionId: unaccepted.id }), /CONTEXT/);
  assert.equal(await db.practiceOfferAcceptance.count({ where: { offerRevisionId: unaccepted.id } }), 0);
});
test('expired Admin confirmation preserves the exact correction and receipt reconciliation never repeats it', options, async () => {
  const f = await fixture(), input = await command(f.practice.id, { contractId: f.alternative.id });
  await assert.rejects(saveAdminOperationalLink(db, admin.session, input, proof(1800)));
  await saveAdminOperationalLink(db, admin.session, input, proof());
  assert.equal((await saveAdminOperationalLink(db, admin.session, input, proof())).replayed, true);
  assert.equal((await reconcileAdminOperationalLink(db, admin.session, { model: input.model, id: input.id, commandId: input.commandId, close: true })).status, 'RECORDED');
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 1);
});
test('a competing signed-context change makes the original preview stale without modifying a service', options, async () => {
  const f = await fixture(), input = await command(f.practice.id, { contractId: f.alternative.id });
  await db.contract.update({ where: { id: f.alternative.id }, data: { notes: 'Variazione sintetica concorrente' } });
  await assert.rejects(saveAdminOperationalLink(db, admin.session, input, proof()), /STALE/);
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } })).contractId, f.contract.id);
});
test('financial payment references must match the corrected contract and remain independent evidence', options, async () => {
  const f = await fixture(), payment = await db.payment.create({ data: { clientId: f.client.id, contractId: f.contract.id,
    taxableAmount: f.contract.taxableAmount, vatAmount: f.contract.vatAmount, totalAmount: f.contract.totalAmount } });
  await assert.rejects(command(f.practice.id, { contractId: f.alternative.id, paymentId: payment.id }), /PAYMENT/);
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).contractId, f.contract.id);
});
test('an audit collision rolls back formalization references, service links and administrative correction', options, async () => {
  const f = await fixture(), input = await command(f.practice.id, { contractId: f.alternative.id });
  await db.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: admin.user.id, entityType: 'Synthetic', entityId: input.id, event: 'synthetic_collision' } });
  await assert.rejects(saveAdminOperationalLink(db, admin.session, input, proof()));
  assert.deepEqual(await db.practiceReadiness.findUniqueOrThrow({ where: { id: f.practice.id } }), f.practice);
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } })).contractId, f.contract.id);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 0);
});
