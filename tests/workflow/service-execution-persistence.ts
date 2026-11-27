import assert from 'node:assert/strict';
import { after,afterEach,before,test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { serviceFixture,serviceTestEnvironment } from './service-fixture';
import { newsletterTlsPeer,type NewsletterTlsWire } from '../helpers/newsletter-smtp-tls';
import { clientProof } from '../selective-clients/fixtures';
import { syntheticPerson,syntheticSession } from '../selective-sharing/fixtures';
import { runWorkflowServiceOnce,createWorkflowServiceCommand } from '../../src/lib/workflow-service-runner';
import { denyPersonalServiceMessage,issueWorkflowServiceGrant,revokeWorkflowServiceAuthority,readWorkflowServiceCredential } from '../../src/lib/workflow-service-authority';
import { previewStoredOrdinaryEmail } from '../../src/lib/ordinary-email-store-candidate';
import { saveWorkflowRule } from '../../src/lib/workflow-automations';
import { readLeadWorkflowExecutions,readLeadNewsletterExecutions,reconcileNativeWorkflowExecution,stopPendingWorkflowExecutions } from '../../src/lib/workflow-executions';
import { reconcileNativeNewsletterRecipient } from '../../src/lib/workflow-newsletter-native';
import { assignCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { saveCalendarAvailability,saveLeadAppointment } from '../../src/lib/personal-calendar';
import { defaultCalendarAvailability } from '../../src/lib/personal-calendar-contract';
import { planWorkflowOperationalEvent } from '../../src/lib/workflow-event-planner';
import { recordWorkflowLeadStatusEvent } from '../../src/lib/workflow-operational-capture';
import { getInternalNotifications,getInternalNotificationCount,markInternalNotificationRead } from '../../src/lib/internal-notifications';
import { readAdmittedOrdinaryEmailReceipts } from '../../src/lib/ordinary-email-receipt-reader';
import { workflowServiceHoldMessage } from '../../src/lib/workflow-service-status';
import { confirmStoredOrdinaryRecovery,previewStoredOrdinaryRecovery } from '../../src/lib/ordinary-email-reconciliation';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
const options = { skip: !enabled,timeout: 120000 };
let f: Awaited<ReturnType<typeof serviceFixture>>;
const previous = { native: process.env.WORKFLOW_NATIVE_PREPARATION_MODE,service: process.env.WORKFLOW_SERVICE_EXECUTION_MODE };
before(async () => {
  if (!enabled) return;
  process.env.WORKFLOW_NATIVE_PREPARATION_MODE='enabled'; process.env.WORKFLOW_SERVICE_EXECUTION_MODE='enabled'; f=await serviceFixture(db);
});
afterEach(async () => {
  if (!enabled || !f) return;
  process.env.WORKFLOW_NATIVE_PREPARATION_MODE='enabled'; process.env.WORKFLOW_SERVICE_EXECUTION_MODE='enabled';
  for (const row of await db.workflowServiceGrant.findMany({ where: { issuedById: f.admin.user.id,state: 'ACTIVE' } }))
    await revokeWorkflowServiceAuthority(db,f.admin.session,{ id: row.id,kind: 'GRANT',expectedRevision: row.revision },clientProof(f.admin));
});
after(async () => {
  if (enabled && f) await f.restore();
  for (const [key,value] of Object.entries({ WORKFLOW_NATIVE_PREPARATION_MODE: previous.native,WORKFLOW_SERVICE_EXECUTION_MODE: previous.service })) {
    if (value === undefined) delete process.env[key]; else process.env[key]=value;
  }
  await db.$disconnect();
});
async function run(grantId: string,wire: NewsletterTlsWire = {}, command = createWorkflowServiceCommand(grantId,f.runtime)) {
  const peer = await newsletterTlsPeer(wire);
  try { return { result: await runWorkflowServiceOnce(db,command.invocation,command.proof,f.runtime,
    { readEnvironment: () => serviceTestEnvironment,connectTls: peer.connectTls }),sockets: peer.sockets,command }; }
  finally { await peer.close(); }
}
async function messages(grantId: string) { return db.workflowServiceMessage.findMany({ where: { grantId },include: { message: true,decision: true } }); }
const acceptedCount = (value: Awaited<ReturnType<typeof run>>) => (value.result.result as { accepted: number }).accepted;

test('sequence uses native TLS without issuing human session; exact delegated decision differs from personal approval',options,async context => {
  const setup = await f.create();
  context.diagnostic(`${f.intake.gatewayReceiptMode}; ${f.intake.projectionMode}; actual TLS loopback.`);
  await db.internalSession.update({ where: { id: f.admin.session.sessionId! },data: { revokedAt: new Date() } });
  try {
    const result = await run(setup.grant.id); assert.equal(acceptedCount(result),1);
    assert.equal(result.sockets.length,1); assert.equal(result.sockets[0].writes.filter(value => value.startsWith('From: ')).length,1);
    assert(['TLSv1.2','TLSv1.3'].includes(result.sockets[0].protocol!));
    const [message] = await messages(setup.grant.id); assert.equal(message.message.state,'SENT');
    assert(message.decision); assert.equal(message.decision.sessionId,null); assert.equal(message.decision.serviceMessageId,message.messageId);
    assert.equal((message.decision.decision as { protocol: string }).protocol,'FAI_ORDINARY_EMAIL_WORKFLOW_DECISION_V1');
    assert.equal(await db.communicationApproval.count({ where: { versionId: message.versionId } }),0);
    const replay = await run(setup.grant.id,{},result.command); assert.equal(replay.result.replay,true); assert.equal(replay.sockets.length,0);
    assert.equal((await db.workflowExecution.findUniqueOrThrow({ where: { id: message.messageId } })).state,'SENT');
  } finally { Object.assign(f.admin,await syntheticSession(db,f.admin.user)); }
});

test('timed newsletter uses the same executor, checks current preferences and needs no personal per-message approval',options,async () => {
  const setup = await f.create('NEWSLETTER',{ newsletterDelayMs: 2000 });
  const early = await run(setup.grant.id); assert.equal(acceptedCount(early),0); assert.equal(early.sockets.length,0);
  await wait(Math.max(0,Date.parse(setup.rule.configuration.newsletterAt!)-Date.now()+30));
  const result = await run(setup.grant.id); assert.equal(acceptedCount(result),1);
  const [message] = await messages(setup.grant.id); assert(message.recipientId); assert.equal(message.decision?.sessionId,null);
  assert.equal((await db.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: message.recipientId } })).state,'SENT');
  assert.equal(await db.communicationApproval.count({ where: { versionId: message.versionId } }),0);
  await assert.rejects(previewStoredOrdinaryEmail(db,f.admin.session,message.messageId,{ key: clientProof(f.admin).key,newsletterPolicySource: f.runtime.newsletterPolicySource }),/REQUIRES_GRANT/);
});

test('race and replay reserve one message; uncertain wire evidence never permits automatic retry',options,async () => {
  const setup = await f.create(), peer = await newsletterTlsPeer({ final: null });
  try {
    const command = createWorkflowServiceCommand(setup.grant.id,f.runtime), source = { readEnvironment: () => serviceTestEnvironment,connectTls: peer.connectTls };
    const results = await Promise.all([0,1].map(() => runWorkflowServiceOnce(db,command.invocation,command.proof,f.runtime,source)));
    assert.equal(results.filter(row => row.replay).length,1); assert.equal(peer.sockets.length,1);
    const [message] = await messages(setup.grant.id); assert.equal(message.message.state,'UNCERTAIN');
    assert.equal(await db.ordinaryEmailAttempt.count({ where: { messageId: message.messageId } }),1);
    const replay = await run(setup.grant.id); assert.equal(replay.sockets.length,0);
    assert.equal((await messages(setup.grant.id)).length,1);
    await revokeWorkflowServiceAuthority(db,f.admin.session,{ id: setup.grant.id,kind: 'GRANT',expectedRevision: 1 },clientProof(f.admin));
    assert.equal((await reconcileNativeWorkflowExecution(db,f.admin.session,message.messageId)).state,'UNCERTAIN');
  } finally { await peer.close(); }
});

test('revoked grant, wrong key, changed rule and gateoff cause no socket; non-admin cannot issue authority',options,async () => {
  const setup = await f.create(), stranger = await syntheticPerson(db,'Commerciale senza delega','commerciale');
  await assert.rejects(issueWorkflowServiceGrant(db,stranger.session,{ ...setup.input,id: randomUUID() },clientProof(stranger)));
  await assert.rejects(issueWorkflowServiceGrant(db,f.admin.session,{ ...setup.input,id: randomUUID(),approved: false },clientProof(f.admin)));
  const command = createWorkflowServiceCommand(setup.grant.id,f.runtime), peer = await newsletterTlsPeer();
  try {
    await assert.rejects(runWorkflowServiceOnce(db,command.invocation,'0'.repeat(64),f.runtime,{ readEnvironment: () => serviceTestEnvironment,connectTls: peer.connectTls }),/PROOF_INVALID/);
    process.env.WORKFLOW_SERVICE_EXECUTION_MODE='disabled';
    await assert.rejects(runWorkflowServiceOnce({} as PrismaClient,command.invocation,command.proof,f.runtime,{} as never),/DISABLED/);
    await assert.rejects(readWorkflowServiceCredential(),/DISABLED/);
    process.env.WORKFLOW_SERVICE_EXECUTION_MODE='enabled';
    await saveWorkflowRule(db,f.admin.session,{ ...setup.rule,expectedVersion: 1,name: 'Regola cambiata' },clientProof(f.admin));
    await assert.rejects(runWorkflowServiceOnce(db,command.invocation,command.proof,f.runtime,{ readEnvironment: () => serviceTestEnvironment,connectTls: peer.connectTls }),/DENIED/);
    await revokeWorkflowServiceAuthority(db,f.admin.session,{ id: setup.grant.id,kind: 'GRANT',expectedRevision: 1 },clientProof(f.admin));
    await assert.rejects(run(setup.grant.id),/DENIED/); assert.equal(peer.sockets.length,0);
    const active=await f.create(); await f.intake.receive();
    const stopped=await newsletterTlsPeer({ beforeReply: async line => {
      if (line.startsWith('RCPT TO:')) process.env.WORKFLOW_SERVICE_EXECUTION_MODE='disabled';
    } });
    try {
      const next=createWorkflowServiceCommand(active.grant.id,f.runtime);
      await assert.rejects(runWorkflowServiceOnce(db,next.invocation,next.proof,f.runtime,
        { readEnvironment: () => serviceTestEnvironment,connectTls: stopped.connectTls }),/WORKFLOW_SERVICE_DISABLED/);
      assert.equal(stopped.sockets.length,1); assert(!stopped.sockets[0].writes.includes('DATA\r\n'));
      assert.equal(stopped.sockets[0].writes.filter(value => value.startsWith('From: ')).length,0);
      const [held]=await messages(active.grant.id);
      assert.equal((await db.workflowExecution.findUniqueOrThrow({ where: { id: held.executionId! } })).stopReason,'WORKFLOW_SERVICE_DISABLED');
    } finally { process.env.WORKFLOW_SERVICE_EXECUTION_MODE='enabled'; await stopped.close(); }
  } finally { await peer.close(); }
});

test('followup waits from actual confirmation acceptance and reply/booking stop pending work',options,async () => {
  const setup = await f.create('LEAD_ACCEPTED',{ followup: true });
  assert.equal(acceptedCount(await run(setup.grant.id)),1);
  const early = await run(setup.grant.id); assert.equal(acceptedCount(early),0); assert.equal(early.sockets.length,0);
  await db.$transaction(tx => stopPendingWorkflowExecutions(tx,{ leadId: setup.received.projection.leadId!,reason: 'REPLIED',evidenceId: 'SYNTHETIC_REPLY_EVIDENCE' }));
  assert.equal((await db.workflowExecution.findFirstOrThrow({ where: { enrollment: { automationId: setup.rule.id },step: 'FOLLOW_UP' } })).state,'STOPPED');
  assert.equal((await run(setup.grant.id)).sockets.length,0);
  const appointment = await f.create('LEAD_ACCEPTED',{ followup: true });
  assert.equal(acceptedCount(await run(appointment.grant.id)),1);
  await db.$transaction(tx => stopPendingWorkflowExecutions(tx,{ leadId: appointment.received.projection.leadId!,reason: 'APPOINTMENT_BOOKED',evidenceId: 'SYNTHETIC_BOOKING_EVIDENCE' }));
  assert.equal((await run(appointment.grant.id)).sockets.length,0);
});

test('withdrawal before preparation and before DATA excludes newsletter; after354 policy revocation aborts content',options,async () => {
  const first = await f.create('NEWSLETTER'); await wait(550); await f.preferences.suppressPublic(first.received.event.payload.email!,randomUUID());
  const held = await run(first.grant.id); assert.equal(held.sockets.length,0);
  const second = await f.create('NEWSLETTER'); await wait(550);
  const denied = await run(second.grant.id,{ beforeReply: async line => { if (line.startsWith('RCPT TO:')) await f.preferences.suppressPublic(second.received.event.payload.email!,randomUUID()); } });
  assert.equal(acceptedCount(denied),0); assert(!denied.sockets[0].writes.includes('DATA\r\n'));
  const third = await f.create('NEWSLETTER'); await wait(550);
  const old = f.runtime.newsletterPolicySource;
  let revoked = false; f.runtime.newsletterPolicySource = async now => { if (revoked) throw new Error('NEWSLETTER_POLICY_UNAVAILABLE'); return old(now); };
  try {
    const result = await run(third.grant.id,{ beforeDataReply: async () => { revoked=true; } });
    assert.equal(acceptedCount(result),0); assert(result.sockets[0].writes.includes('DATA\r\n')); assert(!result.sockets[0].writes.some(value => value.startsWith('From: ')));
  } finally { f.runtime.newsletterPolicySource=old; }
});

test('native evidence can be reconciled after grant revocation without authorizing another attempt',options,async () => {
  const setup = await f.create('NEWSLETTER'); await wait(550);
  const result = await run(setup.grant.id); assert.equal(acceptedCount(result),1);
  const [message] = await messages(setup.grant.id);
  await revokeWorkflowServiceAuthority(db,f.admin.session,{ id: setup.grant.id,kind: 'GRANT',expectedRevision: 1 },clientProof(f.admin));
  assert.equal((await reconcileNativeNewsletterRecipient(db,f.admin.session,message.messageId)).state,'SENT');
  await assert.rejects(run(setup.grant.id),/DENIED/);
  assert.equal(await db.ordinaryEmailAttempt.count({ where: { messageId: message.messageId } }),1);
});

test('confirmation, real elapsed wait and followup execute without an interactive session',options,async () => {
  const setup = await f.create('LEAD_ACCEPTED',{ followup: true });
  const initial = await run(setup.grant.id); assert.equal(acceptedCount(initial),1);
  const [message] = await messages(setup.grant.id);
  const receipts = await db.$transaction(tx => readAdmittedOrdinaryEmailReceipts(tx,message.messageId));
  assert(receipts[0].recordedAt);
  assert.equal((await run(setup.grant.id)).sockets.length,0);
  await db.internalSession.update({ where: { id: f.admin.session.sessionId! },data: { revokedAt: new Date() } });
  try {
    await wait(Math.max(0,receipts[0].recordedAt.getTime()+60020-Date.now()));
    const followup = await run(setup.grant.id); assert.equal(acceptedCount(followup),1);
    assert.equal((await messages(setup.grant.id)).length,2); assert.equal((await run(setup.grant.id)).sockets.length,0);
    const rows = await db.workflowExecution.findMany({ where: { enrollment: { automationId: setup.rule.id } } });
    assert.deepEqual(rows.map(row => row.state),['SENT','SENT']);
  } finally { Object.assign(f.admin,await syntheticSession(db,f.admin.user)); }
});

test('concurrent invocations share total and UTC day quotas and cannot reserve an extra message',options,async () => {
  for (const limits of [{ maxMessages: 1,maxPerDay: 1 },{ maxMessages: 3,maxPerDay: 1 }]) {
    const setup = await f.create('LEAD_ACCEPTED',limits); await f.intake.receive();
    const commands = [createWorkflowServiceCommand(setup.grant.id,f.runtime),createWorkflowServiceCommand(setup.grant.id,f.runtime)];
    let interleaved=false;
    const peer = await newsletterTlsPeer({ beforeReply: async line => {
      if (!line.startsWith('RCPT TO:') || interleaved) return;
      interleaved=true;
      const observer=await runWorkflowServiceOnce(db,commands[1].invocation,commands[1].proof,f.runtime,
        { readEnvironment: () => serviceTestEnvironment,connectTls: peer.connectTls });
      assert.equal((observer.result as { accepted: number }).accepted,0);
      const inFlight=(await messages(setup.grant.id)).find(row => row.decision); assert(inFlight);
      assert.equal((await db.workflowExecution.findUniqueOrThrow({ where: { id: inFlight.executionId! } })).state,'PREPARED');
    } });
    try {
      const first=await runWorkflowServiceOnce(db,commands[0].invocation,commands[0].proof,f.runtime,
        { readEnvironment: () => serviceTestEnvironment,connectTls: peer.connectTls });
      assert(interleaved); assert.equal((first.result as { accepted: number }).accepted,1);
      assert.equal(peer.sockets.length,1);
      assert.equal(peer.sockets[0].writes.filter(value => value.startsWith('From: ')).length,1);
      const rows = await messages(setup.grant.id); assert.equal(rows.filter(row => row.decision).length,1);
      assert.equal((await run(setup.grant.id)).sockets.length,0);
      await revokeWorkflowServiceAuthority(db,f.admin.session,{ id: setup.grant.id,kind: 'GRANT',expectedRevision: 1 },clientProof(f.admin));
    } finally { await peer.close(); }
  }
});

test('grant revocation before DATA and expiry after354 block submission and preserve native outcomes',options,async () => {
  const revoked = await f.create();
  const first = await run(revoked.grant.id,{ beforeReply: async line => {
    if (line.startsWith('RCPT TO:')) await revokeWorkflowServiceAuthority(db,f.admin.session,{ id: revoked.grant.id,kind: 'GRANT',expectedRevision: 1 },clientProof(f.admin));
  } });
  assert.equal(acceptedCount(first),0); assert(!first.sockets[0].writes.includes('DATA\r\n'));
  const [message] = await messages(revoked.grant.id);
  assert.equal(message.message.state,'ERROR'); assert.equal((await reconcileNativeWorkflowExecution(db,f.admin.session,message.messageId)).state,'ERROR');
  const expired = await f.create('LEAD_ACCEPTED',{ validityMs: 2500 });
  const second = await run(expired.grant.id,{ beforeDataReply: async () => { await wait(Math.max(0,Date.parse(expired.input.validUntil)-Date.now()+50)); } });
  assert.equal(acceptedCount(second),0); assert(second.sockets[0].writes.includes('DATA\r\n'));
  assert(!second.sockets[0].writes.some(value => value.startsWith('From: ')));
  const [expiredMessage] = await messages(expired.grant.id); assert.equal(expiredMessage.message.state,'ERROR');
  assert.equal((await reconcileNativeWorkflowExecution(db,f.admin.session,expiredMessage.messageId)).state,'ERROR');
});

test('committed grant revocation serializes with DATA and later native reconciliation keeps the accepted fact',options,async () => {
  const setup = await f.create(); let waiting: Promise<unknown>|undefined, finished=false, blocked=false;
  const result = await run(setup.grant.id,{ beforeDataReply: async () => {
    waiting = revokeWorkflowServiceAuthority(db,f.admin.session,{ id: setup.grant.id,kind: 'GRANT',expectedRevision: 1 },clientProof(f.admin)).then(() => { finished=true; });
    for (let attempt=0; attempt<100 && !blocked; attempt++) {
      const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND cardinality(pg_blocking_pids(pid))>0) AS blocked`;
      blocked=row.blocked; if (!blocked) await wait(10);
    }
    assert(blocked); assert.equal(finished,false);
  } });
  await waiting; assert(blocked); assert(finished); assert.equal(acceptedCount(result),1);
  const [message] = await messages(setup.grant.id); assert.equal(message.message.state,'SENT');
  assert.equal((await reconcileNativeWorkflowExecution(db,f.admin.session,message.messageId)).state,'SENT');
  await assert.rejects(run(setup.grant.id),/DENIED/);
});

async function assign(leadId: string,userId: string) {
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId } });
  await assignCommercialLeadInboxItem(db,{ leadId,targetUserId: userId,expectedInboxVersion: item.version,
    actor: { userId: f.admin.user.id,sessionId: f.admin.session.sessionId!,requireManualAdmin: true } });
}
async function status(leadId: string,next: 'contattato'|'qualificato') {
  return db.$transaction(async tx => {
    const before = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    const after = await tx.lead.update({ where: { id: leadId },data: { status: next } });
    const audit = await tx.auditLog.create({ data: { actorId: f.admin.user.id,entityType: 'Lead',entityId: leadId,event: 'lead_status_change',
      after: { before: { status: before.status },after: { status: after.status } } } });
    return recordWorkflowLeadStatusEvent(tx,leadId,audit.id);
  });
}

test('canonical assignment and status events recover into native email without a preparation session',options,async () => {
  const owner = await syntheticPerson(db,'Referente service operativo','commerciale'), other = await syntheticPerson(db,'Altro referente service','commerciale');
  const assignment = await f.create('ASSIGNMENT_CONFIRMED'); await assign(assignment.received.projection.leadId!,owner.user.id);
  assert.equal(acceptedCount(await run(assignment.grant.id)),1); assert.equal((await run(assignment.grant.id)).sockets.length,0);
  await assign(assignment.received.projection.leadId!,other.user.id);
  assert.equal(acceptedCount(await run(assignment.grant.id)),1);
  assert.equal((await messages(assignment.grant.id)).length,2);
  const change = await f.create('STATUS_CHANGED'); await assign(change.received.projection.leadId!,owner.user.id);
  await status(change.received.projection.leadId!,'contattato');
  assert.equal(acceptedCount(await run(change.grant.id)),1); assert.equal((await run(change.grant.id)).sockets.length,0);
});

test('appointment confirmation/reminder and explicit document requests run under the same grant executor',options,async () => {
  const owner = await syntheticPerson(db,'Ivo service operativo','commerciale');
  const setup = await f.create('APPOINTMENT_BOOKED',{ followup: true }),leadId = setup.received.projection.leadId!;
  await assign(leadId,owner.user.id);
  const calendarId = await saveCalendarAvailability(db,owner.session,defaultCalendarAvailability);
  const current = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const appointment = await saveLeadAppointment(db,owner.session,{ id: randomUUID(),leadId,calendarId,expectedVersion: 0,
    leadVersion: current.updatedAt.toISOString(),operation: 'BOOK',startLocal: '2027-04-05T10:00',durationMinutes: 30 });
  assert.equal(acceptedCount(await run(setup.grant.id)),1);
  const reminder = await db.workflowExecution.findFirstOrThrow({ where: { enrollment: { automationId: setup.rule.id },step: 'REMINDER' } });
  assert.equal(reminder.dueAt.getTime(),appointment.startsAt.getTime()-60000); assert.equal((await run(setup.grant.id)).sockets.length,0);
  await saveLeadAppointment(db,owner.session,{ id: appointment.id,leadId,calendarId,expectedVersion: appointment.version,
    leadVersion: (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).updatedAt.toISOString(),operation: 'CANCEL',startLocal: '',durationMinutes: 30 });
  assert.equal((await db.workflowExecution.findUniqueOrThrow({ where: { id: reminder.id } })).state,'STOPPED');
  assert.equal((await run(setup.grant.id)).sockets.length,0);
  const docs = await f.create('DOCUMENT_REQUESTED'), documentLead = await db.lead.findUniqueOrThrow({ where: { id: docs.received.projection.leadId! } });
  const input = { automationId: docs.rule.id,expectedLeadVersion: documentLead.updatedAt.toISOString(),
    source: { kind: 'DOCUMENT_REQUESTED',leadId: documentLead.id,referenceId: randomUUID(),documents: ['Visura sintetica','Documento sintetico'] } };
  const enrolled = await planWorkflowOperationalEvent(db,f.admin.session,input); assert.equal((await planWorkflowOperationalEvent(db,f.admin.session,input)).id,enrolled.id);
  assert.equal(acceptedCount(await run(docs.grant.id)),1); assert.equal((await run(docs.grant.id)).sockets.length,0);
  await assert.rejects(planWorkflowOperationalEvent(db,f.admin.session,{ ...input,source: { ...input.source,documents: ['Richiesta diversa'] } }),/CONFLICT/);
});

test('internal notice has its own immutable quota decision, one recipient/read receipt and no SMTP or fake email',options,async () => {
  const owner = await syntheticPerson(db,'Destinatario service interno','commerciale'), other = await syntheticPerson(db,'Estraneo service interno','commerciale');
  const setup = await f.create('ASSIGNMENT_CONFIRMED',{ internal: true,maxMessages: 1 }); await assign(setup.received.projection.leadId!,owner.user.id);
  const commands = [createWorkflowServiceCommand(setup.grant.id,f.runtime),createWorkflowServiceCommand(setup.grant.id,f.runtime)], peer = await newsletterTlsPeer();
  try {
    const results = await Promise.all(commands.map(command => runWorkflowServiceOnce(db,command.invocation,command.proof,f.runtime,{ readEnvironment: () => serviceTestEnvironment,connectTls: peer.connectTls })));
    assert.equal(results.reduce((sum,row) => sum+Number((row.result as { internalDelivered: number }).internalDelivered),0),1); assert.equal(peer.sockets.length,0);
    const notices = await db.workflowServiceNotice.findMany({ where: { grantId: setup.grant.id } }); assert.equal(notices.length,1);
    const notice = notices[0], id='workflow-'+notice.executionId;
    assert.equal(notice.recipientUserId,owner.user.id); assert.equal(await db.approvedCommunication.count({ where: { id: notice.executionId } }),0);
    assert.equal(await db.ordinaryEmailDecision.count({ where: { messageId: notice.executionId } }),0);
    assert((await getInternalNotifications(owner.session)).some(row => row.id === id));
    const count=await getInternalNotificationCount(owner.session);
    await markInternalNotificationRead(owner.session,id); await markInternalNotificationRead(owner.session,id);
    assert.equal(await getInternalNotificationCount(owner.session),count-1); assert.equal(await markInternalNotificationRead(other.session,id),null);
    await assert.rejects(db.workflowServiceNotice.update({ where: { executionId: notice.executionId },data: { textHash: 'a'.repeat(64) } }));
    await assign(setup.received.projection.leadId!,other.user.id);
    assert(!(await getInternalNotifications(owner.session,{ state: 'read' })).some(row => row.id === id));
    const next=await run(setup.grant.id); assert.equal((next.result.result as { internalDelivered: number }).internalDelivered,0);
    assert.equal(await db.workflowServiceNotice.count({ where: { grantId: setup.grant.id } }),1);
  } finally { await peer.close(); }
});

test('schema77 personal path stays open but any partial service persistence fails closed',options,async () => {
  const schema='service_legacy_'+randomUUID().replaceAll('-',''),rollback=new Error('SYNTHETIC_ROLLBACK');
  await assert.rejects(db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    const id=randomUUID(); await denyPersonalServiceMessage(tx,id);
    await tx.$executeRawUnsafe('CREATE TABLE "OrdinaryEmailDecision" (id uuid PRIMARY KEY,"sessionId" uuid NOT NULL)');
    await denyPersonalServiceMessage(tx,id);
    await tx.$executeRawUnsafe('ALTER TABLE "OrdinaryEmailDecision" ADD COLUMN "serviceMessageId" uuid');
    await assert.rejects(denyPersonalServiceMessage(tx,id),/PERSISTENCE_INCOMPLETE/);
    await tx.$executeRawUnsafe('ALTER TABLE "OrdinaryEmailDecision" DROP COLUMN "serviceMessageId"');
    await tx.$executeRawUnsafe('CREATE TABLE "WorkflowServiceGrant" (id uuid PRIMARY KEY)');
    await assert.rejects(denyPersonalServiceMessage(tx,id),/PERSISTENCE_INCOMPLETE/);
    throw rollback;
  }),error => error === rollback);
});

test('setter sees hold reason and next action; repeated polls preserve one history and audit transition',options,async () => {
  const setup = await f.create('LEAD_ACCEPTED',{ maxMessages: 1 }), second=await f.intake.receive();
  const setter=await syntheticPerson(db,'Michela service hold sintetica','commerciale');
  await assign(setup.received.projection.leadId!,setter.user.id); await assign(second.projection.leadId!,setter.user.id);
  assert.equal(acceptedCount(await run(setup.grant.id)),1);
  const stopped=await db.workflowExecution.findFirstOrThrow({ where: { enrollment: { automationId: setup.rule.id },stopReason: 'WORKFLOW_SERVICE_QUOTA' },include: { enrollment: true } });
  const timeline=await readLeadWorkflowExecutions(db,setter.session,stopped.enrollment.leadId);
  const shown=timeline.flatMap(row => row.executions).find(row => row.id === stopped.id); assert(shown);
  assert.equal(shown.stopReason,'WORKFLOW_SERVICE_QUOTA'); assert.match(workflowServiceHoldMessage(shown.stopReason!),/admin verifica quota/);
  const audits=await db.auditLog.count({ where: { entityType: 'WorkflowServiceGrant',entityId: setup.grant.id,event: 'workflow_service_held' } });
  await run(setup.grant.id); await run(setup.grant.id);
  assert.equal(await db.auditLog.count({ where: { entityType: 'WorkflowServiceGrant',entityId: setup.grant.id,event: 'workflow_service_held' } }),audits);
  assert.deepEqual((await db.workflowExecution.findUniqueOrThrow({ where: { id: stopped.id } })).history,stopped.history);
  const newsletter=await f.create('NEWSLETTER'); await assign(newsletter.received.projection.leadId!,setter.user.id); await wait(550);
  await f.preferences.suppressPublic(newsletter.received.event.payload.email!,randomUUID());
  const held=await run(newsletter.grant.id); assert.equal(held.sockets.length,0);
  const newsletterTimeline=await readLeadNewsletterExecutions(db,setter.session,newsletter.received.projection.leadId!);
  assert.equal(newsletterTimeline[0].state,'ERROR'); assert.equal(newsletterTimeline[0].reason,'NEWSLETTER_NATIVE_ADMISSION_DENIED');
  assert.match(workflowServiceHoldMessage(newsletterTimeline[0].reason!),/consenso attuale/);
});

test('lost result persistence retains native journal proof; admin reconciles accepted bytes after grant revocation without resend',options,async () => {
  const setup=await f.create(),peer=await newsletterTlsPeer(),original=f.runtime.observationSink;
  let failReceipt=false;
  f.runtime.observationSink=async (...args) => { await original(...args); failReceipt=true; };
  const faultDb=new Proxy(db,{ get(target,name) {
    if (name === '$transaction') return (...args: unknown[]) => {
      if (failReceipt) { failReceipt=false; throw new Error('SYNTHETIC_LOST_RECEIPT_PERSISTENCE'); }
      return Reflect.apply(target.$transaction,target,args);
    };
    const value=Reflect.get(target,name,target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const command=createWorkflowServiceCommand(setup.grant.id,f.runtime);
    await assert.rejects(runWorkflowServiceOnce(faultDb,command.invocation,command.proof,f.runtime,{ readEnvironment: () => serviceTestEnvironment,connectTls: peer.connectTls }),/SYNTHETIC_LOST_RECEIPT_PERSISTENCE/);
    assert.equal(peer.sockets[0].writes.filter(value => value.startsWith('From: ')).length,1);
    const [message]=await messages(setup.grant.id), attempt=await db.ordinaryEmailAttempt.findFirstOrThrow({ where: { messageId: message.messageId },include: { claim: true } });
    assert.equal(attempt.state,'CLAIMED'); assert(attempt.claim); assert(f.observations.has(attempt.id));
    assert.equal((await run(setup.grant.id)).sockets.length,0);
    await revokeWorkflowServiceAuthority(db,f.admin.session,{ id: setup.grant.id,kind: 'GRANT',expectedRevision: 1 },clientProof(f.admin));
    await wait(Math.max(0,attempt.claim.expiresAt.getTime()-Date.now()+20));
    const runtime={ key: clientProof(f.admin).key,readObservation: async (id: string) => { const evidence=f.observations.get(id); assert(evidence); return evidence; } };
    const reference={ messageId: message.messageId,attemptId: attempt.id },preview=await previewStoredOrdinaryRecovery(db,f.admin.session,reference,runtime);
    assert.equal(preview.status,'READY'); assert(preview.status === 'READY');
    const confirmed=await confirmStoredOrdinaryRecovery(db,f.admin.session,{ ...reference,token: preview.token,reason: 'SYNTHETIC_RECOVERY_REVIEW_ONLY',confirmed: true },clientProof(f.admin),runtime);
    assert.equal(confirmed.status,'RECORDED');
    assert.equal((await reconcileNativeWorkflowExecution(db,f.admin.session,message.messageId)).state,'SENT');
    assert.equal(await db.ordinaryEmailAttempt.count({ where: { messageId: message.messageId } }),1);
  } finally { f.runtime.observationSink=original; await peer.close(); }
});
