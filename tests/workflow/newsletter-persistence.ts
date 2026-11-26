import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { collectionKey } from '../payment-collection/fixture';
import { clientProof } from '../selective-clients/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticIntakeFixture } from './fixture';
import { saveWorkflowRule, saveWorkflowTemplate } from '../../src/lib/workflow-automations';
import { createSyntheticNewsletterRuntime } from '../../src/lib/workflow-newsletter-test-runtime';
import { executeWorkflowNewsletter, planWorkflowNewsletter, reconcileWorkflowNewsletterRecipient, type NewsletterRuntime } from '../../src/lib/workflow-newsletters';
import { createWithdrawalPost } from '../../src/lib/marketing-preferences/withdrawal-http';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
let admin: Awaited<ReturnType<typeof syntheticPerson>>, intake: Awaited<ReturnType<typeof syntheticIntakeFixture>>;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert.equal(process.env.APP_ENV, 'test'); await collectionKey(db);
  admin = await syntheticPerson(db, 'Admin newsletter sintetiche', 'admin'); intake = await syntheticIntakeFixture(db, admin.user.id);
  // Test-only reconciliation epoch; the migration provisions no row or policy.
  await db.$executeRaw`INSERT INTO "MarketingPreferenceEpoch" (singleton,epoch,reconciled) VALUES (true,${randomUUID()}::uuid,true) ON CONFLICT (singleton) DO NOTHING`;
});
after(() => db.$disconnect());

async function recipient(runtime: NewsletterRuntime, decision: 'GRANTED' | 'DENIED' = 'GRANTED') {
  const received = await intake.receive(false, decision);
  const receipt = await db.privacyEvidenceReceipt.findFirstOrThrow({ where: { businessInboxEventId: received.receipt.inboxEventId, purposeCode: 'DIRECT_MARKETING' } });
  // Factory returns the native MarketingPreferences instance, whose acquisition
  // method verifies immutable receipt/envelope/notice rather than a caller flag.
  const service = runtime.preferences as import('../../src/lib/marketing-preferences/service').MarketingPreferences;
  assert.equal(await service.recordChoice(receipt.id, intake.marketingNoticeText), 'RECORDED');
  assert.equal(await service.recordChoice(receipt.id, intake.marketingNoticeText), 'REPLAY');
  return { id: received.projection.leadId!, email: received.event.payload.email!, service };
}
async function newsletter(runtime: NewsletterRuntime, recipientIds: string[]) {
  const template = { id: randomUUID(), familyId: randomUUID(), expectedVersion: 0, name: 'Newsletter sintetica', purpose: 'NEWSLETTER',
    subject: 'Notizia per {{companyName}}', body: 'Ciao {{firstName}}. Preferenze: {{unsubscribeUrl}}', state: 'PUBLISHED', authorizationReference: 'SYNTHETIC_TEST_ONLY' };
  await saveWorkflowTemplate(db, admin.session, template, clientProof(admin));
  const input = { id: randomUUID(), expectedVersion: 0, name: 'Newsletter persistita di prova', event: 'NEWSLETTER', state: 'TEST_READY', delayMinutes: 1,
    configuration: { kind: 'NEWSLETTER', action: 'EMAIL', confirmationTemplateId: template.id, followupTemplateId: null,
      requireAssociated: true, stopOnReply: true, stopOnAppointment: true, newsletterAt: new Date(Date.now() - 1000).toISOString(), recipientIds } };
  await saveWorkflowRule(db, admin.session, input, clientProof(admin));
  const command = { id: randomUUID(), automationId: input.id };
  const planned = await planWorkflowNewsletter(db, admin.session, command, runtime);
  assert.equal((await planWorkflowNewsletter(db, admin.session, command, runtime)).id, planned.id);
  return planned;
}

test('persisted newsletter uses current consent and withdrawal, one receipt per selected recipient', { skip: !enabled }, async () => {
  const runtime = await createSyntheticNewsletterRuntime(db), granted = await recipient(runtime), denied = await recipient(runtime, 'DENIED'), withdrawn = await recipient(runtime);
  const planned = await newsletter(runtime, [granted.id, denied.id, withdrawn.id]);
  const post = createWithdrawalPost({ service: withdrawn.service, publicOrigin: 'https://example.test', admitRequest: async () => true });
  const requestId = randomUUID(), body = JSON.stringify({ email: withdrawn.email, requestId });
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await post(new Request('https://example.test/preferenze-email/', {
    method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body }))).status, 200);
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: planned.id }, runtime)).executed, 1);
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: planned.id }, runtime)).executed, 0);
  const rows = await db.workflowNewsletterRecipient.findMany({ where: { runId: planned.id } });
  assert.equal(rows.length, 3); assert.equal(rows.filter(row => row.state === 'SENT').length, 1);
  assert(rows.filter(row => row.state === 'BLOCKED').every(row => row.receipt === null && row.attemptCount === 0));
  assert.equal((rows.find(row => row.leadId === denied.id)!.policySnapshot as { decision: { reason: string } }).decision.reason, 'DENIED');
  assert.equal((rows.find(row => row.leadId === withdrawn.id)!.policySnapshot as { decision: { reason: string } }).decision.reason, 'SUPPRESSED');
  assert.equal((rows.find(row => row.leadId === granted.id)!.receipt as { delivered: boolean }).delivered, false);
});

test('concurrent newsletter replay invokes the adapter once', { skip: !enabled }, async () => {
  let calls = 0;
  const base = await createSyntheticNewsletterRuntime(db), runtime = { ...base, transport: async (request: Parameters<NewsletterRuntime['transport']>[0]) => { calls++; return base.transport(request); } };
  const person = await recipient(runtime), run = await newsletter(runtime, [person.id]);
  const results = await Promise.all([executeWorkflowNewsletter(db, admin.session, { runId: run.id }, runtime), executeWorkflowNewsletter(db, admin.session, { runId: run.id }, runtime)]);
  assert.equal(calls, 1); assert.equal(results.reduce((sum, value) => sum + value.executed, 0), 1);
  assert.equal((await db.workflowNewsletterRecipient.findFirstOrThrow({ where: { runId: run.id } })).attemptCount, 1);
});

test('withdrawal committed after selection is rechecked before transport', { skip: !enabled }, async () => {
  const base = await createSyntheticNewsletterRuntime(db), person = await recipient(base);
  let calls = 0;
  const runtime: NewsletterRuntime = { ...base, preferences: {
    select: async email => {
      const selection = await base.preferences.select(email); assert(selection.ticket); assert(selection.decision.eligible);
      await person.service.suppressPublic(email, randomUUID()); return selection;
    },
    atFinalHandoff: base.preferences.atFinalHandoff.bind(base.preferences),
  }, transport: async request => { calls++; return base.transport(request); } };
  const run = await newsletter(runtime, [person.id]);
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: run.id }, runtime)).executed, 0); assert.equal(calls, 0);
  const row = await db.workflowNewsletterRecipient.findFirstOrThrow({ where: { runId: run.id } });
  assert.equal((row.policySnapshot as { decision: { reason: string } }).decision.reason, 'STALE_SELECTION');
});

test('default preference store cannot dispatch even with current consent; duplicate email is excluded', { skip: !enabled }, async () => {
  const deniedRuntime = await createSyntheticNewsletterRuntime(db, 'SENT', false), person = await recipient(deniedRuntime);
  let calls = 0;
  const denied = { ...deniedRuntime, transport: async (request: Parameters<NewsletterRuntime['transport']>[0]) => { calls++; return deniedRuntime.transport(request); } };
  const run = await newsletter(denied, [person.id]);
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: run.id }, denied)).executed, 0); assert.equal(calls, 0);
  const row = await db.workflowNewsletterRecipient.findFirstOrThrow({ where: { runId: run.id } });
  assert.equal((row.policySnapshot as { decision: { reason: string } }).decision.reason, 'HANDOFF_SERIALIZATION_UNAVAILABLE');
  const runtime = await createSyntheticNewsletterRuntime(db);
  const second = await db.lead.create({ data: { firstName: 'Seconda scheda', lastName: 'Sintetica', email: person.email } });
  const dedup = await newsletter(runtime, [person.id, second.id]);
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: dedup.id }, runtime)).executed, 1);
  assert.equal(await db.workflowNewsletterRecipient.count({ where: { runId: dedup.id, state: 'SENT' } }), 1);
});

test('uncertain receipt is not retried; explicit negative reconciliation rechecks withdrawal', { skip: !enabled }, async () => {
  const runtime = await createSyntheticNewsletterRuntime(db, 'UNCERTAIN'), person = await recipient(runtime), run = await newsletter(runtime, [person.id]);
  await executeWorkflowNewsletter(db, admin.session, { runId: run.id }, runtime);
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: run.id }, runtime)).executed, 0);
  const row = await db.workflowNewsletterRecipient.findFirstOrThrow({ where: { runId: run.id } }); assert.equal(row.state, 'UNCERTAIN');
  await person.service.suppressPublic(person.email, randomUUID());
  const reconciliation = { id: row.id, outcome: 'NOT_SENT', evidence: 'SYNTHETIC_NOT_ACCEPTED_RECEIPT' };
  await reconcileWorkflowNewsletterRecipient(db, admin.session, reconciliation);
  await reconcileWorkflowNewsletterRecipient(db, admin.session, reconciliation);
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: run.id }, runtime)).executed, 0);
  const final = await db.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(final.state, 'BLOCKED'); assert.equal(final.attemptCount, 1); assert.deepEqual(final.receipt, row.receipt);
});

test('a verified negative permits a numbered attempt and preserves the preceding receipt', { skip: !enabled }, async () => {
  const uncertain = await createSyntheticNewsletterRuntime(db, 'UNCERTAIN'), person = await recipient(uncertain), run = await newsletter(uncertain, [person.id]);
  await executeWorkflowNewsletter(db, admin.session, { runId: run.id }, uncertain);
  const before = await db.workflowNewsletterRecipient.findFirstOrThrow({ where: { runId: run.id } });
  await reconcileWorkflowNewsletterRecipient(db, admin.session, { id: before.id, outcome: 'NOT_SENT', evidence: 'SYNTHETIC_NEGATIVE_ACCEPTANCE' });
  const runtime = await createSyntheticNewsletterRuntime(db);
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: run.id }, runtime)).executed, 1);
  const after = await db.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: before.id } });
  assert.equal(after.state, 'SENT'); assert.equal(after.attemptCount, 2); assert.notDeepEqual(after.receipt, before.receipt);
  assert(Array.isArray(after.history) && after.history.some(event => typeof event === 'object' && event !== null && !Array.isArray(event)
    && JSON.stringify(event.receipt) === JSON.stringify(before.receipt)));
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: run.id }, runtime)).executed, 0);
  const accepted = await newsletter(uncertain, [person.id]);
  await executeWorkflowNewsletter(db, admin.session, { runId: accepted.id }, uncertain);
  const uncertainRow = await db.workflowNewsletterRecipient.findFirstOrThrow({ where: { runId: accepted.id } });
  const resolution = { id: uncertainRow.id, outcome: 'SENT', evidence: 'SYNTHETIC_ACCEPTANCE_ATTESTED' };
  await reconcileWorkflowNewsletterRecipient(db, admin.session, resolution);
  await reconcileWorkflowNewsletterRecipient(db, admin.session, resolution);
  assert.equal((await db.workflowNewsletterRun.findUniqueOrThrow({ where: { id: accepted.id } })).state, 'COMPLETED');
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: accepted.id }, runtime)).executed, 0);
});

test('withdrawal waits for the synthetic handoff boundary, then excludes the next run', { skip: !enabled, timeout: 30_000 }, async () => {
  const base = await createSyntheticNewsletterRuntime(db), person = await recipient(base);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
  const runtime = { ...base, transport: async (request: Parameters<NewsletterRuntime['transport']>[0]) => { entered(); await held; return base.transport(request); } };
  const run = await newsletter(runtime, [person.id]);
  const sending = executeWorkflowNewsletter(db, admin.session, { runId: run.id }, runtime);
  try {
    await Promise.race([started, sending.then(() => { throw new Error('SYNTHETIC_HANDOFF_NOT_ENTERED'); })]);
    let withdrawn = false;
    const withdrawal = person.service.suppressPublic(person.email, randomUUID()).then(value => { withdrawn = true; return value; });
    assert.equal(withdrawn, false); finish();
    assert.equal((await sending).executed, 1); assert.equal(await withdrawal, 'RECORDED');
  } finally { finish(); }
  const next = await newsletter(base, [person.id]);
  assert.equal((await executeWorkflowNewsletter(db, admin.session, { runId: next.id }, base)).executed, 0);
});
