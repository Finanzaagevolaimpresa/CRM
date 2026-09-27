import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialServiceCodes, initialServicePlanHash, initialServiceStages } from '../../src/lib/initial-service-contract';
import { buildMarkdownDocx } from '../../src/lib/docx-export';
import { mutateInitialServiceWorkflow, getEngagementDossierReadAccess, reviewEngagementDossierVersion, exportApprovedEngagementDossier,
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
