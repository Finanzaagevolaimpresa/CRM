import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { collectionKey } from '../payment-collection/fixture';
import { clientProof } from '../selective-clients/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticIntakeFixture } from './fixture';
import { saveWorkflowRule, saveWorkflowTemplate } from '../../src/lib/workflow-automations';
import { planNativeWorkflowReceipt, prepareNativeWorkflowEnrollment, reconcileNativeWorkflowExecution, runSyntheticWorkflowEnrollment } from '../../src/lib/workflow-executions';
import { acquireManualReply, configureCommunicationMailbox, linkAmbiguousReply, qualifyCommunicationMailbox,
  readPracticeCommunications, saveApprovedMessageDraft, submitApprovedMessage } from '../../src/lib/approved-communications';
import { captureWorkflowLeadReceiptAfterCommit, prepareWorkflowPendingOnce } from '../../src/lib/workflow-native-runner';
import { runWorkflowPreparationCommand } from '../../src/lib/workflow-runner-command';
import { revokeInternalSession } from '../../src/lib/internal-session-registry';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
after(() => db.$disconnect());
test('disabled native planner shares receipt logic; explicit test prepares one native draft and verified reply stops followup', { skip: !enabled }, async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert.equal(process.env.APP_ENV, 'test'); await collectionKey(db);
  const admin = await syntheticPerson(db, 'Admin preparazione nativa sintetica', 'admin'), intake = await syntheticIntakeFixture(db, admin.user.id);
  const source = await intake.receive();
  const template = { id: randomUUID(), familyId: randomUUID(), expectedVersion: 0, name: 'Test modello nativo', purpose: 'CONFIRMATION',
    subject: 'Ricevuta {{companyName}}', body: 'Test {{firstName}}. Nessun invio reale.', state: 'PUBLISHED', authorizationReference: 'SYNTHETIC_TEST_ONLY' };
  const followup = { ...template, id: randomUUID(), familyId: randomUUID(), purpose: 'FOLLOW_UP' };
  await saveWorkflowTemplate(db, admin.session, template, clientProof(admin)); await saveWorkflowTemplate(db, admin.session, followup, clientProof(admin));
  const rule = { id: randomUUID(), expectedVersion: 0, name: 'Planner comune', event: 'LEAD_ACCEPTED', state: 'TEST_READY', delayMinutes: 60,
    configuration: { kind: 'INDIVIDUAL', action: 'EMAIL', confirmationTemplateId: template.id, followupTemplateId: followup.id,
      requireAssociated: true, stopOnReply: true, stopOnAppointment: true, newsletterAt: null, recipientIds: [] } };
  await saveWorkflowRule(db, admin.session, rule, clientProof(admin));
  const old = process.env.WORKFLOW_NATIVE_PREPARATION_MODE;
  const priorAuthority = await db.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
  try {
    delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE;
    await assert.rejects(planNativeWorkflowReceipt(db, admin.session, { automationId: rule.id, receiptId: source.receipt.id }), /DISABLED/);
    await assert.rejects(runWorkflowPreparationCommand(db, { sessionToken: admin.token }), /DENIED/);
    // Process-local qualification only, after the native ephemeral DB guard.
    // It enables draft preparation, never a provider, sender or worker.
    process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'enabled';
    await saveWorkflowRule(db, admin.session, { ...rule, expectedVersion: 1, state: 'ACTIVE' }, clientProof(admin));
    const enrollment = await planNativeWorkflowReceipt(db, admin.session, { automationId: rule.id, receiptId: source.receipt.id });
    assert.equal((await db.workflowEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).synthetic, false);
    const box = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'assistenza@finanzaagevolaimpresa.it' } });
    const configured = await configureCommunicationMailbox(db, admin.session, { mailboxId: box.id, expectedRevision: box.revision,
      kind: 'MAILBOX', canonicalMailboxId: null, responsibleUserId: admin.user.id, providerReference: 'SYNTHETIC_NATIVE_DRAFT_ONLY',
      configurationReference: 'SYNTHETIC_TEST_CONFIG', canSend: true, canReceive: true, restricted: false });
    await qualifyCommunicationMailbox(db, admin.session, { mailboxId: box.id, expectedRevision: configured.revision, action: 'TEST', testReference: 'SYNTHETIC_TEST_ONLY' });
    // Local authority fixture admits draft writes only. No OrdinaryEmailChannel,
    // transport, mailbox enablement or network operation is provisioned.
    await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority" ("id","userId","mailboxId","enabled") VALUES ('ordinary-email',${admin.user.id},${box.id}::uuid,true)
      ON CONFLICT ("id") DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId","enabled"=true,"revision"="OrdinaryEmailAuthority"."revision"+1`;
    const command = { enrollmentId: enrollment.id, mailboxId: box.id, replyTo: box.address };
    assert.equal((await prepareNativeWorkflowEnrollment(db, admin.session, command)).prepared, 1);
    assert.equal((await prepareNativeWorkflowEnrollment(db, admin.session, command)).prepared, 0);
    const confirmation = await db.workflowExecution.findUniqueOrThrow({ where: { enrollmentId_step: { enrollmentId: enrollment.id, step: 'CONFIRMATION' } } });
    assert.equal(confirmation.state, 'PREPARED'); assert.equal(confirmation.attemptCount, 0);
    assert.equal(await db.approvedCommunication.count({ where: { id: confirmation.id, leadId: source.projection.leadId, state: 'DRAFT' } }), 1);
    assert.equal(await db.communicationAttempt.count({ where: { messageId: confirmation.id } }), 0);
    assert.equal((await reconcileNativeWorkflowExecution(db, admin.session, confirmation.id)).reconciled, false);
    await assert.rejects(runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: enrollment.id, now: new Date().toISOString() }));
    const reply = await acquireManualReply(db, admin.session, { mailboxId: box.id, externalMessageId: `<${randomUUID()}@invalid.test>`, inReplyTo: null,
      sender: source.event.payload.email!, subject: 'Risposta sintetica acquisita', body: 'Confermo la richiesta sintetica.', receivedAt: new Date().toISOString(), evidenceReference: 'SYNTHETIC_RECEIVED' });
    assert.equal(reply.messageId, null);
    const follow = () => db.workflowExecution.findUniqueOrThrow({ where: { enrollmentId_step: { enrollmentId: enrollment.id, step: 'FOLLOW_UP' } } });
    assert.equal((await follow()).state, 'PENDING');
    // Explicit prepared-followup fixture exercises withdrawal after preparation,
    // without advancing the production clock or invoking a real sender.
    const pending = await follow(), rendered = (pending.templateSnapshot as { rendered: { subject: string; body: string } }).rendered;
    const draft = await saveApprovedMessageDraft(db, admin.session, { messageId: pending.id, expectedRevision: 0,
      context: { kind: 'LEAD', id: source.projection.leadId }, mailboxId: box.id, replyTo: box.address,
      to: [source.event.payload.email!], cc: [], bcc: [], subject: rendered.subject, body: rendered.body,
      attachmentVersionIds: [], classification: 'ORDINARY' });
    await db.workflowExecution.update({ where: { id: pending.id }, data: { state: 'PREPARED',
      receipt: { channel: 'NATIVE_EMAIL_DRAFT', synthetic: false, messageId: draft.id, revision: draft.revision, snapshotHash: draft.snapshotHash, sent: false },
      history: JSON.parse(JSON.stringify([...pending.history as object[], { event: 'SYNTHETIC_PREPARED_FIXTURE' }])) } });
    const submission = { messageId: draft.id, expectedRevision: draft.revision, snapshotHash: draft.snapshotHash };
    const originalLead = await db.lead.findUniqueOrThrow({ where: { id: source.projection.leadId! } });
    await db.lead.update({ where: { id: originalLead.id }, data: { companyName: 'Dati sintetici cambiati' } });
    await assert.rejects(submitApprovedMessage(db, admin.session, submission), /WORKFLOW_RECIPIENT_CHANGED/);
    await db.lead.update({ where: { id: originalLead.id }, data: { companyName: originalLead.companyName } });
    await submitApprovedMessage(db, admin.session, submission);
    const link = { replyId: reply.id, messageId: confirmation.id, reason: 'Risposta sintetica verificata dal ruolo amministrativo' };
    await linkAmbiguousReply(db, admin.session, link); await linkAmbiguousReply(db, admin.session, link);
    assert.equal((await follow()).state, 'STOPPED'); assert.equal((await follow()).stopReason, 'REPLIED');
    await assert.rejects(submitApprovedMessage(db, admin.session, submission), /WORKFLOW_MESSAGE_NO_LONGER_ADMISSIBLE/);
    await readPracticeCommunications(db, admin.session, { kind: 'LEAD', id: source.projection.leadId });
    assert.equal((await db.communicationMailbox.findUniqueOrThrow({ where: { id: box.id } })).enabled, false);
    assert.equal(await db.communicationAttempt.count({ where: { messageId: confirmation.id } }), 0);
    // A newly processed receipt now reaches the dormant native hook. Windows
    // invokes the identical post-commit hook after its labelled source fixture.
    const hookedSource = await intake.receive();
    const hooked = await db.workflowEnrollment.findUniqueOrThrow({ where: { automationId_eventKey: { automationId: rule.id, eventKey: hookedSource.event.eventId } } });
    assert.equal(hooked.synthetic, false);
    await captureWorkflowLeadReceiptAfterCommit(db, hookedSource.receipt.inboxEventId);
    assert.equal(await db.workflowEnrollment.count({ where: { automationId: rule.id, eventKey: hookedSource.event.eventId } }), 1);
    const batch = { automationId: rule.id, mailboxId: box.id, replyTo: box.address, limit: 20 };
    await assert.rejects(runWorkflowPreparationCommand(db, { ...batch, sessionToken: 'unregistered-synthetic-token-forgery' }));
    await assert.rejects(runWorkflowPreparationCommand(db, { ...batch, userId: admin.user.id, sessionId: admin.session.sessionId }));
    const revoked = await syntheticPerson(db, 'Sessione runner sintetica revocata', 'admin');
    await db.$transaction(tx => revokeInternalSession(tx, revoked.session.sessionId!, 'INTERNAL_SINGLE', revoked.user.id));
    await assert.rejects(runWorkflowPreparationCommand(db, { ...batch, sessionToken: revoked.token }), /DENIED/);
    const childResult = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/workflow/prepare-once.ts', '--once'], { timeout: 45_000, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify({ ...batch, sessionToken: admin.token }));
    });
    assert.equal(childResult.status, 0, childResult.stderr);
    assert.deepEqual(JSON.parse(childResult.stdout), { status: 'PREPARED', examined: 1, prepared: 1, held: 0, providerCalls: 0 });
    assert(!childResult.stdout.includes(admin.token)); assert.equal(childResult.stderr, '');
    assert.equal((await prepareWorkflowPendingOnce(db, admin.session, batch)).prepared, 0);
    delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE;
    const delayedSource = await intake.receive();
    assert.equal(await db.workflowEnrollment.count({ where: { automationId: rule.id, eventKey: delayedSource.event.eventId } }), 0);
    process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'enabled';
    assert.equal((await prepareWorkflowPendingOnce(db, admin.session, batch)).prepared, 1);
    const recovered = await db.workflowEnrollment.findUniqueOrThrow({ where: { automationId_eventKey: { automationId: rule.id, eventKey: delayedSource.event.eventId } } });
    assert.equal(recovered.sourceReceiptId, delayedSource.receipt.id);
    assert.equal(await db.communicationAttempt.count({ where: { message: { leadId: { in: [hookedSource.projection.leadId!, delayedSource.projection.leadId!] } } } }), 0);
  } finally {
    if (priorAuthority) await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "userId"=${priorAuthority.userId},"mailboxId"=${priorAuthority.mailboxId}::uuid,
      "enabled"=${priorAuthority.enabled},"revision"="revision"+1 WHERE "id"='ordinary-email'`;
    else await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "enabled"=false,"revision"="revision"+1 WHERE "id"='ordinary-email'`;
    if (old === undefined) delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE; else process.env.WORKFLOW_NATIVE_PREPARATION_MODE = old;
  }
});
