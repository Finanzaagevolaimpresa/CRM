import test from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticWorkflowRun, renderWorkflowTemplate, workflowRuleInput, workflowTemplateInput,
  type WorkflowRule, type WorkflowTemplate, type SyntheticWorkflowEvent } from '../src/lib/workflow-automation-contract';

const confirmationId = 'ccfd966f-757b-43ac-89c1-e2024f9b8b22', followupId = 'fa64e040-a419-47e9-a084-9ac55a292814';
const rule: WorkflowRule = { id: '90bfe272-7d71-4753-b45c-d51f05fe1f17', expectedVersion: 1, name: 'Lead di prova',
  event: 'LEAD_ACCEPTED', state: 'TEST_READY', delayMinutes: 60, configuration: { kind: 'INDIVIDUAL', action: 'EMAIL',
    confirmationTemplateId: confirmationId, followupTemplateId: followupId, requireAssociated: true,
    stopOnReply: true, stopOnAppointment: true, newsletterAt: null, recipientIds: [] } };
const templates: WorkflowTemplate[] = [{ id: confirmationId, name: 'Conferma', purpose: 'CONFIRMATION', subject: 'Ricevuta {{companyName}}', body: 'Buongiorno {{firstName}}.', state: 'PUBLISHED', authorizationReference: 'SYNTHETIC_ONLY' },
  { id: followupId, name: 'Sollecito', purpose: 'FOLLOW_UP', subject: 'Prova sollecito', body: 'Prova per {{companyName}}.', state: 'PUBLISHED', authorizationReference: 'SYNTHETIC_ONLY' }];
const event: SyntheticWorkflowEvent = { id: 'event-1', leadId: 'lead-1', receiptId: 'receipt-1', kind: 'LEAD_ACCEPTED', associated: true,
  occurredAt: '2026-11-26T09:00:00.000Z', fields: { firstName: 'Persona Test', companyName: 'Impresa Sintetica' } };
const start = event.occurredAt, end = '2026-11-26T11:00:00.000Z';

test('one receipt, confirmation and follow-up survive event replay without duplicate sends', () => {
  const run = new SyntheticWorkflowRun(rule, templates);
  assert.equal(run.ingest(event), 'RECORDED'); run.runDue(start); run.runDue(start);
  assert.equal(run.receipts.length, 1); assert.equal(run.ingest(event), 'REPLAY');
  run.runDue(end); run.runDue(end); assert.equal(run.receipts.length, 2);
  assert.equal(new Set(run.receipts.map(row => row.id)).size, 2);
  assert.throws(() => run.ingest({ ...event, leadId: 'another-lead' }), /WORKFLOW_EVENT_CONFLICT/);
});
for (const kind of ['REPLIED', 'APPOINTMENT_BOOKED'] as const) test(`${kind} stops the pending follow-up`, () => {
  const run = new SyntheticWorkflowRun(rule, templates); run.ingest(event); run.runDue(start);
  run.observe(event.id, kind, start, 'evidence-1'); run.observe(event.id, kind, start, 'evidence-1'); run.runDue(end);
  assert.equal(run.receipts.length, 1); assert.equal(run.jobs[1].state, 'STOPPED');
  assert.equal(run.log.filter(row => row.event === kind).length, 1);
});
test('identity review never produces confirmation or follow-up', () => {
  const run = new SyntheticWorkflowRun(rule, templates); assert.equal(run.ingest({ ...event, associated: false }), 'HELD');
  run.runDue(end); assert.equal(run.jobs.length, 0); assert.equal(run.receipts.length, 0);
});
test('uncertain result blocks retry and follow-up until authoritative reconciliation', () => {
  const run = new SyntheticWorkflowRun(rule, templates); run.ingest(event); run.runDue(start, 'UNCERTAIN'); run.runDue(end);
  assert.equal(run.receipts.length, 1); assert.equal(run.jobs[1].state, 'WAITING');
  assert.throws(() => run.reconcile(run.jobs[0].key, 'ACCEPTED', end, ''), /RECONCILIATION_INVALID/);
  run.reconcile(run.jobs[0].key, 'ACCEPTED', end, 'test-channel-evidence'); run.runDue(end);
  assert.equal(run.receipts.length, 2); assert.equal(run.jobs[0].attempts, 1);
});
test('negative reconciliation permits a new attempt only when no stop occurred', () => {
  const run = new SyntheticWorkflowRun(rule, templates); run.ingest(event); run.runDue(start, 'UNCERTAIN');
  run.reconcile(run.jobs[0].key, 'NOT_ACCEPTED', end, 'not-accepted-evidence'); run.runDue(end);
  assert.equal(run.jobs[0].attempts, 2); assert.equal(new Set(run.receipts.map(row => row.id)).size, 3);
  const stopped = new SyntheticWorkflowRun(rule, templates); stopped.ingest(event); stopped.runDue(start, 'UNCERTAIN');
  stopped.observe(event.id, 'REPLIED', end, 'reply'); stopped.reconcile(stopped.jobs[0].key, 'NOT_ACCEPTED', end, 'not-accepted-evidence'); stopped.runDue(end);
  assert.equal(stopped.receipts.length, 1);
});
test('acceptance is not delivery; delivery requires evidence', () => {
  const run = new SyntheticWorkflowRun(rule, templates); run.ingest(event); run.runDue(start);
  assert.equal(run.jobs[0].state, 'ACCEPTED'); assert.equal(run.log.some(row => row.event === 'DELIVERED'), false);
  assert.throws(() => run.delivery(run.jobs[0].key, start, ''), /EVIDENCE_REQUIRED/);
  run.delivery(run.jobs[0].key, start, 'synthetic-provider-delivery'); run.delivery(run.jobs[0].key, start, 'synthetic-provider-delivery');
  assert.equal(run.log.filter(row => row.event === 'DELIVERED').length, 1);
});
test('missing fields and unpublished copy cannot send', () => {
  assert.deepEqual(renderWorkflowTemplate(templates[0], { firstName: 'Persona' }), { ok: false, missing: ['companyName'] });
  assert.throws(() => renderWorkflowTemplate({ ...templates[0], state: 'DRAFT' }, event.fields), /NOT_APPROVED/);
  const run = new SyntheticWorkflowRun(rule, templates); run.ingest({ ...event, fields: {} }); run.runDue(end);
  assert.equal(run.receipts.length, 0); assert.match(run.jobs[0].reason!, /MISSING_FIELDS/);
});
test('unknown fields and header injection are rejected; fresh rendering has no other-client values', () => {
  assert.throws(() => renderWorkflowTemplate({ ...templates[0], body: '{{privateNote}}' }, event.fields), /FIELD_UNKNOWN/);
  assert.throws(() => renderWorkflowTemplate(templates[0], { ...event.fields, companyName: 'A\r\nBcc: other@example.test' }));
  const first = renderWorkflowTemplate(templates[0], { firstName: 'First', companyName: 'First company' });
  const second = renderWorkflowTemplate(templates[0], { firstName: 'Second', companyName: 'Second company' });
  assert.equal(first.ok && first.body.includes('First'), true); assert.equal(second.ok && second.body.includes('First'), false);
});
test('publishing a template requires a named authorization and newsletter unsubscribe field', () => {
  const input = { ...templates[0], familyId: confirmationId, expectedVersion: 0, authorizationReference: null };
  assert.equal(workflowTemplateInput.safeParse(input).success, false);
  assert.equal(workflowTemplateInput.safeParse({ ...input, authorizationReference: 'approved', purpose: 'NEWSLETTER' }).success, false);
});
test('newsletter is separate, opt-in checked before execution and unsubscribe stops pending work', () => {
  const newsletter: WorkflowRule = { ...rule, event: 'NEWSLETTER', configuration: { ...rule.configuration,
    kind: 'NEWSLETTER', followupTemplateId: null, newsletterAt: start, recipientIds: ['lead-1'] } };
  const template: WorkflowTemplate = { ...templates[0], purpose: 'NEWSLETTER', body: '{{firstName}} {{unsubscribeUrl}}' };
  assert.equal(workflowRuleInput.safeParse({ ...newsletter, event: 'LEAD_ACCEPTED' }).success, false);
  const run = new SyntheticWorkflowRun(newsletter, [template]);
  run.ingest({ ...event, kind: 'NEWSLETTER', marketingEligible: false, fields: { ...event.fields, unsubscribeUrl: 'https://example.test/withdraw' } }); run.runDue(end);
  assert.equal(run.receipts.length, 0); assert.equal(run.jobs[0].reason, 'MARKETING_PREFERENCE_NOT_ELIGIBLE');
  const blocked = new SyntheticWorkflowRun(newsletter, [template]); blocked.ingest({ ...event, kind: 'NEWSLETTER', marketingEligible: true });
  blocked.observe(event.id, 'UNSUBSCRIBED', start, 'withdrawal'); blocked.runDue(end); assert.equal(blocked.receipts.length, 0);
});
