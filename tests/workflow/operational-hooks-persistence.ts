import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { collectionKey } from '../payment-collection/fixture';
import { clientProof } from '../selective-clients/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { saveWorkflowRule, saveWorkflowTemplate } from '../../src/lib/workflow-automations';
import { saveCalendarAvailability, saveLeadAppointment } from '../../src/lib/personal-calendar';
import { defaultCalendarAvailability } from '../../src/lib/personal-calendar-contract';
import { assignCommercialLeadInboxItem, initializeCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { captureWorkflowOperationalEventAfterCommit, recordWorkflowLeadStatusEvent, recoverWorkflowOperationalEvents } from '../../src/lib/workflow-operational-capture';
import { stopStaleWorkflowEnrollments } from '../../src/lib/workflow-executions';
import { confirmRecordUpdate, previewRecordUpdate, readRecordUpdateSetup, updateActor } from '../../src/lib/record-updates';
import { appendResponsibilityDecision } from '../../src/lib/responsibility';

const db = new PrismaClient(), run = process.env.RUN_DB_TESTS === '1', oldMode = process.env.WORKFLOW_NATIVE_PREPARATION_MODE;
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person, owner: Person, other: Person, calendarId: string;
let priorAuthority: Awaited<ReturnType<typeof db.ordinaryEmailAuthority.findUnique>>;
const automation: Record<string, Awaited<ReturnType<typeof rule>>> = {};
let slot = 0;
const nextSlot = () => `2027-04-05T${String(9 + Math.floor(slot / 2)).padStart(2, '0')}:${slot++ % 2 ? '30' : '00'}`;
async function rule(event: 'APPOINTMENT_BOOKED' | 'ASSIGNMENT_CONFIRMED' | 'STATUS_CHANGED') {
  const purpose = event === 'APPOINTMENT_BOOKED' ? 'APPOINTMENT' : 'INTERNAL_NOTICE';
  const template = { id: randomUUID(), familyId: randomUUID(), expectedVersion: 0, name: 'Hook sintetico ' + event, purpose,
    subject: 'Prova {{companyName}}', body: 'Prova {{firstName}}', state: 'PUBLISHED', authorizationReference: 'SYNTHETIC_ONLY_NO_PROVIDER' };
  await saveWorkflowTemplate(db, admin.session, template, clientProof(admin));
  const input = { id: randomUUID(), expectedVersion: 0, name: 'Hook ' + event, event, state: 'ACTIVE', delayMinutes: 60,
    configuration: { kind: 'INDIVIDUAL', action: purpose === 'APPOINTMENT' ? 'EMAIL' : 'INTERNAL_NOTICE',
      confirmationTemplateId: template.id, followupTemplateId: event === 'APPOINTMENT_BOOKED' ? template.id : null,
      requireAssociated: true, stopOnReply: true, stopOnAppointment: true, newsletterAt: null, recipientIds: [] } };
  await saveWorkflowRule(db, admin.session, input, clientProof(admin)); return input;
}
before(async () => {
  if (!run) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert.equal(process.env.APP_ENV, 'test'); await collectionKey(db);
  admin = await syntheticPerson(db, 'Admin hook operativo sintetico', 'admin');
  owner = await syntheticPerson(db, 'Ivo hook sintetico', 'commerciale'); other = await syntheticPerson(db, 'Altro hook sintetico', 'commerciale');
  calendarId = await saveCalendarAvailability(db, owner.session, defaultCalendarAvailability);
  if (!await db.commercialLeadSlaPolicyVersion.count({ where: { status: 'ACTIVE' } })) await db.commercialLeadSlaPolicyVersion.create({ data: {
    policyCode: 'COMMERCIAL_FIRST_RESPONSE', version: 1, status: 'ACTIVE', calendarCode: 'CONTINUOUS_24X7', timezoneCode: 'UTC', responseTargetSeconds: 3600, createdById: admin.user.id } });
  priorAuthority = await db.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
  const box = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'assistenza@finanzaagevolaimpresa.it' } });
  await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority" (id,"userId","mailboxId",enabled) VALUES ('ordinary-email',${admin.user.id},${box.id}::uuid,true)
    ON CONFLICT(id) DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId",enabled=true,revision="OrdinaryEmailAuthority".revision+1`;
  process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'enabled';
  for (const event of ['APPOINTMENT_BOOKED', 'ASSIGNMENT_CONFIRMED', 'STATUS_CHANGED'] as const) automation[event] = await rule(event);
});
after(async () => {
  if (run && admin) {
    if (priorAuthority) await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "userId"=${priorAuthority.userId},"mailboxId"=${priorAuthority.mailboxId}::uuid,
      enabled=${priorAuthority.enabled},revision=revision+1 WHERE id='ordinary-email'`;
    else await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET enabled=false,revision=revision+1 WHERE id='ordinary-email'`;
  }
  if (oldMode === undefined) delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE; else process.env.WORKFLOW_NATIVE_PREPARATION_MODE = oldMode;
  await db.$disconnect();
});
async function lead(inbox = false) {
  const row = await db.lead.create({ data: { firstName: 'Persona', lastName: 'Sintetica', companyName: 'Hook ' + randomUUID(),
    email: randomUUID() + '@invalid.test', assignedToId: inbox ? null : owner.user.id, source: 'CRM', leadSource: 'manuale' } });
  if (inbox) await initializeCommercialLeadInboxItem(db, { leadId: row.id, actor: { userId: admin.user.id, sessionId: admin.session.sessionId! }, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE' });
  return row;
}
async function book(leadId: string, operation: 'BOOK' | 'CANCEL' = 'BOOK') {
  const current = await db.lead.findUniqueOrThrow({ where: { id: leadId } }), previous = await db.leadAppointment.findUnique({ where: { leadId } });
  return saveLeadAppointment(db, owner.session, { id: previous?.id ?? randomUUID(), leadId, calendarId, leadVersion: current.updatedAt.toISOString(),
    expectedVersion: previous?.version ?? 0, operation, startLocal: operation === 'BOOK' ? nextSlot() : '', durationMinutes: 30 });
}
const appointmentSource = (row: Awaited<ReturnType<typeof book>>) => ({ kind: 'APPOINTMENT_BOOKED' as const, leadId: row.leadId, referenceId: row.id, referenceVersion: row.version });
async function assign(leadId: string, targetUserId = owner.user.id) {
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId } });
  await assignCommercialLeadInboxItem(db, { leadId, targetUserId, expectedInboxVersion: item.version,
    actor: { userId: admin.user.id, sessionId: admin.session.sessionId!, requireManualAdmin: true } });
  const activity = await db.commercialLeadActivity.findFirstOrThrow({ where: { inboxItemId: item.id, activityType: 'ASSIGNED' }, orderBy: { sequence: 'desc' } });
  return { kind: 'ASSIGNMENT_CONFIRMED' as const, leadId, referenceId: activity.id, origin: 'COMMERCIAL_ACTIVITY' as const };
}
async function status(leadId: string, next: 'contattato' | 'qualificato', rollback = false, capture = true) {
  const source = await db.$transaction(async tx => {
    const auth = await updateActor(tx, admin.session); assert.equal(auth.actor.role, 'admin');
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${leadId} FOR UPDATE`;
    const before = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    const after = await tx.lead.update({ where: { id: leadId }, data: { status: next } });
    const audit = await tx.auditLog.create({ data: { actorId: auth.actor.id, entityType: 'Lead', entityId: leadId, event: 'lead_status_change',
      after: { before: { status: before.status }, after: { status: after.status } } } });
    const source = await recordWorkflowLeadStatusEvent(tx, leadId, audit.id);
    await stopStaleWorkflowEnrollments(tx, leadId); await auth.finish();
    if (rollback) throw new Error('SYNTHETIC_COMMAND_ROLLBACK'); return source;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (capture) await captureWorkflowOperationalEventAfterCommit(db, source); return source;
}
const enrollments = (leadId: string) => db.workflowEnrollment.findMany({ where: { leadId }, orderBy: { createdAt: 'asc' }, include: { executions: true } });

test('operational hooks are default-off; bounded authenticated recovery records only intent once', { skip: !run }, async () => {
  delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE;
  const rows = await Promise.all([lead(), lead(), lead()]);
  const sources = [];
  for (const row of rows) { sources.push(appointmentSource(await book(row.id))); assert.equal((await enrollments(row.id)).length, 0); }
  const untouched = await lead(); assert.equal(await status(untouched.id, 'contattato'), null);
  assert.equal(await db.recordUpdateEvent.count({ where: { kind: 'LEAD', recordId: untouched.id } }), 0);
  await assert.rejects(recoverWorkflowOperationalEvents(db, admin.session, { limit: 1 }), /DISABLED/);
  process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'enabled';
  for (let index = 0; index < 3; index++) {
    const result = await recoverWorkflowOperationalEvents(db, admin.session, { automationId: automation.APPOINTMENT_BOOKED.id, limit: 1 });
    assert.deepEqual(result, { examined: 1, captured: 1, providerCalls: 0 });
  }
  assert.equal((await recoverWorkflowOperationalEvents(db, admin.session, { automationId: automation.APPOINTMENT_BOOKED.id, limit: 1 })).captured, 0);
  await Promise.all(sources.map(source => captureWorkflowOperationalEventAfterCommit(db, source)));
  for (const row of rows) { const enrolled = await enrollments(row.id); assert.equal(enrolled.length, 1); assert(enrolled[0].executions.every(e => e.state === 'PENDING' && e.attemptCount === 0)); }
  assert.equal(await db.approvedCommunication.count({ where: { leadId: { in: rows.map(row => row.id) } } }), 0);
});

test('native booking and move capture their version; move and cancellation stop obsolete reminders immediately', { skip: !run }, async () => {
  const row = await lead(), first = await book(row.id);
  assert.equal((await enrollments(row.id)).length, 1);
  await Promise.all([captureWorkflowOperationalEventAfterCommit(db, appointmentSource(first)), captureWorkflowOperationalEventAfterCommit(db, appointmentSource(first))]);
  assert.equal((await enrollments(row.id)).length, 1);
  await book(row.id);
  let plans = await enrollments(row.id); assert.equal(plans.length, 2); assert.equal(plans[0].state, 'STOPPED');
  assert(plans[0].executions.every(e => e.state === 'STOPPED'));
  await book(row.id, 'CANCEL'); plans = await enrollments(row.id);
  assert(plans.every(p => p.state === 'STOPPED' && p.executions.every(e => e.state === 'STOPPED')));
  assert.equal(await db.leadAppointment.count({ where: { leadId: row.id } }), 1);
});

test('N14 assignment captures one canonical activity, rejects its duplicate responsibility source and stops after reassignment', { skip: !run }, async () => {
  const row = await lead(true), source = await assign(row.id);
  const first = await enrollments(row.id); assert.equal(first.length, 1); assert.equal(first[0].executions[0].recipientUserId, owner.user.id);
  const decision = await db.auditLog.findFirstOrThrow({ where: { entityType: 'Lead', entityId: row.id, event: 'responsibility_assigned' } });
  await captureWorkflowOperationalEventAfterCommit(db, { ...source, origin: 'RESPONSIBILITY', referenceId: decision.id });
  await captureWorkflowOperationalEventAfterCommit(db, source); assert.equal((await enrollments(row.id)).length, 1);
  await assign(row.id, other.user.id);
  const plans = await enrollments(row.id); assert.equal(plans.length, 2); assert.equal(plans[0].state, 'STOPPED');
  assert.equal(plans[1].executions[0].recipientUserId, other.user.id);
});

test('status fact needs no notification rule; an existing trigger event is reused and command rollback removes the fact', { skip: !run }, async () => {
  const row = await lead(); assert.equal(await db.recordUpdateRule.count({ where: { kind: 'LEAD', recordId: row.id } }), 0);
  const source = await status(row.id, 'contattato'); assert(source);
  await captureWorkflowOperationalEventAfterCommit(db, source);
  assert.equal(await db.recordUpdateEvent.count({ where: { kind: 'LEAD', recordId: row.id } }), 1);
  assert.equal((await enrollments(row.id)).length, 1);
  assert.equal(await db.recordUpdateDelivery.count({ where: { event: { recordId: row.id } } }), 0);
  const notified = await lead(), setup = await readRecordUpdateSetup(db, admin.session, 'LEAD', notified.id);
  const input = { commandId: randomUUID(), kind: 'LEAD', recordId: notified.id, operation: 'RULE', expectedVersion: setup.expectedVersion, ruleVersion: 0,
    selection: { people: [owner.user.id], groups: [] }, events: ['STATE_CHANGED'], persistent: false, expiresAt: null, patch: null };
  const preview = await previewRecordUpdate(db, admin.session, input);
  await confirmRecordUpdate(db, admin.session, input, preview.digest, clientProof(admin));
  await status(notified.id, 'contattato');
  assert.equal(await db.recordUpdateEvent.count({ where: { kind: 'LEAD', recordId: notified.id } }), 1);
  assert.equal((await enrollments(notified.id)).length, 1);
  assert.equal(await db.recordUpdateDelivery.count({ where: { event: { recordId: notified.id } } }), 1);
  const rolledBack = await lead(); await assert.rejects(status(rolledBack.id, 'contattato', true), /SYNTHETIC_COMMAND_ROLLBACK/);
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: rolledBack.id } })).status, 'nuovo');
  assert.equal(await db.recordUpdateEvent.count({ where: { kind: 'LEAD', recordId: rolledBack.id } }), 0);
  assert.equal((await enrollments(rolledBack.id)).length, 0);
});

test('recovery uses durable status and direct assignment facts; competing first capture creates one enrollment', { skip: !run }, async () => {
  const changed = await lead();
  await status(changed.id, 'contattato', false, false); assert.equal((await enrollments(changed.id)).length, 0);
  assert.deepEqual(await recoverWorkflowOperationalEvents(db, admin.session, { automationId: automation.STATUS_CHANGED.id, limit: 1 }),
    { examined: 1, captured: 1, providerCalls: 0 });
  assert.equal((await enrollments(changed.id)).length, 1);
  const assigned = await lead();
  await db.$transaction(async tx => {
    const auth = await updateActor(tx, admin.session);
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${assigned.id} FOR UPDATE`;
    await tx.lead.update({ where: { id: assigned.id }, data: { assignedToId: other.user.id } });
    await appendResponsibilityDecision(tx, { kind: 'Lead', id: assigned.id, actorId: auth.actor.id, allowed: true,
      reason: 'SYNTHETIC_AUTHORIZED_ASSIGNMENT', state: { clientId: null, projectId: null, clientServiceId: null,
        commercialOwnerId: other.user.id, technicalOwnerId: null } });
    await auth.finish();
  });
  assert.deepEqual(await recoverWorkflowOperationalEvents(db, admin.session, { automationId: automation.ASSIGNMENT_CONFIRMED.id, limit: 1 }),
    { examined: 1, captured: 1, providerCalls: 0 });
  assert.equal((await enrollments(assigned.id))[0].executions[0].recipientUserId, other.user.id);
  delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE;
  const racing = await lead(), source = appointmentSource(await book(racing.id));
  process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'enabled';
  const results = await Promise.all([captureWorkflowOperationalEventAfterCommit(db, source), captureWorkflowOperationalEventAfterCommit(db, source)]);
  assert.equal(results.reduce((sum, result) => sum + result.captured, 0), 1);
  assert.equal((await enrollments(racing.id)).length, 1);
  assert.equal(await db.approvedCommunication.count({ where: { leadId: racing.id } }), 0);
});

test('paused rules, pre-activation events and current author revocation cannot create operational intent', { skip: !run }, async () => {
  const active = automation.APPOINTMENT_BOOKED;
  await saveWorkflowRule(db, admin.session, { ...active, expectedVersion: 1, state: 'DRAFT' }, clientProof(admin));
  const old = await lead(), oldSource = appointmentSource(await book(old.id)); assert.equal((await enrollments(old.id)).length, 0);
  await saveWorkflowRule(db, admin.session, { ...active, expectedVersion: 2 }, clientProof(admin));
  assert.equal((await captureWorkflowOperationalEventAfterCommit(db, oldSource)).captured, 0);
  assert.equal((await recoverWorkflowOperationalEvents(db, admin.session, { automationId: active.id, limit: 50 })).captured, 0);
  const current = await lead(); await book(current.id); assert.equal((await enrollments(current.id)).length, 1);
  await db.userPermissionOverride.create({ data: { userId: admin.user.id, permission: 'practice_communications.write', allowed: false } });
  const denied = await lead(); await book(denied.id); assert.equal((await enrollments(denied.id)).length, 0);
  await assert.rejects(recoverWorkflowOperationalEvents(db, admin.session, { limit: 1 }), /WORKFLOW_DENIED/);
});
