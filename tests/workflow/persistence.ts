import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { leadProof } from '../selective-leads/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { syntheticIntakeFixture } from './fixture';
import { assignCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { readWorkflowAdministration, saveWorkflowRule, saveWorkflowTemplate, testWorkflowRule } from '../../src/lib/workflow-automations';
import { enrollSyntheticWorkflowReceipt, readLeadWorkflowExecutions, readSyntheticWorkflowLeadSetup, reconcileSyntheticWorkflowExecution,
  runSyntheticWorkflowEnrollment, stopPendingWorkflowExecutions } from '../../src/lib/workflow-executions';

const enabled = assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient();
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person, setter: Person, other: Person;
let intakeFixture: Awaited<ReturnType<typeof syntheticIntakeFixture>>;

before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert.equal(process.env.APP_ENV, 'test');
  admin = await syntheticPerson(db, 'Admin automazioni sintetico', 'admin');
  setter = await syntheticPerson(db, 'Setter automazioni sintetica', 'commerciale');
  other = await syntheticPerson(db, 'Altro referente sintetico', 'commerciale');
  const keyVersion = Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), keyDigest = privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!);
  const present = await db.applicationKeyVersion.findFirst({ where: { purpose: 'PRIVILEGED_STEP_UP', status: 'ACTIVE' } });
  if (present) assert.deepEqual(present.keyDigest, keyDigest);
  else await db.applicationKeyVersion.create({ data: { purpose: 'PRIVILEGED_STEP_UP', version: keyVersion, keyDigest, status: 'ACTIVE', activatedAt: new Date() } });
  intakeFixture = await syntheticIntakeFixture(db, admin.user.id);
});
after(async () => { await db.$disconnect(); });

async function rule() {
  const confirmation = { id: randomUUID(), familyId: randomUUID(), expectedVersion: 0, name: 'Conferma sintetica', purpose: 'CONFIRMATION',
    subject: 'Ricevuta per {{companyName}}', body: 'Buongiorno {{firstName}}.', state: 'PUBLISHED', authorizationReference: 'SYNTHETIC_TEST_ONLY' };
  const followup = { ...confirmation, id: randomUUID(), familyId: randomUUID(), name: 'Sollecito sintetico', purpose: 'FOLLOW_UP' };
  await saveWorkflowTemplate(db, admin.session, confirmation, leadProof(admin));
  await saveWorkflowTemplate(db, admin.session, followup, leadProof(admin));
  const input = { id: randomUUID(), expectedVersion: 0, name: 'Sequenza sintetica', event: 'LEAD_ACCEPTED', state: 'TEST_READY', delayMinutes: 60,
    configuration: { kind: 'INDIVIDUAL', action: 'EMAIL', confirmationTemplateId: confirmation.id, followupTemplateId: followup.id,
      requireAssociated: true, stopOnReply: true, stopOnAppointment: true, newsletterAt: null, recipientIds: [] } };
  await saveWorkflowRule(db, admin.session, input, leadProof(admin));
  return { input, confirmation, followup };
}
async function received(review = false) {
  const intake = await intakeFixture.receive(review);
  if (intake.projection.leadId) await assignTo(intake.projection.leadId, setter.user.id);
  return intake;
}
async function assignTo(leadId: string, targetUserId: string) {
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId } });
  return assignCommercialLeadInboxItem(db, { leadId, targetUserId, expectedInboxVersion: item.version,
    actor: { userId: admin.user.id, sessionId: admin.session.sessionId!, requireManualAdmin: true } });
}

test('published versions, admin-only rules and stored qualification', { skip: !enabled }, async context => {
  context.diagnostic(`Identity projection: ${intakeFixture.projectionMode}; gateway receipt: ${intakeFixture.gatewayReceiptMode}.`);
  const fixture = await rule();
  await assert.rejects(saveWorkflowRule(db, setter.session, { ...fixture.input, id: randomUUID() }, leadProof(setter)));
  const tested = await testWorkflowRule(db, admin.session, { id: fixture.input.id, expectedVersion: 1 }); assert(tested.passed);
  assert.equal(await db.workflowAutomationTest.count({ where: { id: tested.id } }), 1);
  await saveWorkflowTemplate(db, admin.session, { ...fixture.confirmation, id: randomUUID(), expectedVersion: 1, body: 'New synthetic text' }, leadProof(admin));
  assert.equal((await db.workflowEmailTemplate.findUniqueOrThrow({ where: { id: fixture.confirmation.id } })).body, fixture.confirmation.body);
  await assert.rejects(db.workflowEmailTemplate.update({ where: { id: fixture.confirmation.id }, data: { body: 'rewritten history' } }));
  await assert.rejects(db.workflowAutomationTest.update({ where: { id: tested.id }, data: { result: { passed: false } } }));
  await assert.rejects(readWorkflowAdministration(db, setter.session));
});
test('receipt, enrollment and acceptance remain unique after concurrent replay; reassignment changes read access', { skip: !enabled }, async () => {
  const fixture = await rule(), intake = await received();
  assert.equal(intake.projection.state, 'PROJECTED_NEW');
  const setup = await readSyntheticWorkflowLeadSetup(db, admin.session, intake.projection.leadId!);
  assert(setup); assert(setup.rules.some(row => row.id === fixture.input.id));
  assert(setup.receipts.some(row => row.id === intake.receipt.id));
  const results = await Promise.all([0, 1].map(() => enrollSyntheticWorkflowReceipt(db, admin.session, { automationId: fixture.input.id, receiptId: intake.receipt.id })));
  assert.equal(results[0].id, results[1].id); assert.equal(await db.workflowEnrollment.count({ where: { sourceReceiptId: intake.receipt.id } }), 1);
  const enrollmentId = results[0].id;
  const jobs = await db.workflowExecution.findMany({ where: { enrollmentId }, orderBy: { dueAt: 'asc' } });
  const now = jobs[0].dueAt.toISOString();
  const sends = await Promise.all([0, 1].map(() => runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId, now })));
  assert.equal(sends.reduce((sum, value) => sum + value.executed, 0), 1);
  const confirmation = await db.workflowExecution.findUniqueOrThrow({ where: { id: jobs[0].id } });
  assert.equal(confirmation.state, 'SENT'); assert.equal(confirmation.attemptCount, 1);
  await assert.rejects(db.workflowExecution.update({ where: { id: confirmation.id }, data: { state: 'PENDING' } }));
  await assert.rejects(db.workflowEnrollment.update({ where: { id: enrollmentId }, data: { sourceHash: 'f'.repeat(64) } }));
  assert.equal((await readLeadWorkflowExecutions(db, setter.session, intake.projection.leadId!)).length, 1);
  await assert.rejects(readLeadWorkflowExecutions(db, other.session, intake.projection.leadId!));
  await assignTo(intake.projection.leadId!, other.user.id);
  await assert.rejects(readLeadWorkflowExecutions(db, setter.session, intake.projection.leadId!));
  assert.equal((await readLeadWorkflowExecutions(db, other.session, intake.projection.leadId!)).length, 1);
  await assert.rejects(runSyntheticWorkflowEnrollment(db, other.session, { enrollmentId, now }));
});
for (const reason of ['REPLIED', 'APPOINTMENT_BOOKED'] as const) test(`${reason} cancels persisted pending follow-ups without erasing receipt`, { skip: !enabled }, async () => {
  const fixture = await rule(), intake = await received();
  const enrollment = await enrollSyntheticWorkflowReceipt(db, admin.session, { automationId: fixture.input.id, receiptId: intake.receipt.id });
  const jobs = await db.workflowExecution.findMany({ where: { enrollmentId: enrollment.id }, orderBy: { dueAt: 'asc' } });
  await runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: enrollment.id, now: jobs[0].dueAt.toISOString() });
  const receipt = (await db.workflowExecution.findUniqueOrThrow({ where: { id: jobs[0].id } })).receipt;
  await db.$transaction(tx => stopPendingWorkflowExecutions(tx, { leadId: intake.projection.leadId!, reason, evidenceId: 'synthetic-evidence-' + reason }));
  const run = await runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: enrollment.id, now: jobs[1].dueAt.toISOString() });
  assert.equal(run.executed, 0); assert.equal((await db.workflowExecution.findUniqueOrThrow({ where: { id: jobs[1].id } })).state, 'STOPPED');
  assert.deepEqual((await db.workflowExecution.findUniqueOrThrow({ where: { id: jobs[0].id } })).receipt, receipt);
});
test('uncertain acceptance cannot resend; reconciliation is idempotent', { skip: !enabled }, async () => {
  const fixture = await rule(), intake = await received();
  const enrollment = await enrollSyntheticWorkflowReceipt(db, admin.session, { automationId: fixture.input.id, receiptId: intake.receipt.id });
  const jobs = await db.workflowExecution.findMany({ where: { enrollmentId: enrollment.id }, orderBy: { dueAt: 'asc' } });
  await runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: enrollment.id, now: jobs[0].dueAt.toISOString(), outcome: 'UNCERTAIN' });
  assert.equal((await runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: enrollment.id, now: jobs[1].dueAt.toISOString() })).executed, 0);
  for (let count = 0; count < 2; count++) await reconcileSyntheticWorkflowExecution(db, admin.session, { executionId: jobs[0].id, outcome: 'SENT', evidence: 'Synthetic positive acceptance' });
  assert.equal((await db.workflowExecution.findUniqueOrThrow({ where: { id: jobs[0].id } })).attemptCount, 1);
  assert.equal((await runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: enrollment.id, now: jobs[1].dueAt.toISOString() })).executed, 1);
});
test('identity review and changed recipient prevent dispatch; missing fields stay visible', { skip: !enabled }, async () => {
  const fixture = await rule(), review = await received(true);
  assert.equal(review.projection.state, 'REVIEW_REQUIRED');
  await assert.rejects(enrollSyntheticWorkflowReceipt(db, admin.session, { automationId: fixture.input.id, receiptId: review.receipt.id }));
  const intake = await received(), enrollment = await enrollSyntheticWorkflowReceipt(db, admin.session, { automationId: fixture.input.id, receiptId: intake.receipt.id });
  await db.lead.update({ where: { id: intake.projection.leadId! }, data: { email: 'changed@workflow.invalid.test' } });
  await assert.rejects(runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: enrollment.id, now: new Date(Date.now() + 7200000).toISOString() }), /RECIPIENT_CHANGED/);
  assert((await db.workflowExecution.findMany({ where: { enrollmentId: enrollment.id } })).every(row => row.receipt === null));
  const missingTemplate = await saveWorkflowTemplate(db, admin.session, { ...fixture.confirmation, id: randomUUID(), familyId: randomUUID(),
    body: 'Documento richiesto: {{documentList}}' }, leadProof(admin));
  const missingRule = { ...fixture.input, id: randomUUID(), configuration: { ...fixture.input.configuration, confirmationTemplateId: missingTemplate.id } };
  await saveWorkflowRule(db, admin.session, missingRule, leadProof(admin));
  const missing = await received(), blocked = await enrollSyntheticWorkflowReceipt(db, admin.session, { automationId: missingRule.id, receiptId: missing.receipt.id });
  assert.equal((await runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: blocked.id, now: new Date(Date.now() + 7200000).toISOString() })).executed, 0);
  assert.match((await db.workflowExecution.findUniqueOrThrow({ where: { enrollmentId_step: { enrollmentId: blocked.id, step: 'CONFIRMATION' } } })).stopReason!, /MISSING_FIELDS/);
});
