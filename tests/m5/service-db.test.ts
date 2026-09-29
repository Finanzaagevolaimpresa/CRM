import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialServiceCodes, initialServicePlanHash, initialServicePlanSchema, initialServiceStages } from '../../src/lib/initial-service-contract';
import { buildMarkdownDocx } from '../../src/lib/docx-export';
import { EngagementDossierError, mutateInitialServiceWorkflow, getEngagementDossierReadAccess, getVisibleEngagementDossierIds, reviewEngagementDossierVersion, exportApprovedEngagementDossier,
  authorizeEngagementDossierDelivery, recordEngagementDossierDelivery, reviseEngagementDossier } from '../../src/lib/engagement-dossier';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { syntheticUser, syntheticCase } from './fixtures';
const enabled = process.env.M5_DB_CONFIRMED === '1' && assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient(), proof: unknown[] = [];
test.before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.after(async () => {
  if (enabled && process.env.M5_EVIDENCE) { mkdirSync(process.env.M5_EVIDENCE, { recursive: true }); writeFileSync(join(process.env.M5_EVIDENCE, 'five-service-proof.json'), JSON.stringify({ synthetic: true, cases: proof, realDelivery: false }, null, 2)); }
  await db.$disconnect();
});

test('M5 concurrent exports recover a real PostgreSQL serialization abort without duplicate receipts', { skip: !enabled, timeout: 30_000 }, async () => {
  const f = await syntheticCase(db, 'dossier_preanalisi', await actors());
  await configure(f); await finishStages(f);
  await reviewEngagementDossierVersion(db, f.actors.admin, { dossierId: f.dossier.id, versionId: f.version.id,
    versionHash: f.version.contentHash, decision: 'APPROVED', note: 'Synthetic concurrent export qualification.' });
  const marker = await db.client.create({ data: { type: 'persona_fisica', displayName: 'Synthetic serialization barrier' } });
  let arrivals = 0, aborts = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const attempts = [0, 0];
  const connection = (index: number) => ({
    $transaction: async <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel }) => {
      const first = ++attempts[index] === 1;
      try {
        return await db.$transaction(async tx => {
          // Both snapshots read the same synthetic row. Updating it after the
          // export forces PostgreSQL to abort one whole transaction.
          await tx.client.findUniqueOrThrow({ where: { id: marker.id } });
          if (first) { if (++arrivals === 2) release(); await barrier; }
          const result = await operation(tx);
          await tx.client.update({ where: { id: marker.id }, data: { displayName: 'Synthetic export ' + index } });
          return result;
        }, { ...options, timeout: 10_000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2010'].includes(error.code)) aborts += 1;
        throw error;
      }
    },
  }) as unknown as Pick<PrismaClient, '$transaction'>;
  const input = { dossierId: f.dossier.id, versionId: f.version.id, format: 'markdown' };
  const results = await Promise.all([
    exportApprovedEngagementDossier(connection(0), f.actors.operator, input, f.version.content),
    exportApprovedEngagementDossier(connection(1), f.actors.admin, input, f.version.content),
  ]);
  assert.ok(aborts >= 1); assert.ok(attempts.every(count => count >= 1 && count <= 3));
  assert.equal(new Set(results.map(result => result.record.id)).size, 2);
  const records = await db.engagementDossierExport.findMany({ where: { dossierId: f.dossier.id } });
  const audits = await db.auditLog.findMany({ where: { entityId: f.dossier.id, event: 'engagement_dossier_export' } });
  assert.equal(records.length, 2); assert.equal(audits.length, 2);
  for (const record of records) assert.equal(record.artifactHash, createHash('sha256').update(f.version.content).digest('hex'));
  proof.push({ kind: 'concurrent-approved-exports', engine: 'PostgreSQL', aborts, attempts, committedExports: records.length, committedAudits: audits.length });
});

for (const operation of ['export', 'receipt'] as const) test('M5 ' + operation + ' rechecks revocation after an aborted attempt and leaves no partial receipt', { skip: !enabled }, async () => {
  const f = await syntheticCase(db, 'dossier_preanalisi', await actors());
  await configure(f); await finishStages(f);
  await reviewEngagementDossierVersion(db, f.actors.admin, { dossierId: f.dossier.id, versionId: f.version.id,
    versionHash: f.version.contentHash, decision: 'APPROVED', note: 'Synthetic retry revocation qualification.' });
  const authorization = operation === 'receipt' ? await authorizeEngagementDossierDelivery(db, f.actors.admin,
    { dossierId: f.dossier.id, versionId: f.version.id, versionHash: f.version.contentHash,
      recipients: [{ kind: 'CLIENT', name: 'Synthetic recipient', address: 'synthetic@invalid.test', synthetic: true }] }) : null;
  let attempts = 0;
  const wrapped = {
    $transaction: async <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel }) => {
      const first = ++attempts === 1;
      try {
        return await db.$transaction(async tx => {
          const result = await operation(tx);
          if (first) throw new Prisma.PrismaClientKnownRequestError('Injected serialization abort after receipt writes', { code: 'P2034', clientVersion: 'test' });
          return result;
        }, options);
      } catch (error) {
        if (first) await db.internalSession.update({ where: { id: f.actors.operator.sessionId },
          data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE', revokedByUserId: f.actors.admin.userId } });
        throw error;
      }
    },
  } as unknown as Pick<PrismaClient, '$transaction'>;
  await assert.rejects(authorization ? recordEngagementDossierDelivery(wrapped, f.actors.operator,
    { authorizationId: authorization.id, outcome: 'DELIVERED', evidence: { reference: 'SYNTHETIC_RECEIPT', deliveredAt: new Date().toISOString(), synthetic: true } })
    : exportApprovedEngagementDossier(wrapped, f.actors.operator,
      { dossierId: f.dossier.id, versionId: f.version.id, format: 'markdown' }, f.version.content),
  (error: unknown) => error instanceof EngagementDossierError && error.code === 'DENIED');
  assert.equal(attempts, 2);
  assert.equal(await db.engagementDossierExport.count({ where: { dossierId: f.dossier.id } }), 0);
  if (authorization) assert.equal(await db.engagementDossierDeliveryReceipt.count({ where: { authorizationId: authorization.id } }), 0);
  assert.equal(await db.auditLog.count({ where: { entityId: f.dossier.id, event: authorization ? 'engagement_dossier_delivery_record' : 'engagement_dossier_export' } }), 0);
  proof.push({ kind: operation + '-retry-revocation', injectedAbort: true, attempts, committedReceipts: 0, committedAudits: 0 });
});
for (const kind of ['authorization', 'receipt'] as const) test('M5 ' + kind + ' recovers a real serialization abort and commits one idempotent receipt', { skip: !enabled, timeout: 30_000 }, async () => {
  const f = await syntheticCase(db, 'dossier_preanalisi', await actors());
  await configure(f); await finishStages(f);
  await reviewEngagementDossierVersion(db, f.actors.admin, { dossierId: f.dossier.id, versionId: f.version.id,
    versionHash: f.version.contentHash, decision: 'APPROVED', note: 'Synthetic authorization retry qualification.' });
  const marker = await db.client.create({ data: { type: 'persona_fisica', displayName: 'Synthetic authorization barrier' } });
  let attempts = 0, aborts = 0;
  const wrapped = {
    $transaction: async <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel }) => {
      const first = ++attempts === 1;
      try {
        return await db.$transaction(async tx => {
          await tx.client.findUniqueOrThrow({ where: { id: marker.id } });
          const result = await operation(tx);
          // A committed update after this snapshot makes the following update
          // abort in PostgreSQL, rolling back authorization and audit together.
          if (first) await db.client.update({ where: { id: marker.id }, data: { displayName: 'Synthetic concurrent update' } });
          await tx.client.update({ where: { id: marker.id }, data: { displayName: 'Synthetic authorization complete' } });
          return result;
        }, { ...options, timeout: 10_000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') aborts += 1;
        throw error;
      }
    },
  } as unknown as Pick<PrismaClient, '$transaction'>;
  const input = { dossierId: f.dossier.id, versionId: f.version.id, versionHash: f.version.contentHash,
    recipients: [{ kind: 'CLIENT', name: 'Synthetic recipient', address: 'synthetic@invalid.test', synthetic: true }] };
  const authorization = kind === 'receipt' ? await authorizeEngagementDossierDelivery(db, f.actors.admin, input) : null;
  const delivery = { authorizationId: authorization?.id, outcome: 'DELIVERED',
    evidence: { reference: 'SYNTHETIC_RECEIPT', deliveredAt: new Date().toISOString(), synthetic: true } };
  const invoke = (connection: Pick<PrismaClient, '$transaction'>) => authorization
    ? recordEngagementDossierDelivery(connection, f.actors.operator, delivery)
    : authorizeEngagementDossierDelivery(connection, f.actors.admin, input);
  const receipt = await invoke(wrapped);
  assert.equal(attempts, 2); assert.equal(aborts, 1);
  const repeated = await invoke(db);
  assert.equal(repeated.id, receipt.id);
  assert.equal(await db.engagementDossierDeliveryAuthorization.count({ where: { dossierId: f.dossier.id } }), 1);
  if (authorization) assert.equal(await db.engagementDossierDeliveryReceipt.count({ where: { authorizationId: authorization.id } }), 1);
  assert.equal(await db.auditLog.count({ where: { entityId: f.dossier.id, event: authorization ? 'engagement_dossier_delivery_record' : 'engagement_dossier_delivery_authorize' } }), 1);
  proof.push({ kind: kind + '-retry', engine: 'PostgreSQL', aborts, attempts, committedReceipts: 1, committedAudits: 1, idempotent: true });
});

async function actors() { return { operator: await syntheticUser(db, 'consulente', 'Responsabile M5'), admin: await syntheticUser(db, 'admin', 'Admin M5'),
  human1: await syntheticUser(db, 'revisore', 'Revisore umano 1'), human2: await syntheticUser(db, 'revisore', 'Revisore umano 2') }; }
type Fixture = Awaited<ReturnType<typeof syntheticCase>>;
async function configure(f: Fixture, dual = false) {
  return mutateInitialServiceWorkflow(db, f.actors.admin, { dossierId: f.dossier.id, intent: 'configure', value: {
    expectedPlanHash: null, expectedVersionId: f.version.id, responsibleUserId: f.actors.operator.userId,
    humanReviewerIds: dual ? [f.actors.human1.userId, f.actors.human2.userId] : [f.actors.human1.userId],
    outputKind: dual ? 'BUSINESS_PLAN' : 'REPORT', numericAnalysis: f.code === 'audit_ai_bancabilita', supportingAgents: dual ? ['A07'] : [],
  } });
}
async function finishStages(f: Fixture) {
  const state = (await getEngagementDossierReadAccess(db, f.actors.admin, f.dossier.id))!.engagementHistory.initialService!;
  const plan = state.plan!;
  for (const stage of initialServiceStages(plan).stages) {
    const person = stage === 'HUMAN_1' ? f.actors.human1 : stage === 'HUMAN_2' ? f.actors.human2 : f.actors.operator;
    const decision = stage === 'Q02' && !initialServiceStages(plan).q02Required ? 'NOT_APPLICABLE' : 'PASS';
    await mutateInitialServiceWorkflow(db, person, { dossierId: f.dossier.id, intent: 'review', value: {
      expectedPlanHash: initialServicePlanHash(plan), expectedVersionId: f.version.id, stage, decision,
      note: 'Evidenza sintetica motivata; nessuna verifica di misura o attività reale.',
      reference: 'SYNTHETIC_' + stage, agentVersionReference: stage.startsWith('HUMAN_') || decision === 'NOT_APPLICABLE' ? null : 'SYNTHETIC_VERSION',
      documentVersionId: stage.startsWith('HUMAN_') ? null : f.documentVersion.id,
    } });
  }
}
test('M5 reviewer assignment opens only the designated dossier and revocation takes effect immediately', { skip: !enabled }, async () => {
  const f = await syntheticCase(db, 'dossier_preanalisi', await actors());
  assert.equal(await getEngagementDossierReadAccess(db, f.actors.human1, f.dossier.id), null);
  const plan = await configure(f);
  assert.ok(await getEngagementDossierReadAccess(db, f.actors.human1, f.dossier.id));
  assert.deepEqual([...(await getVisibleEngagementDossierIds(db, f.actors.human1, [f.dossier.id]))], [f.dossier.id]);
  assert.equal(await getEngagementDossierReadAccess(db, f.actors.human2, f.dossier.id), null);
  await db.userPermissionOverride.create({ data: { userId: f.actors.human1.userId, permission: 'dossier.write', allowed: true } });
  await assert.rejects(reviseEngagementDossier(db, f.actors.human1, { dossierId: f.dossier.id, expectedVersionId: f.version.id,
    title: 'Unauthorized producer change', content: f.version.content }), (error: unknown) => error instanceof EngagementDossierError && error.code === 'DENIED');
  const before = await db.engagementDossierVersion.count({ where: { dossierId: f.dossier.id } });
  assert.equal(before, 1);
  await db.document.update({ where: { id: f.document.id }, data: { containsSensitiveData: true } });
  await db.userPermissionOverride.create({ data: { userId: f.actors.human1.userId, permission: 'document.sensitive.read', allowed: false } });
  assert.equal(await getEngagementDossierReadAccess(db, f.actors.human1, f.dossier.id), null);
  await db.document.update({ where: { id: f.document.id }, data: { containsSensitiveData: false } });
  const currentPlan = initialServicePlanSchema.parse(plan);
  await mutateInitialServiceWorkflow(db, f.actors.admin, { dossierId: f.dossier.id, intent: 'configure', value: {
    expectedPlanHash: initialServicePlanHash(currentPlan), expectedVersionId: f.version.id, responsibleUserId: f.actors.operator.userId,
    humanReviewerIds: [f.actors.human2.userId], outputKind: 'REPORT', numericAnalysis: false, supportingAgents: [],
  } });
  assert.equal(await getEngagementDossierReadAccess(db, f.actors.human1, f.dossier.id), null);
  assert.ok(await getEngagementDossierReadAccess(db, f.actors.human2, f.dossier.id));
  await db.clientReadGrant.updateMany({ where: { userId: f.actors.human2.userId, clientId: f.client.id }, data: { active: false } });
  assert.equal(await getEngagementDossierReadAccess(db, f.actors.human2, f.dossier.id), null);
});
for (const code of initialServiceCodes) test('M5 full synthetic service: ' + code, { skip: !enabled }, async () => {
  const f = await syntheticCase(db, code, await actors());
  await assert.rejects(reviewEngagementDossierVersion(db, f.actors.admin, { dossierId: f.dossier.id, versionId: f.version.id, versionHash: f.version.contentHash, decision: 'APPROVED', note: 'Missing reviews must block.' }));
  await configure(f); await finishStages(f);
  await reviewEngagementDossierVersion(db, f.actors.admin, { dossierId: f.dossier.id, versionId: f.version.id, versionHash: f.version.contentHash, decision: 'APPROVED', note: 'Exact synthetic output approved.' });
  const docx = buildMarkdownDocx({ title: f.version.title, content: f.version.content, exportedAt: new Date(), logo: readFileSync('public/logo-fai.png') });
  const record = await exportApprovedEngagementDossier(db, f.actors.operator, { dossierId: f.dossier.id, versionId: f.version.id, format: 'docx' }, docx);
  assert.equal(record.record.artifactHash, createHash('sha256').update(docx).digest('hex'));
  const decoded = JSON.parse(execFileSync('python3', ['-I','-S','-c', 'import sys,io,zipfile,hashlib,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps({"logo":hashlib.sha256(z.read("word/media/logo-fai.png")).hexdigest(),"disclaimer":"Non eroghiamo finanziamenti." in z.read("word/document.xml").decode()}))'], { input: docx, encoding: 'utf8' }));
  assert.equal(decoded.logo, createHash('sha256').update(readFileSync('public/logo-fai.png')).digest('hex')); assert.equal(decoded.disclaimer, true);
  const authorization = await authorizeEngagementDossierDelivery(db, f.actors.admin, { dossierId: f.dossier.id, versionId: f.version.id, versionHash: f.version.contentHash,
    recipients: [{ kind: 'CLIENT', name: 'Cliente sintetico M5', address: 'synthetic@invalid.test', synthetic: true }] });
  const receipt = await recordEngagementDossierDelivery(db, f.actors.operator, { authorizationId: authorization.id, outcome: 'DELIVERED',
    evidence: { reference: 'SYNTHETIC_MANUAL_RECEIPT', deliveredAt: new Date().toISOString(), synthetic: true } });
  proof.push({ code, dossierId: f.dossier.id, versionHash: f.version.contentHash, artifactHash: record.record.artifactHash, authorizationId: authorization.id, receiptId: receipt.id });
  await reviseEngagementDossier(db, f.actors.operator, { dossierId: f.dossier.id, expectedVersionId: f.version.id, title: f.version.title, content: f.version.content + '\nRevisione sintetica successiva.' });
  await assert.rejects(exportApprovedEngagementDossier(db, f.actors.operator, { dossierId: f.dossier.id, versionId: f.version.id, format: 'docx' }, docx));
});
test('M5 dual review requires two live human identities and revocation blocks later export', { skip: !enabled }, async () => {
  const f = await syntheticCase(db, 'dossier_preanalisi', await actors());
  await configure(f, true); await finishStages(f);
  const state = (await getEngagementDossierReadAccess(db, f.actors.admin, f.dossier.id))!.engagementHistory.initialService!;
  const humans = state.active.filter(row => row.review.stage.startsWith('HUMAN_')).map(row => row.review.actorId);
  assert.equal(new Set(humans).size, 2); assert.ok(!humans.includes(f.version.createdById));
  await reviewEngagementDossierVersion(db, f.actors.admin, { dossierId: f.dossier.id, versionId: f.version.id, versionHash: f.version.contentHash,
    decision: 'APPROVED', note: 'Two distinct synthetic human reviews completed.' });
  await db.user.update({ where: { id: f.actors.human2.userId }, data: { active: false } });
  await assert.rejects(exportApprovedEngagementDossier(db, f.actors.operator, { dossierId: f.dossier.id, versionId: f.version.id, format: 'markdown' }, f.version.content));
  assert.equal(await db.engagementDossierExport.count({ where: { dossierId: f.dossier.id } }), 0);
});

test('M5 permission, atomic failure, concurrent stage, actual bytes, dual human gate and revocation', { skip: !enabled }, async () => {
  const f = await syntheticCase(db, 'dossier_preanalisi', await actors());
  const state = () => getEngagementDossierReadAccess(db, f.actors.admin, f.dossier.id);
  const before = await db.auditLog.count({ where: { entityId: f.dossier.id } });
  const bad = { dossierId: f.dossier.id, intent: 'configure', value: { expectedPlanHash: null, expectedVersionId: f.version.id, responsibleUserId: f.actors.operator.userId,
    humanReviewerIds: [f.actors.human1.userId, f.actors.human1.userId], outputKind: 'BUSINESS_PLAN', numericAnalysis: true, supportingAgents: ['A07'] } };
  await assert.rejects(mutateInitialServiceWorkflow(db, f.actors.admin, bad));
  await assert.rejects(mutateInitialServiceWorkflow(db, { ...f.actors.operator, role: 'admin' }, bad));
  bad.value.humanReviewerIds = [f.actors.human1.userId, f.actors.human2.userId];
  await assert.rejects(mutateInitialServiceWorkflow(db, f.actors.admin, bad, { failAudit: true }));
  assert.equal(await db.auditLog.count({ where: { entityId: f.dossier.id } }), before);
  await configure(f, true);
  const plan = (await state())!.engagementHistory.initialService!.plan!;
  const review = { dossierId: f.dossier.id, intent: 'review', value: { expectedPlanHash: initialServicePlanHash(plan), expectedVersionId: f.version.id, stage: 'A00', decision: 'PASS',
    note: 'Synthetic evidence; no real activities or agent execution.', reference: 'SYNTHETIC_A00', agentVersionReference: 'SYNTHETIC_VERSION', documentVersionId: f.documentVersion.id } };
  await assert.rejects(mutateInitialServiceWorkflow(db, f.actors.operator, review, { readDocument: async () => Buffer.from('wrong actual bytes') }));
  await assert.rejects(mutateInitialServiceWorkflow(db, f.actors.operator, review, { failAudit: true }));
  const concurrent = await Promise.allSettled([mutateInitialServiceWorkflow(db, f.actors.operator, review), mutateInitialServiceWorkflow(db, f.actors.operator, review)]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  await db.internalSession.update({ where: { id: f.actors.operator.sessionId }, data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE', revokedByUserId: f.actors.admin.userId } });
  await assert.rejects(mutateInitialServiceWorkflow(db, f.actors.operator, { ...review, value: { ...review.value, stage: 'PRODUCER' } }));
  assert.equal((await state())!.engagementHistory.initialService!.active.length, 1);
});


test('M5 a rejected version stays blocked across unchanged and reassigned plans until a new content version', { skip: !enabled }, async () => {
  const f = await syntheticCase(db, 'dossier_preanalisi', await actors());
  await configure(f, true);
  const state = async () => (await getEngagementDossierReadAccess(db, f.actors.admin, f.dossier.id))!.engagementHistory.initialService!;
  const initial = await state(), plan = initial.plan!;
  for (const stage of initialServiceStages(plan).stages) {
    const human = stage === 'HUMAN_1';
    await mutateInitialServiceWorkflow(db, human ? f.actors.human1 : f.actors.operator, { dossierId: f.dossier.id, intent: 'review', value: {
      expectedPlanHash: initial.planHash, expectedVersionId: f.version.id, stage, decision: human ? 'REQUEST_CHANGES' : 'PASS',
      note: 'Synthetic review requires corrected content before another review cycle.',
      reference: 'SYNTHETIC_RECONFIGURE_' + stage, agentVersionReference: human ? null : 'SYNTHETIC_VERSION',
      documentVersionId: human ? null : f.documentVersion.id,
    } });
    if (human) break;
  }
  const rejected = await state(), originalReviews = rejected.allReviews;
  assert.equal(rejected.assessment?.blocked, 'CHANGES_REQUIRED');
  for (const humanReviewerIds of [[f.actors.human1.userId, f.actors.human2.userId], [f.actors.human2.userId, f.actors.human1.userId]]) {
    const prior = await state();
    await mutateInitialServiceWorkflow(db, f.actors.admin, { dossierId: f.dossier.id, intent: 'configure', value: {
      expectedPlanHash: prior.planHash, expectedVersionId: f.version.id, responsibleUserId: f.actors.operator.userId,
      humanReviewerIds, outputKind: 'BUSINESS_PLAN', numericAnalysis: false, supportingAgents: ['A07'],
    } });
    const changed = await state();
    assert.notEqual(changed.planHash, prior.planHash);
    assert.deepEqual(changed.allReviews, originalReviews);
    assert.equal(changed.assessment?.ready, false);
    assert.equal(changed.assessment?.blocked, 'CHANGES_REQUIRED');
    assert.equal(changed.assessment?.nextStage, null);
    await assert.rejects(mutateInitialServiceWorkflow(db, f.actors.operator, { dossierId: f.dossier.id, intent: 'review', value: {
      expectedPlanHash: changed.planHash, expectedVersionId: f.version.id, stage: 'A00', decision: 'PASS',
      note: 'A new plan must not bypass the previous request for changes.', reference: 'SYNTHETIC_BLOCKED_A00',
      agentVersionReference: 'SYNTHETIC_VERSION', documentVersionId: f.documentVersion.id,
    } }));
    await assert.rejects(reviewEngagementDossierVersion(db, f.actors.admin, { dossierId: f.dossier.id, versionId: f.version.id,
      versionHash: f.version.contentHash, decision: 'APPROVED', note: 'Unchanged rejected content must stay blocked.' }));
  }
  const version = await reviseEngagementDossier(db, f.actors.operator, { dossierId: f.dossier.id, expectedVersionId: f.version.id,
    title: f.version.title, content: f.version.content + '\nCorrezione sintetica richiesta dai revisori.' });
  const revised = await state();
  assert.notEqual(version.id, f.version.id); assert.notEqual(version.contentHash, f.version.contentHash);
  assert.equal(revised.assessment?.blocked, 'REVIEW_REQUIRED');
  assert.equal(revised.assessment?.nextStage, 'A00'); assert.deepEqual(revised.allReviews, originalReviews);
  await mutateInitialServiceWorkflow(db, f.actors.operator, { dossierId: f.dossier.id, intent: 'review', value: {
    expectedPlanHash: revised.planHash, expectedVersionId: version.id, stage: 'A00', decision: 'PASS',
    note: 'A genuinely new content version starts a new review cycle.', reference: 'SYNTHETIC_REVISED_A00',
    agentVersionReference: 'SYNTHETIC_VERSION', documentVersionId: f.documentVersion.id,
  } });
  assert.equal((await state()).assessment?.nextStage, 'PRODUCER');
});
