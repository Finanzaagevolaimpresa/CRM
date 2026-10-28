import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../src/lib/canonical-json';
import { historicalContactInput, prepareHistoricalContact } from '../src/lib/commercial-lead-historical-contact-contract';
import { createHistoricalConversionPreview, readHistoricalConversionPreview,
  type HistoricalConversionPreviewAdmission } from '../src/lib/commercial-lead-historical-conversion-preview';
import { commercialLeadSlaLabel } from '../src/lib/commercial-lead-inbox-contract';

const key = { version: 1, secret: 'isolated-conversion-preview-secret-0000000000000000' };
const input = () => ({ commandId: '11111111-1111-4111-8111-111111111111', leadId: 'synthetic-lead',
  expectedInboxVersion: 3, expectedAssignmentId: 'synthetic-assignment', contactId: '55555555-5555-4555-8555-555555555555', clientType: 'societa' });
function admission(): HistoricalConversionPreviewAdmission {
  const context = { leadId: 'synthetic-lead', actorId: 'synthetic-owner', actorRole: 'commerciale', sessionLive: true,
    canWriteLead: true, selectiveAccessOnly: false, currentOwnerId: 'synthetic-owner', assignmentId: 'synthetic-assignment',
    acceptedAssignmentId: 'synthetic-assignment', acceptedById: 'synthetic-owner', origin: 'MANUAL_CRM', state: 'OPEN',
    inboxVersion: 2, deleted: false, converted: false, cycleSequence: 1, firstResponseAt: null,
    historicalContactExists: false, initializedAt: '2026-02-01T08:00:00.000Z', recordedAt: '2026-02-01T10:00:00.000Z' };
  const contactInput = historicalContactInput({ commandId: input().contactId, leadId: context.leadId,
    expectedInboxVersion: 2, expectedAssignmentId: context.assignmentId, occurredAt: '2026-01-01T09:30:00.000Z',
    source: 'EMAIL', evidenceReference: 'Riferimento sintetico', attested: true });
  const prepared = prepareHistoricalContact(contactInput, context), inboxItemId = '33333333-3333-4333-8333-333333333333', cycleId = '44444444-4444-4444-8444-444444444444';
  return { context: { ...context, inboxVersion: 3 }, sessionId: '22222222-2222-4222-8222-222222222222',
    sessionExpiresAt: Date.parse('2026-02-01T11:00:00.000Z'), inboxItemId, cycleId, canCreateClient: true,
    contact: { id: contactInput.commandId, input: contactInput, actorId: context.actorId, inboxItemId, cycleId,
      recordedAt: context.recordedAt, inboxVersionAfter: 3, payloadHash: prepared.payloadHash },
    clientProjection: { displayName: 'Cliente sintetico', notes: 'Note già presenti', leadUpdatedAt: '2026-02-01T08:01:00.000Z' } };
}
test('conversion preview binds the exact client type, source contact and copied lead fields', () => {
  const a = admission(), p = createHistoricalConversionPreview(key, input(), a);
  assert.equal(p.leadLabel, a.clientProjection.displayName); assert.equal(p.notes, a.clientProjection.notes);
  assert.equal(p.occurredAt, a.contact.input.occurredAt); assert.equal(p.contactRecordedAt, a.contact.recordedAt);
  assert.deepEqual(readHistoricalConversionPreview(key, p.token, a), p.input);
  assert.equal(a.context.firstResponseAt, null);
});
test('changing copied name, notes or the source version invalidates the conversion preview', () => {
  const a = admission(), p = createHistoricalConversionPreview(key, input(), a);
  for (const delta of [{ displayName: 'Other' }, { notes: 'Changed' }, { leadUpdatedAt: '2026-02-01T08:02:00.000Z' }]) {
    assert.equal(readHistoricalConversionPreview(key, p.token, { ...a, clientProjection: { ...a.clientProjection, ...delta } }), null);
  }
});
test('conversion type, command, contact and purpose cannot be changed after preview', () => {
  const a = admission(), p = createHistoricalConversionPreview(key, input(), a);
  for (const field of ['clientType', 'commandId', 'contactId', 'protocol']) {
    const e = JSON.parse(Buffer.from(p.token, 'base64url').toString('utf8'));
    e.payload.input[field] = field === 'clientType' ? 'persona_fisica' : field === 'protocol' ? 'N14_HISTORICAL_CONTACT_V1' : '66666666-6666-4666-8666-666666666666';
    assert.equal(readHistoricalConversionPreview(key, Buffer.from(canonicalJson(e)).toString('base64url'), a), null);
  }
});
test('conversion preview does not outlive the session or five minutes and cannot cross sessions or keys', () => {
  const a = admission(), p = createHistoricalConversionPreview(key, input(), a);
  assert.equal(p.expiresAt, '2026-02-01T10:05:00.000Z');
  for (const delta of [{ sessionId: '77777777-7777-4777-8777-777777777777' }, { canCreateClient: false },
    { context: { ...a.context, recordedAt: p.expiresAt } }, { context: { ...a.context, recordedAt: '2026-02-01T09:59:59.999Z' } },
    { context: { ...a.context, assignmentId: 'changed' } }, { context: { ...a.context, sessionLive: false } }]) {
    assert.equal(readHistoricalConversionPreview(key, p.token, { ...a, ...delta }), null);
  }
  assert.equal(readHistoricalConversionPreview({ ...key, version: 2 }, p.token, a), null);
  assert.equal(readHistoricalConversionPreview(key, p.token + '=', a), null);
  const short = { ...a, sessionExpiresAt: Date.parse('2026-02-01T10:01:00.000Z') };
  assert.equal(createHistoricalConversionPreview(key, input(), short).expiresAt, '2026-02-01T10:01:00.000Z');
});
test('a historical contact is a distinct closed basis, never a measured SLA success or overdue response', () => {
  const now = new Date('2026-02-01T12:00:00Z'), dueAt = new Date('2026-02-01T10:00:00Z');
  const c = { dueAt, firstResponseAt: null, closedAt: now, outcome: 'HISTORICAL_CONTACT_BEFORE_CRM' };
  assert.equal(commercialLeadSlaLabel(c, now), 'Contatto precedente al CRM · SLA non misurato');
  assert.equal(commercialLeadSlaLabel({ ...c, closedAt: null, outcome: null }, now), 'Prima risposta in ritardo');
  assert.equal(commercialLeadSlaLabel({ ...c, outcome: 'MET', firstResponseAt: dueAt }, now), 'Risposta entro SLA');
  assert.equal(commercialLeadSlaLabel({ ...c, outcome: 'UNKNOWN' }, now), 'Esito SLA non disponibile');
});
