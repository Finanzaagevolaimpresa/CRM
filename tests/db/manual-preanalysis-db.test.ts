import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AuthSession } from '../../src/lib/auth';
import { createManualPreAnalysisRecord, ManualPreAnalysisError, updateManualPreAnalysisRecord } from '../../src/lib/manual-preanalysis-service';
import { revokeInternalSession } from '../../src/lib/internal-session-registry';
import { getPreAnalysisReadAccess } from '../../src/lib/read-access';
import { prisma } from '../../src/lib/prisma';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from './ai-orchestrator-db-test-guard';

const enabled = assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const prefix = `pre-r02-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const foreignId = `${prefix}-foreign`;
const clientId = `${prefix}-client`;
const otherClientId = `${prefix}-other-client`;
const projectId = `${prefix}-project`;
const otherProjectId = `${prefix}-other-project`;
const companyId = `${prefix}-company`;
const otherCompanyId = `${prefix}-other-company`;

function actor(userId: string): AuthSession { return { userId, role: 'consulente', active: true, permissionOverrides: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 }; }
async function expectDenied(operation: Promise<unknown>) { await assert.rejects(operation, (error: unknown) => error instanceof ManualPreAnalysisError && error.code === 'DENIED'); }

test.before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(prisma);
  await prisma.user.createMany({ data: [
    { id: ownerId, email: `${ownerId}@invalid.test`, name: 'Consulente sintetico', passwordHash: 'synthetic-not-login', role: 'consulente' },
    { id: foreignId, email: `${foreignId}@invalid.test`, name: 'Estraneo sintetico', passwordHash: 'synthetic-not-login', role: 'consulente' },
  ] });
  await prisma.client.createMany({ data: [
    { id: clientId, type: 'societa', displayName: 'Cliente sintetico', consultantId: ownerId },
    { id: otherClientId, type: 'societa', displayName: 'Altro cliente sintetico', consultantId: foreignId },
  ] });
  await prisma.project.createMany({ data: [
    { id: projectId, clientId, title: 'Progetto sintetico', consultantId: ownerId },
    { id: otherProjectId, clientId: otherClientId, title: 'Altro progetto sintetico', consultantId: foreignId },
  ] });
});

test.after(async () => {
  if (enabled) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { startsWith: prefix } }, { entityId: { startsWith: prefix } }] } });
    await prisma.userPermissionOverride.deleteMany({ where: { userId: { startsWith: prefix } } });
    await prisma.preAnalysis.deleteMany({ where: { clientId: { in: [clientId, otherClientId] } } });
    assert.equal(await prisma.preAnalysis.count({ where: { clientId: { in: [clientId, otherClientId] } } }), 0);
    await prisma.company.deleteMany({ where: { id: { in: [companyId, otherCompanyId] } } });
    await prisma.project.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.client.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: prefix } } });
  }
  await prisma.$disconnect();
});

test('PostgreSQL: create/update, scope denial, no-op, state and optimistic conflict', { skip: !enabled }, async () => {
  const owner = actor(ownerId);
  const created = await createManualPreAnalysisRecord(prisma, owner, { clientId, projectId, internalSummary: 'Sintesi iniziale', scenarioA: 'A', scenarioB: 'B', blockingConditions: 'Blocco', requiredDocuments: 'Documento' });
  assert.equal((await getPreAnalysisReadAccess(owner, created.id))?.preAnalysis.id, created.id);
  assert.equal(await getPreAnalysisReadAccess(actor(foreignId), created.id), null);
  await expectDenied(createManualPreAnalysisRecord(prisma, owner, { clientId, projectId: otherProjectId }));
  await expectDenied(createManualPreAnalysisRecord(prisma, actor(foreignId), { clientId, projectId }));
  const updated = await updateManualPreAnalysisRecord(prisma, owner, { id: created.id, version: created.updatedAt, internalSummary: 'Sintesi aggiornata', scenarioA: 'A', scenarioB: 'B', blockingConditions: 'Blocco', requiredDocuments: 'Documento' });
  assert.equal(updated.changed, true);
  const auditCount = await prisma.auditLog.count({ where: { entityId: created.id } });
  const noOp = await updateManualPreAnalysisRecord(prisma, owner, { id: created.id, version: updated.record.updatedAt, internalSummary: 'Sintesi aggiornata', scenarioA: 'A', scenarioB: 'B', blockingConditions: 'Blocco', requiredDocuments: 'Documento' });
  assert.equal(noOp.changed, false);
  assert.equal(await prisma.auditLog.count({ where: { entityId: created.id } }), auditCount);
  await assert.rejects(updateManualPreAnalysisRecord(prisma, owner, { id: created.id, version: created.updatedAt, internalSummary: 'stale' }), (error: unknown) => error instanceof ManualPreAnalysisError && error.code === 'CONFLICT');
  const concurrent = await createManualPreAnalysisRecord(prisma, owner, { clientId, projectId, internalSummary: 'Concorrenza' });
  const races = await Promise.allSettled([
    updateManualPreAnalysisRecord(prisma, owner, { id: concurrent.id, version: concurrent.updatedAt, internalSummary: 'Scheda uno' }),
    updateManualPreAnalysisRecord(prisma, owner, { id: concurrent.id, version: concurrent.updatedAt, internalSummary: 'Scheda due' }),
  ]);
  assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(races.filter((result) => result.status === 'rejected').length, 1);
  await prisma.preAnalysis.update({ where: { id: created.id }, data: { status: 'da_revisionare' } });
  await assert.rejects(updateManualPreAnalysisRecord(prisma, owner, { id: created.id, version: (await prisma.preAnalysis.findUniqueOrThrow({ where: { id: created.id } })).updatedAt, internalSummary: 'Sintesi aggiornata' }), (error: unknown) => error instanceof ManualPreAnalysisError && error.code === 'CONFLICT');
});

test('PostgreSQL: permission/context revocation and linked deletion are rechecked in transaction', { skip: !enabled }, async () => {
  const record = await createManualPreAnalysisRecord(prisma, actor(ownerId), { clientId, projectId, internalSummary: 'Revoca' });
  await prisma.userPermissionOverride.create({ data: { userId: ownerId, permission: 'dossier.read', allowed: false } });
  await expectDenied(updateManualPreAnalysisRecord(prisma, actor(ownerId), { id: record.id, version: record.updatedAt, internalSummary: 'Negato' }));
  await prisma.userPermissionOverride.deleteMany({ where: { userId: ownerId, permission: 'dossier.read' } });
  await prisma.project.update({ where: { id: projectId }, data: { consultantId: foreignId } });
  const stillAuthorized = await updateManualPreAnalysisRecord(prisma, actor(ownerId), { id: record.id, version: record.updatedAt, internalSummary: 'Autorità cliente valida' });
  assert.equal(stillAuthorized.record.internalSummary, 'Autorità cliente valida');
  await prisma.client.update({ where: { id: clientId }, data: { consultantId: foreignId } });
  const auditBeforeDenied = await prisma.auditLog.count({ where: { entityId: record.id } });
  await expectDenied(updateManualPreAnalysisRecord(prisma, actor(ownerId), { id: record.id, version: stillAuthorized.record.updatedAt, internalSummary: 'Negato' }));
  assert.equal((await prisma.preAnalysis.findUniqueOrThrow({ where: { id: record.id } })).internalSummary, 'Autorità cliente valida');
  assert.equal(await prisma.auditLog.count({ where: { entityId: record.id } }), auditBeforeDenied);
  await prisma.client.update({ where: { id: clientId }, data: { consultantId: ownerId } });
  await prisma.project.update({ where: { id: projectId }, data: { consultantId: ownerId } });
  await prisma.company.createMany({ data: [{ id: companyId, clientId, name: 'Società sintetica' }, { id: otherCompanyId, clientId: otherClientId, name: 'Società incoerente sintetica' }] });
  await prisma.project.update({ where: { id: projectId }, data: { companyId } });
  await prisma.company.update({ where: { id: companyId }, data: { deletedAt: new Date() } });
  await expectDenied(createManualPreAnalysisRecord(prisma, actor(ownerId), { clientId, projectId, internalSummary: 'Company cancellata' }));
  await expectDenied(updateManualPreAnalysisRecord(prisma, actor(ownerId), { id: record.id, version: stillAuthorized.record.updatedAt, internalSummary: 'Autorità cliente valida' }));
  await prisma.project.update({ where: { id: projectId }, data: { companyId: otherCompanyId } });
  await expectDenied(createManualPreAnalysisRecord(prisma, actor(ownerId), { clientId, projectId, internalSummary: 'Company incoerente' }));
  await prisma.project.update({ where: { id: projectId }, data: { companyId: null } });
  await prisma.company.update({ where: { id: companyId }, data: { deletedAt: null } });
  const sessionId = randomUUID();
  await prisma.internalSession.create({ data: { id: sessionId, userId: ownerId, tokenDigest: randomBytes(32), expiresAt: new Date('2099-01-01T00:00:00.000Z') } });
  const sessionActor = { ...actor(ownerId), sessionId };
  const sessionRecord = await createManualPreAnalysisRecord(prisma, sessionActor, { clientId, projectId, internalSummary: 'Sessione viva' });
  await prisma.$transaction((tx) => revokeInternalSession(tx, sessionId, 'INTERNAL_SINGLE', ownerId));
  await expectDenied(updateManualPreAnalysisRecord(prisma, sessionActor, { id: sessionRecord.id, version: sessionRecord.updatedAt, internalSummary: 'Sessione revocata' }));
  assert.equal((await prisma.preAnalysis.findUniqueOrThrow({ where: { id: sessionRecord.id } })).internalSummary, 'Sessione viva');
  await prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
  await expectDenied(updateManualPreAnalysisRecord(prisma, actor(ownerId), { id: record.id, version: stillAuthorized.record.updatedAt, internalSummary: 'Negato' }));
  await prisma.project.update({ where: { id: projectId }, data: { consultantId: ownerId, deletedAt: null } });
});

test('PostgreSQL: legacy expiry crossed during locks denies create and update atomically', { skip: !enabled }, async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const legacy = { ...actor(ownerId), expiresAt };
  const crossingClock = () => {
    let reads = 0;
    return { runtime: { nowSeconds: () => (++reads === 1 ? expiresAt - 1 : expiresAt) }, reads: () => reads };
  };
  const createClock = crossingClock();
  const recordsBefore = await prisma.preAnalysis.count({ where: { clientId } });
  const createAuditsBefore = await prisma.auditLog.count({ where: { actorId: ownerId, event: 'preanalysis_create' } });
  await expectDenied(createManualPreAnalysisRecord(prisma, legacy, { clientId, projectId, internalSummary: 'Non deve esistere' }, createClock.runtime));
  assert.equal(createClock.reads(), 2);
  assert.equal(await prisma.preAnalysis.count({ where: { clientId } }), recordsBefore);
  assert.equal(await prisma.auditLog.count({ where: { actorId: ownerId, event: 'preanalysis_create' } }), createAuditsBefore);

  const valid = await createManualPreAnalysisRecord(prisma, legacy, { clientId, projectId, internalSummary: 'Legacy valida' }, { nowSeconds: () => expiresAt - 1 });
  const updateAuditsBefore = await prisma.auditLog.count({ where: { entityId: valid.id } });
  const updateClock = crossingClock();
  await expectDenied(updateManualPreAnalysisRecord(prisma, legacy, { id: valid.id, version: valid.updatedAt, internalSummary: 'Non deve essere salvata' }, updateClock.runtime));
  assert.equal(updateClock.reads(), 2);
  assert.equal((await prisma.preAnalysis.findUniqueOrThrow({ where: { id: valid.id } })).internalSummary, 'Legacy valida');
  assert.equal(await prisma.auditLog.count({ where: { entityId: valid.id } }), updateAuditsBefore);
});

test('PostgreSQL: audit faults roll back create and update completely', { skip: !enabled }, async () => {
  const marker = `${prefix}-audit-fault`;
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "${marker}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event IN ('preanalysis_create','preanalysis_manual_update') AND NEW."actorId" = '${ownerId}' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "${marker}" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "${marker}"()`);
  try {
    const before = await prisma.preAnalysis.count({ where: { clientId } });
    await assert.rejects(createManualPreAnalysisRecord(prisma, actor(ownerId), { clientId, projectId, internalSummary: 'Rollback create' }));
    assert.equal(await prisma.preAnalysis.count({ where: { clientId } }), before);
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${marker}" ON "AuditLog"`);
    const record = await createManualPreAnalysisRecord(prisma, actor(ownerId), { clientId, projectId, internalSummary: 'Prima' });
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${marker}" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "${marker}"()`);
    await assert.rejects(updateManualPreAnalysisRecord(prisma, actor(ownerId), { id: record.id, version: record.updatedAt, internalSummary: 'Dopo' }));
    assert.equal((await prisma.preAnalysis.findUniqueOrThrow({ where: { id: record.id } })).internalSummary, 'Prima');
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${marker}" ON "AuditLog"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${marker}"()`);
  }
});
