import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { connect } from 'node:tls';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { collectionKey } from '../payment-collection/fixture';
import { clientProof } from '../selective-clients/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticIntakeFixture } from './fixture';
import { saveWorkflowRule, saveWorkflowTemplate } from '../../src/lib/workflow-automations';
import { createSyntheticNewsletterRuntime, SYNTHETIC_NEWSLETTER_KEY } from '../../src/lib/workflow-newsletter-test-runtime';
import type { MarketingPreferences } from '../../src/lib/marketing-preferences/service';
import { PROPOSED_POLICY } from '../../src/lib/marketing-preferences/policy';
import { parseNativeNewsletterPolicy, readNativeNewsletterPolicy, type NativeNewsletterPolicySource } from '../../src/lib/workflow-newsletter-policy';
import { planNativeWorkflowNewsletter, prepareNativeWorkflowNewsletter, reconcileNativeNewsletterRecipient } from '../../src/lib/workflow-newsletter-native';
import { reconcileWorkflowNewsletterRecipient } from '../../src/lib/workflow-newsletters';
import { configureCommunicationMailbox, qualifyCommunicationMailbox, saveApprovedMessageDraft, submitApprovedMessage,
  approveExactMessage, prepareManualMessage } from '../../src/lib/approved-communications';
import { previewStoredOrdinaryEmail, reserveStoredOrdinaryEmail } from '../../src/lib/ordinary-email-store-candidate';
import { confirmAndTransmitStoredOrdinaryEmail } from '../../src/lib/ordinary-email-service-candidate';
import { assertNewsletterMessageAction, denyManualNewsletterTransport } from '../../src/lib/workflow-newsletter-admission';
import { ordinaryTransportQualificationReference, createOrdinaryTransportResolver } from '../../src/lib/ordinary-email-transport-binding';
import { SyntheticSocket, type WireOptions } from '../helpers/ordinary-smtp-socket';
import { newsletterTlsPeer, type NewsletterTlsWire } from '../helpers/newsletter-smtp-tls';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
let admin: Awaited<ReturnType<typeof syntheticPerson>>, intake: Awaited<ReturnType<typeof syntheticIntakeFixture>>;
let policy: Parameters<typeof parseNativeNewsletterPolicy>[0], source: NativeNewsletterPolicySource;
let mailbox: { id: string; address: string; revision: number }, preferences: MarketingPreferences;
let priorAuthority: Awaited<ReturnType<typeof db.ordinaryEmailAuthority.findUnique>>, previousMode: string | undefined;
const transportEnvironment = { DIRECT_EMAIL_TEST_MODE: 'enforced', DIRECT_EMAIL_TEST_REFERENCE: 'R49_EMAIL_DIRECT_20260930_01',
  DIRECT_EMAIL_TEST_SMTP_HOST: 'authsmtp.securemail.pro', DIRECT_EMAIL_TEST_SMTP_PASSWORD: 'SYNTHETIC_NEWSLETTER_TLS_ONLY' };
const options = { skip: !enabled, timeout: 45_000 };
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert.equal(process.env.APP_ENV, 'test'); await collectionKey(db);
  previousMode = process.env.WORKFLOW_NATIVE_PREPARATION_MODE; process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'enabled';
  priorAuthority = await db.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
  admin = await syntheticPerson(db, 'Admin newsletter native soltanto sintetiche', 'admin'); intake = await syntheticIntakeFixture(db, admin.user.id);
  await db.$executeRaw`INSERT INTO "MarketingPreferenceEpoch" (singleton,epoch,reconciled) VALUES (true,${randomUUID()}::uuid,true) ON CONFLICT (singleton) DO NOTHING`;
  const [epoch] = await db.$queryRaw<Array<{ epoch: string }>>`SELECT epoch FROM "MarketingPreferenceEpoch" WHERE singleton=true`;
  const notices = await db.privacyNoticeVersion.findMany({ where: { noticeCode: { startsWith: 'FLOW_MARKETING_' }, status: 'ACTIVE' }, select: { id: true, contentHash: true } });
  policy = { protocol: 'FAI_NEWSLETTER_NATIVE_POLICY_V1', policyVersion: PROPOSED_POLICY.version,
    approvalReference: 'SYNTHETIC_TEST_APPROVAL_ONLY', qualificationReference: 'SYNTHETIC_NATIVE_TLS_ONLY',
    effectiveFrom: new Date(Date.now() - 60_000).toISOString(), effectiveUntil: new Date(Date.now() + 3_600_000).toISOString(),
    purposeOpen: true, epoch: epoch.epoch, keyFingerprint: createHash('sha256').update(SYNTHETIC_NEWSLETTER_KEY).digest('hex'),
    keyPath: '/synthetic/not-provisioned', maxTicketAgeMs: 60_000,
    approvedEmailNotices: notices.map(row => ({ noticeVersionId: row.id, contentHash: row.contentHash })),
    unsubscribeUrl: 'https://example.test/preferenze-email/', unsubscribeQualificationReference: 'SYNTHETIC_WITHDRAWAL_ADAPTER_ONLY' };
  source = async now => parseNativeNewsletterPolicy(policy, SYNTHETIC_NEWSLETTER_KEY, now);
  preferences = (await createSyntheticNewsletterRuntime(db)).preferences as MarketingPreferences;
  const previous = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'comunicazioni@finanzaagevolaimpresa.it' } });
  const configured = await configureCommunicationMailbox(db, admin.session, { mailboxId: previous.id, expectedRevision: previous.revision, kind: 'MAILBOX',
    canonicalMailboxId: null, responsibleUserId: admin.user.id, providerReference: 'register_it', configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT',
    canSend: true, canReceive: true, restricted: false });
  await qualifyCommunicationMailbox(db, admin.session, { mailboxId: configured.id, expectedRevision: configured.revision, action: 'TEST', testReference: 'SYNTHETIC_NEWSLETTER_ONLY' });
  await qualifyCommunicationMailbox(db, admin.session, { mailboxId: configured.id, expectedRevision: configured.revision, action: 'ENABLE' });
  mailbox = { ...configured, address: previous.address };
  await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority" (id,"userId","mailboxId",enabled) VALUES ('ordinary-email',${admin.user.id},${mailbox.id}::uuid,true)
    ON CONFLICT (id) DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId",enabled=true,revision="OrdinaryEmailAuthority".revision+1`;
  const priorChannel = await db.ordinaryEmailChannel.findUnique({ where: { mailboxId: mailbox.id } });
  const revision = (priorChannel?.revision ?? 0) + 1;
  const channel = { purpose: 'ORDINARY_SMTP' as const, mailboxId: mailbox.id, mailboxRevision: mailbox.revision, address: 'comunicazioni@finanzaagevolaimpresa.it' as const,
    providerReference: 'register_it' as const, configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT' as const, channelRevision: revision, qualificationReference: 'PENDING_SYNTHETIC' };
  const reference = ordinaryTransportQualificationReference(channel, clientProof(admin).key, transportEnvironment);
  await db.$executeRaw`INSERT INTO "OrdinaryEmailChannel" ("mailboxId","mailboxRevision","qualificationReference",enabled,revision)
    VALUES (${mailbox.id}::uuid,${mailbox.revision},${reference},true,${revision}) ON CONFLICT ("mailboxId") DO UPDATE SET
    "mailboxRevision"=EXCLUDED."mailboxRevision","qualificationReference"=EXCLUDED."qualificationReference",enabled=true,revision=EXCLUDED.revision`;
});
after(async () => {
  if (enabled && admin) {
    if (priorAuthority) await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "userId"=${priorAuthority.userId},"mailboxId"=${priorAuthority.mailboxId}::uuid,
      enabled=${priorAuthority.enabled},revision=revision+1 WHERE id='ordinary-email'`;
    else await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET enabled=false,revision=revision+1 WHERE id='ordinary-email'`;
    if (previousMode === undefined) delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE; else process.env.WORKFLOW_NATIVE_PREPARATION_MODE = previousMode;
  }
  await db.$disconnect();
});

async function fixture(prepare = true) {
  const received = await intake.receive(false, 'GRANTED');
  const evidence = await db.privacyEvidenceReceipt.findFirstOrThrow({ where: { businessInboxEventId: received.receipt.inboxEventId, purposeCode: 'DIRECT_MARKETING' } });
  assert.equal(await preferences.recordChoice(evidence.id, intake.marketingNoticeText), 'RECORDED');
  const template = { id: randomUUID(), familyId: randomUUID(), expectedVersion: 0, name: 'Test newsletter nativa', purpose: 'NEWSLETTER',
    subject: 'Test {{companyName}}', body: 'Test {{firstName}}. Preferenze: {{unsubscribeUrl}}', state: 'PUBLISHED', authorizationReference: 'SYNTHETIC_TEST_ONLY' };
  await saveWorkflowTemplate(db, admin.session, template, clientProof(admin));
  const rule = { id: randomUUID(), expectedVersion: 0, name: 'Test newsletter nativa approvata', event: 'NEWSLETTER', state: 'ACTIVE', delayMinutes: 1,
    configuration: { kind: 'NEWSLETTER', action: 'EMAIL', confirmationTemplateId: template.id, followupTemplateId: null,
      requireAssociated: true, stopOnReply: true, stopOnAppointment: true, newsletterAt: new Date(Date.now() - 1000).toISOString(), recipientIds: [received.projection.leadId!] } };
  await saveWorkflowRule(db, admin.session, rule, clientProof(admin));
  const run = await planNativeWorkflowNewsletter(db, admin.session, { id: randomUUID(), automationId: rule.id }, source);
  const command = { runId: run.id, mailboxId: mailbox.id, replyTo: mailbox.address };
  if (prepare) assert.equal((await prepareNativeWorkflowNewsletter(db, admin.session, command, source)).prepared, 1);
  const row = await db.workflowNewsletterRecipient.findFirstOrThrow({ where: { runId: run.id } });
  return { run, row, command, email: received.event.payload.email!, leadId: received.projection.leadId! };
}
const runtime = () => ({ key: clientProof(admin).key, newsletterPolicySource: source });
async function approved(f: Awaited<ReturnType<typeof fixture>>) {
  const input = { messageId: f.row.id, expectedRevision: f.row.nativeRevision!, snapshotHash: f.row.nativeSnapshotHash! };
  await submitApprovedMessage(db, admin.session, input, runtime()); await approveExactMessage(db, admin.session, input, runtime()); return input;
}
function transport(wire: WireOptions = {}) {
  const sockets: SyntheticSocket[] = [];
  const connectTls = (() => {
    const socket = new SyntheticSocket(wire); sockets.push(socket);
    queueMicrotask(() => { socket.emit('secureConnect'); socket.reply('220 synthetic.invalid ready\r\n'); }); return socket;
  }) as unknown as typeof connect;
  const resolver = createOrdinaryTransportResolver(clientProof(admin).key, { readEnvironment: () => transportEnvironment, connectTls });
  return { sockets, resolver };
}
async function send(f: Awaited<ReturnType<typeof fixture>>, wire: NewsletterTlsWire = {}) {
  const t = await newsletterTlsPeer(wire), resolver = createOrdinaryTransportResolver(clientProof(admin).key,
    { readEnvironment: () => transportEnvironment, connectTls: t.connectTls });
  try {
    const r = { ...runtime(), assertTransport: resolver.assertChannel, observationSink: async () => {} };
    const preview = await previewStoredOrdinaryEmail(db, admin.session, f.row.id, r);
    const result = await confirmAndTransmitStoredOrdinaryEmail(db, admin.session, { messageId: f.row.id, requestId: randomUUID(), previewToken: preview.token },
      clientProof(admin), r, resolver, { deadline: performance.now() + 8_000, signal: AbortSignal.timeout(9_000) });
    return { ...result, sockets: t.sockets };
  } finally { await t.close(); }
}

test('native newsletter prepares one bound draft, requires native approval and reconciles only actual native evidence', options, async () => {
  const base = await fixture(false), preparation = await Promise.all([
    prepareNativeWorkflowNewsletter(db, admin.session, base.command, source), prepareNativeWorkflowNewsletter(db, admin.session, base.command, source),
  ]);
  assert.equal(preparation.reduce((sum, item) => sum + item.prepared, 0), 1);
  const f = { ...base, row: await db.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: base.row.id } }) };
  assert.equal(f.row.state, 'PREPARED'); assert.equal(f.row.attemptCount, 0);
  await assert.rejects(db.workflowNewsletterRecipient.update({ where: { id: f.row.id }, data: { nativeSnapshotHash: 'b'.repeat(64) } }));
  const deniedActor = await syntheticPerson(db, 'Consulente newsletter non autorizzato', 'commerciale');
  await assert.rejects(prepareNativeWorkflowNewsletter(db, deniedActor.session, f.command, source), /DENIED/);
  assert.equal((await prepareNativeWorkflowNewsletter(db, admin.session, f.command, source)).prepared, 0);
  const approval = await approved(f);
  await assert.rejects(prepareManualMessage(db, admin.session, { ...approval, requestId: randomUUID() }, runtime()), /NATIVE_SMTP_REQUIRED/);
  await assert.rejects(db.$transaction(tx => assertNewsletterMessageAction(tx, { messageId: f.row.id, revision: 2, snapshotHash: f.row.nativeSnapshotHash! }, source)));
  await assert.rejects(saveApprovedMessageDraft(db, admin.session, { messageId: f.row.id, expectedRevision: 1,
    context: { kind: 'LEAD', id: f.leadId }, mailboxId: mailbox.id, replyTo: mailbox.address, to: [f.email], cc: [], bcc: [],
    subject: 'Changed', body: 'Changed', attachmentVersionIds: [], classification: 'ORDINARY' }, runtime()));
  const result = await send(f); assert.equal(result.status, 'RECORDED'); assert.equal('outcome' in result && result.outcome, 'ACCEPTED');
  assert.equal(result.sockets[0].writes.filter(text => text.startsWith('From: ')).length, 1);
  assert.equal(result.sockets[0].servername, 'authsmtp.securemail.pro');
  assert(['TLSv1.2','TLSv1.3'].includes(result.sockets[0].protocol!));
  assert.equal((await reconcileNativeNewsletterRecipient(db, admin.session, f.row.id)).state, 'SENT');
  await assert.rejects(send(f));
  assert.equal((await reconcileNativeNewsletterRecipient(db, admin.session, f.row.id)).state, 'SENT');
});
test('withdrawal before approval and before DATA denies native preparation or transmission', options, async () => {
  const first = await fixture(); await preferences.suppressPublic(first.email, randomUUID());
  await assert.rejects(approved(first));
  const second = await fixture(); await approved(second);
  const t = transport(), r = { ...runtime(), assertTransport: t.resolver.assertChannel };
  const preview = await previewStoredOrdinaryEmail(db, admin.session, second.row.id, r);
  await preferences.suppressPublic(second.email, randomUUID());
  await assert.rejects(reserveStoredOrdinaryEmail(db, admin.session, { messageId: second.row.id, requestId: randomUUID(), previewToken: preview.token }, clientProof(admin), r));
  assert.equal(t.sockets.length, 0);
  const third = await fixture(); await approved(third);
  const result = await send(third, { beforeReply: async line => {
    if (line.startsWith('RCPT TO:')) await preferences.suppressPublic(third.email, randomUUID());
  } });
  assert.equal('outcome' in result && result.outcome, 'NOT_SENT');
  assert(!result.sockets[0].writes.includes('DATA\r\n'));
});
test('withdrawal serializes with the real native TLS DATA fence then excludes subsequent sends', options, async () => {
  const f = await fixture(); await approved(f);
  let completed = false, waiting: Promise<unknown> | undefined, blocked = false;
  const result = await send(f, { beforeDataReply: async () => {
    waiting = preferences.suppressPublic(f.email, randomUUID()).then(value => { completed = true; return value; });
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND cardinality(pg_blocking_pids(pid))>0
          AND query LIKE '%pg_advisory_xact_lock%' AND query LIKE '%1300%') AS blocked`;
      blocked = row.blocked; if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(blocked); assert.equal(completed, false);
  } });
  await waiting; assert.equal(completed, true); assert(blocked);
  assert.equal('outcome' in result && result.outcome, 'ACCEPTED');
  assert.equal((await preferences.select(f.email)).decision.eligible, false);
  await assert.rejects(send(f));
});
test('policy revoked after354 prevents content, native uncertain evidence is never retried', options, async () => {
  const f = await fixture(); await approved(f);
  const original = source; let revoked = false;
  source = async now => { if (revoked) throw new Error('SYNTHETIC_POLICY_REVOKED'); return original(now); };
  try {
    const result = await send(f, { beforeDataReply: async () => { revoked = true; } });
    assert.equal('outcome' in result && result.outcome, 'NOT_SENT');
    assert(result.sockets[0].writes.includes('DATA\r\n')); assert(!result.sockets[0].writes.some(text => text.startsWith('From: ')));
  } finally { source = original; }
  const uncertain = await fixture(); await approved(uncertain);
  const result = await send(uncertain, { final: null });
  assert.equal('outcome' in result && result.outcome, 'UNCERTAIN');
  assert.equal((await reconcileNativeNewsletterRecipient(db, admin.session, uncertain.row.id)).state, 'UNCERTAIN');
  await assert.rejects(reconcileWorkflowNewsletterRecipient(db, admin.session,
    { id: uncertain.row.id, outcome: 'SENT', evidence: 'SYNTHETIC_OPERATOR_CANNOT_INVENT_NATIVE_RECEIPT' }), /NATIVE_RECONCILIATION_REQUIRED/);
  await assert.rejects(send(uncertain));
});
test('missing manifest, key or reconciled epoch leaves no native draft or transport attempt', options, async () => {
  const f = await fixture(false);
  await assert.rejects(prepareNativeWorkflowNewsletter(db, admin.session, f.command));
  await assert.rejects(readNativeNewsletterPolicy(new Date()));
  await assert.rejects(prepareNativeWorkflowNewsletter(db, admin.session, f.command, async now => parseNativeNewsletterPolicy(policy, Buffer.alloc(32, 1), now)));
  const [epoch] = await db.$queryRaw<Array<{ epoch: string }>>`SELECT epoch FROM "MarketingPreferenceEpoch" WHERE singleton=true`;
  await db.$executeRaw`UPDATE "MarketingPreferenceEpoch" SET reconciled=false WHERE singleton=true`;
  try { await assert.rejects(prepareNativeWorkflowNewsletter(db, admin.session, f.command, source)); }
  finally { await db.$executeRaw`UPDATE "MarketingPreferenceEpoch" SET reconciled=true WHERE singleton=true AND epoch=${epoch.epoch}::uuid`; }
  assert.equal(await db.approvedCommunication.count({ where: { id: f.row.id } }), 0);
});
test('native mail remains compatible before schema78 but partial newsletter persistence fails closed', options, async () => {
  const schema = 'newsletter_compat_' + randomUUID().replaceAll('-', ''), rollback = new Error('SYNTHETIC_ROLLBACK_ONLY');
  await assert.rejects(db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    const input = { messageId: randomUUID(), revision: 1, snapshotHash: 'a'.repeat(64) };
    assert.equal(await assertNewsletterMessageAction(tx, input), null);
    await denyManualNewsletterTransport(tx, input.messageId);
    await tx.$executeRawUnsafe('CREATE TABLE "WorkflowAutomation" (id uuid PRIMARY KEY)');
    await assert.rejects(assertNewsletterMessageAction(tx, input), /PERSISTENCE_INCOMPLETE/);
    await assert.rejects(denyManualNewsletterTransport(tx, input.messageId), /PERSISTENCE_INCOMPLETE/);
    await tx.$executeRawUnsafe('CREATE TABLE "WorkflowNewsletterRun" (id uuid PRIMARY KEY)');
    await tx.$executeRawUnsafe('CREATE TABLE "WorkflowNewsletterRecipient" (id uuid PRIMARY KEY)');
    await assert.rejects(assertNewsletterMessageAction(tx, input), /PERSISTENCE_INCOMPLETE/);
    throw rollback;
  }), error => error === rollback);
  const [row] = await db.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=${schema}) AS present`;
  assert.equal(row.present, false);
});
