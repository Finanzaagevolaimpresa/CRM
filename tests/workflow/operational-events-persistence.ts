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
import { planWorkflowOperationalEvent } from '../../src/lib/workflow-event-planner';
import { prepareNativeWorkflowEnrollment, readLeadWorkflowExecutions, readNativeWorkflowLeadSetup, runSyntheticWorkflowEnrollment,
  stopPendingWorkflowExecutions } from '../../src/lib/workflow-executions';
import { readWorkflowInternalNotices } from '../../src/lib/workflow-internal-notices';
import { getInternalNotificationCount, getInternalNotifications, markInternalNotificationRead } from '../../src/lib/internal-notifications';
import { assignCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { saveCalendarAvailability, saveLeadAppointment } from '../../src/lib/personal-calendar';
import { defaultCalendarAvailability } from '../../src/lib/personal-calendar-contract';
import { readRecordUpdateSetup, previewRecordUpdate, confirmRecordUpdate } from '../../src/lib/record-updates';
import type { WorkflowSourceInput } from '../../src/lib/workflow-event-source';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person, owner: Person, other: Person, intake: Awaited<ReturnType<typeof syntheticIntakeFixture>>;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert.equal(process.env.APP_ENV, 'test'); await collectionKey(db);
  admin = await syntheticPerson(db, 'Admin eventi sintetici', 'admin');
  owner = await syntheticPerson(db, 'Referente eventi sintetici', 'commerciale'); other = await syntheticPerson(db, 'Altro eventi sintetici', 'commerciale');
  intake = await syntheticIntakeFixture(db, admin.user.id);
});
after(() => db.$disconnect());

async function assign(leadId: string, person = owner) {
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId } });
  await assignCommercialLeadInboxItem(db, { leadId, actor: { userId: admin.user.id, sessionId: admin.session.sessionId!, requireManualAdmin: true },
    targetUserId: person.user.id, expectedInboxVersion: item.version });
  return db.commercialLeadActivity.findFirstOrThrow({ where: { inboxItemId: item.id, activityType: 'ASSIGNED' }, orderBy: { sequence: 'desc' } });
}
async function lead() {
  const received = await intake.receive(); assert(received.projection.leadId);
  const activity = await assign(received.projection.leadId);
  return { leadId: received.projection.leadId, activity };
}
async function rule(event: WorkflowSourceInput['kind'], internal = false, subsequent = false) {
  const purpose = internal ? 'INTERNAL_NOTICE' : event === 'APPOINTMENT_BOOKED' ? 'APPOINTMENT' : event === 'DOCUMENT_REQUESTED' ? 'DOCUMENT_REQUEST' : 'CONFIRMATION';
  const template = { id: randomUUID(), familyId: randomUUID(), expectedVersion: 0, name: 'Test evento ' + event, purpose,
    subject: 'Test {{companyName}}', body: 'Ciao {{firstName}}.' + (event === 'APPOINTMENT_BOOKED' ? ' Appuntamento {{appointmentAt}}.'
      : event === 'DOCUMENT_REQUESTED' ? ' Documenti: {{documentList}}.' : ''), state: 'PUBLISHED', authorizationReference: 'SYNTHETIC_TEST_ONLY' };
  await saveWorkflowTemplate(db, admin.session, template, clientProof(admin));
  const following = { ...template, id: randomUUID(), familyId: randomUUID(), purpose: internal ? 'INTERNAL_NOTICE' : event === 'APPOINTMENT_BOOKED' ? 'APPOINTMENT' : 'FOLLOW_UP' };
  if (subsequent) await saveWorkflowTemplate(db, admin.session, following, clientProof(admin));
  const input = { id: randomUUID(), expectedVersion: 0, name: 'Evento persistito ' + event, event, state: 'TEST_READY', delayMinutes: 60,
    configuration: { kind: 'INDIVIDUAL', action: internal ? 'INTERNAL_NOTICE' : 'EMAIL', confirmationTemplateId: template.id,
      followupTemplateId: subsequent ? following.id : null, requireAssociated: true, stopOnReply: true, stopOnAppointment: true, newsletterAt: null, recipientIds: [] } };
  await saveWorkflowRule(db, admin.session, input, clientProof(admin)); return input;
}
async function command(automationId: string, source: WorkflowSourceInput) {
  const current = await db.lead.findUniqueOrThrow({ where: { id: source.leadId } });
  return { automationId, source, expectedLeadVersion: current.updatedAt.toISOString() };
}
const execute = (enrollmentId: string, now = new Date().toISOString()) => runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId, now });

test('appointment source creates its confirmation and distinct reminder; replay, move and cancellation are safe', { skip: !enabled }, async () => {
  const f = await lead(), calendarId = await saveCalendarAvailability(db, owner.session, defaultCalendarAvailability), automation = await rule('APPOINTMENT_BOOKED', false, true);
  const current = await db.lead.findUniqueOrThrow({ where: { id: f.leadId } });
  await saveLeadAppointment(db, admin.session, { id: randomUUID(), leadId: f.leadId, calendarId, expectedVersion: 0,
    leadVersion: current.updatedAt.toISOString(), operation: 'BOOK', startLocal: '2027-03-01T10:00', durationMinutes: 30 });
  let appointment = await db.leadAppointment.findUniqueOrThrow({ where: { leadId: f.leadId } });
  const input = await command(automation.id, { kind: 'APPOINTMENT_BOOKED', leadId: f.leadId, referenceId: appointment.id, referenceVersion: appointment.version });
  const both = await Promise.all([planWorkflowOperationalEvent(db, admin.session, input, true), planWorkflowOperationalEvent(db, admin.session, input, true)]);
  assert.equal(both[0].id, both[1].id); assert.equal((await execute(both[0].id)).executed, 1);
  await db.$transaction(tx => stopPendingWorkflowExecutions(tx, { leadId: f.leadId, reason: 'REPLIED', evidenceId: 'SYNTHETIC_RESPONSE_BOUNDARY' }));
  const reminder = await db.workflowExecution.findUniqueOrThrow({ where: { enrollmentId_step: { enrollmentId: both[0].id, step: 'REMINDER' } } });
  assert.equal(reminder.state, 'PENDING'); assert.equal(reminder.dueAt.getTime(), appointment.startsAt.getTime() - 3_600_000);
  assert.equal((await execute(both[0].id, reminder.dueAt.toISOString())).executed, 1); assert.equal((await execute(both[0].id, reminder.dueAt.toISOString())).executed, 0);

  const second = await lead(), secondLead = await db.lead.findUniqueOrThrow({ where: { id: second.leadId } });
  await saveLeadAppointment(db, admin.session, { id: randomUUID(), leadId: second.leadId, calendarId, expectedVersion: 0,
    leadVersion: secondLead.updatedAt.toISOString(), operation: 'BOOK', startLocal: '2027-03-01T11:00', durationMinutes: 30 });
  appointment = await db.leadAppointment.findUniqueOrThrow({ where: { leadId: second.leadId } });
  const old = await planWorkflowOperationalEvent(db, admin.session, await command(automation.id, { kind: 'APPOINTMENT_BOOKED', leadId: second.leadId,
    referenceId: appointment.id, referenceVersion: appointment.version }), true);
  await execute(old.id);
  await saveLeadAppointment(db, admin.session, { id: appointment.id, leadId: second.leadId, calendarId, expectedVersion: appointment.version,
    leadVersion: (await db.lead.findUniqueOrThrow({ where: { id: second.leadId } })).updatedAt.toISOString(), operation: 'BOOK', startLocal: '2027-03-01T12:00', durationMinutes: 30 });
  assert.equal((await execute(old.id, '2027-03-01T12:00:00Z')).executed, 0);
  assert.equal((await db.workflowExecution.findUniqueOrThrow({ where: { enrollmentId_step: { enrollmentId: old.id, step: 'REMINDER' } } })).state, 'STOPPED');
  appointment = await db.leadAppointment.findUniqueOrThrow({ where: { leadId: second.leadId } });
  const changed = await planWorkflowOperationalEvent(db, admin.session, await command(automation.id, { kind: 'APPOINTMENT_BOOKED', leadId: second.leadId,
    referenceId: appointment.id, referenceVersion: appointment.version }), true);
  assert.notEqual(changed.id, old.id); await execute(changed.id);
  await saveLeadAppointment(db, admin.session, { id: appointment.id, leadId: second.leadId, calendarId, expectedVersion: appointment.version,
    leadVersion: (await db.lead.findUniqueOrThrow({ where: { id: second.leadId } })).updatedAt.toISOString(), operation: 'CANCEL', startLocal: '', durationMinutes: 30 });
  assert.equal((await execute(changed.id, '2027-03-01T12:00:00Z')).executed, 0);
});

test('assignment internal notice has a recipient FK, one receipt and one read; reassignment revokes old access', { skip: !enabled }, async () => {
  const f = await lead(), automation = await rule('ASSIGNMENT_CONFIRMED', true);
  const input = await command(automation.id, { kind: 'ASSIGNMENT_CONFIRMED', leadId: f.leadId, referenceId: f.activity.id, origin: 'COMMERCIAL_ACTIVITY' });
  const enrolled = await planWorkflowOperationalEvent(db, admin.session, input, true);
  await assert.rejects(planWorkflowOperationalEvent(db, other.session, input, true), /DENIED/);
  const results = await Promise.all([execute(enrolled.id), execute(enrolled.id)]); assert.equal(results.reduce((sum, item) => sum + item.executed, 0), 1);
  const execution = await db.workflowExecution.findFirstOrThrow({ where: { enrollmentId: enrolled.id } });
  assert.equal(execution.recipientUserId, owner.user.id); assert.equal(execution.state, 'SENT'); assert.equal(execution.attemptCount, 1);
  const id = 'workflow-' + execution.id;
  assert((await readWorkflowInternalNotices(owner.session)).some(row => row.id === id));
  assert(!(await readWorkflowInternalNotices(other.session)).some(row => row.id === id));
  const before = await getInternalNotificationCount(owner.session);
  assert((await getInternalNotifications(owner.session)).some(row => row.id === id));
  assert.equal(await markInternalNotificationRead(other.session, id), null);
  await markInternalNotificationRead(owner.session, id); await markInternalNotificationRead(owner.session, id);
  assert.equal(await getInternalNotificationCount(owner.session), before - 1);
  assert((await getInternalNotifications(owner.session, { state: 'read' })).some(row => row.id === id));
  const reassignment = await assign(f.leadId, other);
  assert(!(await readWorkflowInternalNotices(owner.session)).some(row => row.id === id));
  assert(!(await getInternalNotifications(owner.session, { state: 'read' })).some(row => row.id === id));
  assert.equal(await markInternalNotificationRead(owner.session, id), null);
  const currentTimeline = await readLeadWorkflowExecutions(db, other.session, f.leadId);
  const previousNotice = currentTimeline.flatMap(row => row.executions).find(row => row.id === execution.id)!;
  assert.equal(previousNotice.notice, null); assert.deepEqual(previousNotice.events, []);
  await assert.rejects(readLeadWorkflowExecutions(db, owner.session, f.leadId));
  await assert.rejects(planWorkflowOperationalEvent(db, admin.session, await command(automation.id, input.source), true), /SOURCE_CHANGED/);
  const pendingLead = await lead();
  const pending = await planWorkflowOperationalEvent(db, admin.session, await command(automation.id, { kind: 'ASSIGNMENT_CONFIRMED',
    leadId: pendingLead.leadId, referenceId: pendingLead.activity.id, origin: 'COMMERCIAL_ACTIVITY' }), true);
  await assign(pendingLead.leadId, other); assert.equal((await execute(pending.id)).executed, 0);
  assert.equal((await db.workflowExecution.findFirstOrThrow({ where: { enrollmentId: pending.id } })).state, 'STOPPED');
  // The same source adapter also serves the gated native UI command. Internal
  // receipt delivery opens no email transport and needs no mailbox fixture.
  const nativeRule = await rule('ASSIGNMENT_CONFIRMED', true), priorMode = process.env.WORKFLOW_NATIVE_PREPARATION_MODE;
  const nativeInput = await command(nativeRule.id, { kind: 'ASSIGNMENT_CONFIRMED', leadId: f.leadId,
    referenceId: reassignment.id, origin: 'COMMERCIAL_ACTIVITY' });
  try {
    delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE;
    assert.equal(await readNativeWorkflowLeadSetup(db, admin.session, f.leadId), null);
    await assert.rejects(planWorkflowOperationalEvent(db, admin.session, nativeInput), /DISABLED/);
    process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'enabled';
    await saveWorkflowRule(db, admin.session, { ...nativeRule, expectedVersion: 1, state: 'ACTIVE' }, clientProof(admin));
    const choices = await readNativeWorkflowLeadSetup(db, admin.session, f.leadId);
    assert(choices); assert(choices.eventRules.some(row => row.id === nativeRule.id));
    assert(choices.sources.some(row => row.referenceId === reassignment.id));
    const native = await planWorkflowOperationalEvent(db, admin.session, nativeInput);
    assert.equal((await planWorkflowOperationalEvent(db, admin.session, nativeInput)).id, native.id);
    assert.equal((await prepareNativeWorkflowEnrollment(db, admin.session, { enrollmentId: native.id })).prepared, 1);
    assert.equal((await prepareNativeWorkflowEnrollment(db, admin.session, { enrollmentId: native.id })).prepared, 0);
    const notice = await db.workflowExecution.findFirstOrThrow({ where: { enrollmentId: native.id } });
    assert.equal(notice.recipientUserId, other.user.id); assert.equal(notice.state, 'SENT');
    assert.equal((await db.workflowEnrollment.findUniqueOrThrow({ where: { id: native.id } })).synthetic, false);
    assert.equal(await db.communicationAttempt.count({ where: { messageId: notice.id } }), 0);
    assert((await getInternalNotifications(other.session)).some(row => row.id === 'workflow-' + notice.id));
  } finally {
    if (priorMode === undefined) delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE; else process.env.WORKFLOW_NATIVE_PREPARATION_MODE = priorMode;
  }
});

test('state change binds the native immutable event and current record version; stale event cannot send', { skip: !enabled }, async () => {
  const f = await lead(), automation = await rule('STATUS_CHANGED');
  const setup = await readRecordUpdateSetup(db, admin.session, 'LEAD', f.leadId);
  const nativeRule = { commandId: randomUUID(), kind: 'LEAD', recordId: f.leadId, operation: 'RULE', expectedVersion: setup.expectedVersion,
    ruleVersion: setup.rule?.version ?? 0, selection: { people: [owner.user.id], groups: [] }, events: ['STATE_CHANGED'], persistent: false, expiresAt: null, patch: null };
  const preview = await previewRecordUpdate(db, admin.session, nativeRule);
  await confirmRecordUpdate(db, admin.session, nativeRule, preview.digest, clientProof(admin));
  // Synthetic native writer: the real DB capture trigger creates the event.
  await db.lead.update({ where: { id: f.leadId }, data: { status: 'contattato' } });
  let event = await db.recordUpdateEvent.findFirstOrThrow({ where: { kind: 'LEAD', recordId: f.leadId, event: 'STATE_CHANGED' }, orderBy: { occurredAt: 'desc' } });
  const input = await command(automation.id, { kind: 'STATUS_CHANGED', leadId: f.leadId, referenceId: event.id });
  const first = await planWorkflowOperationalEvent(db, admin.session, input, true);
  assert.equal((await planWorkflowOperationalEvent(db, admin.session, input, true)).id, first.id);
  assert.equal((await execute(first.id)).executed, 1); assert.equal((await execute(first.id)).executed, 0);
  await db.lead.update({ where: { id: f.leadId }, data: { status: 'qualificato' } });
  event = await db.recordUpdateEvent.findFirstOrThrow({ where: { kind: 'LEAD', recordId: f.leadId, event: 'STATE_CHANGED' }, orderBy: { occurredAt: 'desc' } });
  const pending = await planWorkflowOperationalEvent(db, admin.session, await command(automation.id, { kind: 'STATUS_CHANGED', leadId: f.leadId, referenceId: event.id }), true);
  await db.lead.update({ where: { id: f.leadId }, data: { status: 'in_trattativa' } });
  assert.equal((await execute(pending.id)).executed, 0);
  await assert.rejects(planWorkflowOperationalEvent(db, admin.session, input, true));
});

test('document request is a persisted explicit command with immutable list, replay protection and scoped access', { skip: !enabled }, async () => {
  const f = await lead(), automation = await rule('DOCUMENT_REQUESTED', false, true);
  const input = await command(automation.id, { kind: 'DOCUMENT_REQUESTED', leadId: f.leadId, referenceId: randomUUID(), documents: ['Visura sintetica', 'Documento sintetico'] });
  const planned = await planWorkflowOperationalEvent(db, admin.session, input, true);
  assert.equal((await planWorkflowOperationalEvent(db, admin.session, input, true)).id, planned.id);
  await assert.rejects(planWorkflowOperationalEvent(db, admin.session, { ...input, source: { ...input.source, documents: ['Altra richiesta'] } }, true), /CONFLICT/);
  await assert.rejects(planWorkflowOperationalEvent(db, other.session, input, true), /DENIED/);
  assert.equal((await execute(planned.id)).executed, 1);
  const confirmation = await db.workflowExecution.findUniqueOrThrow({ where: { enrollmentId_step: { enrollmentId: planned.id, step: 'CONFIRMATION' } } });
  assert((confirmation.templateSnapshot as { rendered: { body: string } }).rendered.body.includes('Visura sintetica\nDocumento sintetico'));
  await assert.rejects(db.workflowEnrollment.update({ where: { id: planned.id }, data: { snapshot: {} } }));
  await db.$transaction(tx => stopPendingWorkflowExecutions(tx, { leadId: f.leadId, reason: 'REPLIED', evidenceId: 'SYNTHETIC_DOCUMENT_REPLY' }));
  assert.equal((await execute(planned.id, '2027-03-01T12:00:00Z')).executed, 0);
});
