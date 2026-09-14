import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import {
  attestPracticeMaterialsComplete,
  createPracticeReadiness,
  decidePracticeMaterial,
  formalizePractice,
  listAccessiblePracticeReadiness,
  PracticeReadinessError,
  recordPracticeFunding,
  confirmPracticeFunding,
  reversePracticeFunding,
  currentAvailableFunding,
  startPractice,
} from '../src/lib/practice-readiness';
import { prepareServiceCatalogV2 } from '../src/lib/service-catalog-v2-persistence';
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from './db/ai-orchestrator-db-test-guard';

const enabled = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const db = new PrismaClient();
const suffix = randomUUID();
const ids = {
  userA: `readiness-a-${suffix}`,
  userB: `readiness-b-${suffix}`,
  manager: `readiness-manager-${suffix}`,
  sessionA: randomUUID(),
  sessionB: randomUUID(),
  managerSession: randomUUID(),
};
const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
const actorA = { userId: ids.userA, sessionId: ids.sessionA, expiresAt, role: 'consulente' as const, active: true, permissionOverrides: [] };
const actorB = { userId: ids.userB, sessionId: ids.sessionB, expiresAt, role: 'consulente' as const, active: true, permissionOverrides: [] };
const manager = { userId: ids.manager, sessionId: ids.managerSession, expiresAt, role: 'direzione' as const, active: true, permissionOverrides: [] };
const previousMode = process.env.PRACTICE_READINESS_MODE;

type Context = Awaited<ReturnType<typeof createContext>>;
let a: Context;
let b: Context;
let revisionId: string;

function denied(error: unknown) {
  return error instanceof PracticeReadinessError && error.code === 'DENIED';
}

async function createContext(label: string, consultantId: string) {
  const client = await db.client.create({ data: {
    type: 'persona_fisica', displayName: `Cliente sintetico ${label} ${suffix}`, consultantId,
  } });
  const project = await db.project.create({ data: {
    clientId: client.id, title: `Pratica sintetica ${label} ${suffix}`, consultantId,
  } });
  const lead = await db.lead.create({ data: {
    firstName: 'Test', lastName: `Ambito ${label}`, clientId: client.id, assignedToId: consultantId,
  } });
  const intake = await db.controlledIntake.create({ data: {
    channel: 'EMAIL', sourceId: `scope-${label}-${suffix}`, sourceOccurredAt: new Date(),
    acquisitionMode: 'MANUAL_CONTROLLED', mappingVersion: 'scope-test-v1', payloadHash: randomBytes(32).toString('hex'),
    leadId: lead.id, subjectType: 'PERSONA', firstName: 'Test', lastName: `Ambito ${label}`,
    classificationState: 'VERIFIED', effectiveCategory: 'digitale', need: 'Fixture sintetica di ambito', operatorId: consultantId,
  } });
  const offer = await db.commercialOffer.create({ data: {
    leadId: lead.id, clientId: client.id, title: `Preventivo ${label}`, taxableAmount: '100.00', vatAmount: '22.00',
    totalAmount: '122.00', status: 'accettata', acceptedAt: new Date(), createdById: consultantId,
  } });
  const document = await db.document.create({ data: {
    clientId: client.id, projectId: project.id, type: 'incarico', title: `Incarico ${label}`,
    fileName: `${label}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, storagePath: `synthetic/${suffix}/${label}.pdf`,
    uploadedById: consultantId, status: 'verificato', checksum: randomBytes(32).toString('hex'),
  } });
  const contract = await db.contract.create({ data: {
    clientId: client.id, projectId: project.id, contractNumber: `SCOPE-${label}-${suffix}`, serviceName: 'Servizio sintetico',
    taxableAmount: '100.00', vatAmount: '22.00', totalAmount: '122.00', status: 'firmato', signedAt: new Date(),
    signedDocumentId: document.id,
  } });
  const checklist = await db.documentChecklistItem.create({ data: {
    clientId: client.id, projectId: project.id, title: `Materiale ${label}`, createdById: consultantId,
  } });
  return { client, project, lead, intake, offer, document, contract, checklist };
}

async function createPractice(context: Context, actor: typeof actorA) {
  return createPracticeReadiness(db, actor, {
    controlledIntakeId: context.intake.id,
    commercialOfferId: context.offer.id,
    serviceRevisionId: revisionId,
    clientId: context.client.id,
    projectId: context.project.id,
    requiredInitialAmount: '50.00',
    expectedOfferUpdatedAt: context.offer.updatedAt,
  });
}

async function ensurePractice(context: Context, actor: typeof actorA) {
  return (await db.practiceReadiness.findUnique({ where: { controlledIntakeId: context.intake.id } })) ?? createPractice(context, actor);
}

async function footprint(practiceId: string) {
  const [practice, funding, materials, audits, totalPractices] = await Promise.all([
    db.practiceReadiness.findUnique({ where: { id: practiceId } }),
    db.practiceFundingEvidence.count({ where: { practiceId } }),
    db.practiceMaterialEvidence.count({ where: { practiceId } }),
    db.auditLog.count({ where: { entityType: 'PracticeReadiness', entityId: practiceId } }),
    db.practiceReadiness.count(),
  ]);
  return { practice, funding, materials, audits, totalPractices };
}

async function globalFootprint() {
  const [practices, funding, materials, audits] = await Promise.all([
    db.practiceReadiness.count(),
    db.practiceFundingEvidence.count(),
    db.practiceMaterialEvidence.count(),
    db.auditLog.count({ where: { actorId: { in: [ids.userA, ids.userB, ids.manager] } } }),
  ]);
  return { practices, funding, materials, audits };
}

async function expectDeniedWithoutEffects(practiceId: string, operation: () => Promise<unknown>) {
  const before = await footprint(practiceId);
  await assert.rejects(operation, denied);
  assert.deepEqual(await footprint(practiceId), before);
}

test.before(async () => {
  if (!enabled) return;
  // This identity check intentionally precedes every fixture/catalog write.
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  process.env.PRACTICE_READINESS_MODE = 'synthetic';
  await prepareServiceCatalogV2(db);
  await db.user.createMany({ data: [
    { id: ids.userA, email: `${ids.userA}@invalid.test`, name: 'Consulente A', passwordHash: 'synthetic', role: 'consulente' },
    { id: ids.userB, email: `${ids.userB}@invalid.test`, name: 'Consulente B', passwordHash: 'synthetic', role: 'consulente' },
    { id: ids.manager, email: `${ids.manager}@invalid.test`, name: 'Direzione sintetica', passwordHash: 'synthetic', role: 'direzione' },
  ] });
  await db.internalSession.createMany({ data: [
    { id: ids.sessionA, userId: ids.userA, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 3_600_000) },
    { id: ids.sessionB, userId: ids.userB, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 3_600_000) },
    { id: ids.managerSession, userId: ids.manager, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 3_600_000) },
  ] });
  const revision = await db.serviceCatalogRevision.findFirstOrThrow({
    where: { serviceCatalog: { code: 'progetti_digitali' }, status: 'PUBLISHED' }, orderBy: { version: 'desc' },
  });
  revisionId = revision.id;
  a = await createContext('A', ids.userA);
  b = await createContext('B', ids.userB);
});

test.after(async () => {
  if (enabled) {
    await db.practiceMaterialEvidence.deleteMany({ where: { practice: { clientId: { in: [a.client.id, b.client.id] } } } });
    await db.practiceFundingEvidence.deleteMany({ where: { practice: { clientId: { in: [a.client.id, b.client.id] } } } });
    await db.practiceReadiness.deleteMany({ where: { clientId: { in: [a.client.id, b.client.id] } } });
    await db.documentChecklistItem.deleteMany({ where: { clientId: { in: [a.client.id, b.client.id] } } });
    await db.contract.deleteMany({ where: { clientId: { in: [a.client.id, b.client.id] } } });
    await db.document.deleteMany({ where: { clientId: { in: [a.client.id, b.client.id] } } });
    await db.controlledIntake.deleteMany({ where: { id: { in: [a.intake.id, b.intake.id] } } });
    await db.commercialOffer.deleteMany({ where: { clientId: { in: [a.client.id, b.client.id] } } });
    await db.project.deleteMany({ where: { clientId: { in: [a.client.id, b.client.id] } } });
    await db.lead.deleteMany({ where: { id: { in: [a.lead.id, b.lead.id] } } });
    await db.client.deleteMany({ where: { id: { in: [a.client.id, b.client.id] } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: [ids.userA, ids.userB, ids.manager] } } });
    await db.internalSession.deleteMany({ where: { id: { in: [ids.sessionA, ids.sessionB, ids.managerSession] } } });
    await db.user.deleteMany({ where: { id: { in: [ids.userA, ids.userB, ids.manager] } } });
  }
  if (previousMode === undefined) delete process.env.PRACTICE_READINESS_MODE;
  else process.env.PRACTICE_READINESS_MODE = previousMode;
  await db.$disconnect();
});

test('scope read model exposes A and omits B for a service.write operator', { skip: !enabled }, async () => {
  const practiceA = await ensurePractice(a, actorA);
  const practiceB = await ensurePractice(b, actorB);
  const visible = await listAccessiblePracticeReadiness(db, actorA);
  assert.equal(visible.some(({ id }) => id === practiceA.id), true);
  assert.equal(visible.some(({ id }) => id === practiceB.id), false);
});

test('every command and create replay deny a known out-of-scope B id without effects', { skip: !enabled }, async () => {
  const practiceB = await ensurePractice(b, actorB);
  const commands = [
    () => recordPracticeFunding(db, actorA, { practiceId: practiceB.id, reference: `B-${suffix}`, amount: '10.00', currency: 'EUR', expectedVersion: practiceB.version }),
    () => confirmPracticeFunding(db, actorA, { practiceId: practiceB.id, evidenceId: randomUUID(), expectedVersion: practiceB.version }),
    () => reversePracticeFunding(db, actorA, { practiceId: practiceB.id, evidenceId: randomUUID(), expectedVersion: practiceB.version }),
    () => decidePracticeMaterial(db, actorA, { practiceId: practiceB.id, checklistItemId: b.checklist.id, status: 'NOT_NEEDED', reason: 'Non pertinente', expectedVersion: practiceB.version }),
    () => formalizePractice(db, actorA, { practiceId: practiceB.id, contractId: b.contract.id, signedDocumentId: b.document.id, expectedVersion: practiceB.version }),
    () => attestPracticeMaterialsComplete(db, actorA, { practiceId: practiceB.id, expectedVersion: practiceB.version }),
    () => startPractice(db, actorA, { practiceId: practiceB.id, expectedVersion: practiceB.version }),
    () => createPractice(b, actorA),
  ];
  for (const command of commands) await expectDeniedWithoutEffects(practiceB.id, command);
});

test('create rejects nonexistent/cross-client references before persistence', { skip: !enabled }, async () => {
  const before = await globalFootprint();
  await assert.rejects(createPracticeReadiness(db, actorA, {
    controlledIntakeId: b.intake.id, commercialOfferId: a.offer.id, serviceRevisionId: revisionId,
    clientId: a.client.id, projectId: a.project.id, requiredInitialAmount: '50.00', expectedOfferUpdatedAt: a.offer.updatedAt,
  }), denied);
  await assert.rejects(createPracticeReadiness(db, actorA, {
    controlledIntakeId: a.intake.id, commercialOfferId: a.offer.id, serviceRevisionId: revisionId,
    clientId: a.client.id, projectId: `missing-${suffix}`, requiredInitialAmount: '50.00', expectedOfferUpdatedAt: a.offer.updatedAt,
  }), denied);
  assert.deepEqual(await globalFootprint(), before);
});

test('revocation and changed assignment deny commands and replay with zero effects', { skip: !enabled }, async () => {
  const practiceA = await ensurePractice(a, actorA);
  await db.client.update({ where: { id: a.client.id }, data: { consultantId: ids.userB } });
  await expectDeniedWithoutEffects(practiceA.id, () => recordPracticeFunding(db, actorA, {
    practiceId: practiceA.id, reference: `REASSIGNED-${suffix}`, amount: '1.00', currency: 'EUR', expectedVersion: practiceA.version,
  }));
  await expectDeniedWithoutEffects(practiceA.id, () => createPractice(a, actorA));
  await db.client.update({ where: { id: a.client.id }, data: { consultantId: ids.userA } });
  await db.internalSession.update({ where: { id: ids.sessionA }, data: { revokedAt: new Date(), revokedReason: 'TEST' } });
  await expectDeniedWithoutEffects(practiceA.id, () => startPractice(db, actorA, { practiceId: practiceA.id, expectedVersion: practiceA.version }));
  await expectDeniedWithoutEffects(practiceA.id, () => createPractice(a, actorA));
  await db.internalSession.update({ where: { id: ids.sessionA }, data: { revokedAt: null, revokedReason: null } });
});

test('archived client, lead, and project independently hide reads and deny writes', { skip: !enabled }, async () => {
  const practiceA = await ensurePractice(a, actorA);
  const cases = [
    { archive: () => db.client.update({ where: { id: a.client.id }, data: { deletedAt: new Date() } }), restore: () => db.client.update({ where: { id: a.client.id }, data: { deletedAt: null } }) },
    { archive: () => db.lead.update({ where: { id: a.lead.id }, data: { deletedAt: new Date() } }), restore: () => db.lead.update({ where: { id: a.lead.id }, data: { deletedAt: null } }) },
    { archive: () => db.project.update({ where: { id: a.project.id }, data: { deletedAt: new Date() } }), restore: () => db.project.update({ where: { id: a.project.id }, data: { deletedAt: null } }) },
  ];
  for (const item of cases) {
    await item.archive();
    try {
      assert.equal((await listAccessiblePracticeReadiness(db, actorA)).some(({ id }) => id === practiceA.id), false);
      await expectDeniedWithoutEffects(practiceA.id, () => recordPracticeFunding(db, actorA, {
        practiceId: practiceA.id, reference: `ARCHIVED-${suffix}`, amount: '1.00', currency: 'EUR', expectedVersion: practiceA.version,
      }));
      await expectDeniedWithoutEffects(practiceA.id, () => createPractice(a, actorA));
    } finally {
      await item.restore();
    }
  }
});

test('funding history is exact, idempotent, concurrent-safe, reversible, and atomic', { skip: !enabled }, async () => {
  let practice = await ensurePractice(b, actorB);
  const firstInput = { practiceId: practice.id, reference: `PARTIAL-1-${suffix}`, amount: '20.00', currency: 'EUR', expectedVersion: practice.version } as const;
  const declared = await recordPracticeFunding(db, actorB, firstInput);
  const replay = await recordPracticeFunding(db, actorB, firstInput);
  assert.equal(replay.id, declared.id);
  assert.equal((await db.practiceFundingEvidence.count({ where: { practiceId: practice.id } })), 1);
  await assert.rejects(recordPracticeFunding(db, actorB, { ...firstInput, amount: '21.00' }), (error) => error instanceof PracticeReadinessError && error.code === 'CONFLICT');
  await assert.rejects(recordPracticeFunding(db, actorB, { ...firstInput, reference: `STALE-${suffix}` }), (error) => error instanceof PracticeReadinessError && error.code === 'CONFLICT');

  practice = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  const confirmationInput = { practiceId: practice.id, evidenceId: declared.id, expectedVersion: practice.version };
  const confirmations = await Promise.all([
    confirmPracticeFunding(db, actorB, confirmationInput),
    confirmPracticeFunding(db, actorB, confirmationInput),
  ]);
  assert.equal(confirmations[0].id, confirmations[1].id);
  let history = await db.practiceFundingEvidence.findMany({ where: { practiceId: practice.id }, include: { successor: true } });
  assert.equal(history.length, 2);
  assert.equal(currentAvailableFunding(history).toFixed(2), '20.00');

  practice = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  const supplement = await recordPracticeFunding(db, actorB, { practiceId: practice.id, reference: `PARTIAL-2-${suffix}`, amount: '30.00', currency: 'EUR', expectedVersion: practice.version });
  practice = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  await confirmPracticeFunding(db, actorB, { practiceId: practice.id, evidenceId: supplement.id, expectedVersion: practice.version });
  history = await db.practiceFundingEvidence.findMany({ where: { practiceId: practice.id }, include: { successor: true } });
  assert.equal(currentAvailableFunding(history).toFixed(2), '50.00');

  practice = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  const reversed = await reversePracticeFunding(db, actorB, { practiceId: practice.id, evidenceId: confirmations[0].id, expectedVersion: practice.version });
  const reversedReplay = await reversePracticeFunding(db, actorB, { practiceId: practice.id, evidenceId: confirmations[0].id, expectedVersion: practice.version });
  assert.equal(reversedReplay.id, reversed.id);
  history = await db.practiceFundingEvidence.findMany({ where: { practiceId: practice.id }, include: { successor: true }, orderBy: [{ reference: 'asc' }, { sequence: 'asc' }] });
  assert.deepEqual(history.map(({ status }) => status).sort(), ['CONFIRMED', 'CONFIRMED', 'DECLARED', 'DECLARED', 'REVERSED']);
  assert.equal(currentAvailableFunding(history).toFixed(2), '30.00');

  practice = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  await formalizePractice(db, actorB, { practiceId: practice.id, contractId: b.contract.id, signedDocumentId: b.document.id, expectedVersion: practice.version });
  practice = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  await decidePracticeMaterial(db, actorB, { practiceId: practice.id, checklistItemId: b.checklist.id, status: 'NOT_NEEDED', reason: 'Fixture di accredito', expectedVersion: practice.version });
  practice = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  await attestPracticeMaterialsComplete(db, actorB, { practiceId: practice.id, expectedVersion: practice.version });
  practice = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  await assert.rejects(startPractice(db, actorB, { practiceId: practice.id, expectedVersion: practice.version }), (error) => error instanceof PracticeReadinessError && error.code === 'NOT_READY');

  const beforeFault = await footprint(practice.id);
  process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT = '1';
  try {
    await assert.rejects(recordPracticeFunding(db, actorB, { practiceId: practice.id, reference: `FAULT-${suffix}`, amount: '1.00', currency: 'EUR', expectedVersion: practice.version }), (error) => error instanceof PracticeReadinessError && error.code === 'CONFLICT');
  } finally {
    delete process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT;
  }
  assert.deepEqual(await footprint(practice.id), beforeFault);
});

test('positive A path reaches every scoped transition', { skip: !enabled }, async () => {
  const practice = await ensurePractice(a, actorA);
  const declared = await recordPracticeFunding(db, actorA, { practiceId: practice.id, reference: `A-${suffix}`, amount: '50.00', currency: 'EUR', expectedVersion: practice.version });
  const funded = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  const confirmed = await confirmPracticeFunding(db, actorA, { practiceId: practice.id, evidenceId: declared.id, expectedVersion: funded.version });
  const afterFunding = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  await decidePracticeMaterial(db, actorA, { practiceId: practice.id, checklistItemId: a.checklist.id, status: 'NOT_NEEDED', reason: 'Materiale non pertinente alla fixture', expectedVersion: afterFunding.version });
  const v2 = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  await formalizePractice(db, actorA, { practiceId: practice.id, contractId: a.contract.id, signedDocumentId: a.document.id, expectedVersion: v2.version });
  const v3 = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  await attestPracticeMaterialsComplete(db, actorA, { practiceId: practice.id, expectedVersion: v3.version });
  const v4 = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  const started = await startPractice(db, actorA, { practiceId: practice.id, expectedVersion: v4.version });
  assert.ok(started.startedAt);
  assert.equal(started.startedById, ids.userA);
  const historicalEvidence = started.startEvidence;
  const reversal = await reversePracticeFunding(db, actorA, { practiceId: practice.id, evidenceId: confirmed.id, expectedVersion: started.version });
  assert.equal(reversal.status, 'REVERSED');
  const afterReversal = await db.practiceReadiness.findUniqueOrThrow({ where: { id: practice.id } });
  assert.deepEqual(afterReversal.startEvidence, historicalEvidence);
  assert.equal(afterReversal.startedAt?.toISOString(), started.startedAt?.toISOString());
  const afterHistory = await db.practiceFundingEvidence.findMany({ where: { practiceId: practice.id }, include: { successor: true } });
  assert.equal(currentAvailableFunding(afterHistory).toFixed(2), '0.00');
  assert.equal((await footprint(practice.id)).audits, 7);
  assert.equal((await listAccessiblePracticeReadiness(db, manager)).some(({ id }) => id === practice.id), true);
});
