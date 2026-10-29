import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRecordReminder, prepareRecordReminder, assertRecordReminderPreview, recordReminderAvailability,
  type ReminderContext, type ReminderDeliveryContext, type ReminderInput } from '../src/lib/record-reminder-contract';

const HASH = 'a'.repeat(64), OTHER = 'b'.repeat(64);
function fixture(): { input: ReminderInput; context: ReminderContext } {
  return {
    input: { commandId: '02345678-1234-4123-8123-123456789abc', kind: 'PROJECT', recordId: 'synthetic-project-a',
      taskId: 'synthetic-task-a', remindAt: '2030-10-27T09:00:00.000Z', mode: 'CRM',
      selection: { people: ['sales-a', 'sales-b', 'tech-a', 'tech-b'], groups: [] } },
    context: { now: '2030-10-26T09:00:00.000Z', policyExpiresAt: null,
      actor: { id: 'synthetic-admin', epoch: 1, sessionId: 'synthetic-session', role: 'admin',
        active: true, sessionLive: true, canWriteRecord: true, canReadTaskDeadline: true, accessBinding: HASH },
      source: { kind: 'PROJECT', recordId: 'synthetic-project-a', taskId: 'synthetic-task-a', generation: 3,
        scopeGeneration: 2, dueAt: '2030-11-26T17:00:00.000Z', scopeDigest: HASH,
        status: 'aperta', taskDeleted: false, recordDeleted: false },
      directory: ['sales-a', 'sales-b', 'tech-a', 'tech-b'].map(id => ({ id, name: `Synthetic ${id}`,
        email: `${id}@example.invalid`, role: id.startsWith('sales') ? 'commerciale' : 'consulente',
        revision: '1', active: true, deleted: false })),
      recipients: ['sales-a', 'sales-b', 'tech-a', 'tech-b'].map(id => ({ id, epoch: 1,
        canReadRecord: id !== 'sales-b', canReadTaskDeadline: id !== 'sales-b',
        accessBinding: HASH, accessUntil: null })),
    },
  };
}
function reading(context: ReminderContext, recipientId = 'tech-a'): ReminderDeliveryContext {
  return { now: '2030-10-27T09:00:00.000Z', source: context.source, authorId: context.actor.id,
    authorEpoch: context.actor.epoch, authorAccessBinding: context.actor.accessBinding, authorAuthorized: true, policyRevoked: false,
    directory: context.directory, recipient: context.recipients.find(r => r.id === recipientId)!, readAt: null };
}

test('one originator and two technicians can be selected; the other commercial gains no access', () => {
  const { input, context } = fixture(), prepared = prepareRecordReminder(input, context);
  assert.deepEqual(prepared.recipients.map(r => r.id), ['sales-a', 'tech-a', 'tech-b']);
  assert.deepEqual(prepared.excluded, [{ id: 'sales-b', reason: 'NO_CURRENT_ACCESS' }]);
  assert.equal(recordReminderAvailability(prepared, reading(context, 'sales-b')).state, 'SUPPRESSED');
  for (const person of ['sales-a', 'tech-a', 'tech-b']) assert.equal(recordReminderAvailability(prepared, reading(context, person)).state, 'AVAILABLE');
});
test('unselected people cannot receive the notice even if they later obtain access', () => {
  const { input, context } = fixture(); input.selection.people = ['tech-a'];
  const prepared = prepareRecordReminder(input, context);
  assert.equal(recordReminderAvailability(prepared, reading(context, 'tech-b')).state, 'SUPPRESSED');
});
test('record access alone does not disclose a private task deadline', () => {
  const { input, context } = fixture();
  const updated = { ...context, recipients: context.recipients.map(r => r.id === 'tech-b' ? { ...r, canReadTaskDeadline: false } : r) };
  const prepared = prepareRecordReminder(input, updated);
  assert.equal(prepared.recipients.some(r => r.id === 'tech-b'), false);
  assert.equal(recordReminderAvailability(prepared, reading(context, 'tech-b')).state, 'SUPPRESSED');
});
test('only a current Admin with a live session and source permission prepares a schedule', () => {
  for (const patch of [{ role: 'commerciale' }, { role: 'consulente' }, { active: false }, { sessionLive: false },
    { canWriteRecord: false }, { canReadTaskDeadline: false }]) {
    const { input, context } = fixture();
    assert.throws(() => prepareRecordReminder(input, { ...context, actor: { ...context.actor, ...patch } }), /DENIED/);
  }
});
test('unknown data, free text and external delivery modes are rejected', () => {
  const { input } = fixture();
  for (const patch of [{ notes: 'not admitted' }, { subject: 'not admitted' }, { attachments: ['x'] },
    { mode: 'EMAIL_DRAFT' }, { mode: 'EMAIL' }, { kind: 'LEAD' }, { commandId: 'arbitrary' }]) {
    assert.throws(() => parseRecordReminder({ ...input, ...patch }), /INVALID/);
  }
  assert.throws(() => parseRecordReminder({ ...input, selection: { people: ['tech-a'], groups: ['invented'] } }), /INVALID/);
});
test('instants must be explicit valid UTC and the reminder must be in the future', () => {
  const { input, context } = fixture();
  for (const remindAt of ['2030-10-27T09:00', '2030-02-30T09:00:00.000Z', '2030-10-27T10:00:00.000+01:00',
    context.now, '2030-10-26T08:59:59.999Z']) assert.throws(() => prepareRecordReminder({ ...input, remindAt }, context), /INVALID/);
});
test('the two occurrences of a repeated local clock hour remain different instants', () => {
  const { input, context } = fixture();
  const summer = prepareRecordReminder({ ...input, remindAt: '2030-10-27T00:30:00.000Z' }, context);
  const winter = prepareRecordReminder({ ...input, remindAt: '2030-10-27T01:30:00.000Z' }, context);
  assert.notEqual(summer.digest, winter.digest);
  assert.throws(() => assertRecordReminderPreview(summer.digest, winter), /STALE/);
});
test('policy expiry is not the delivery time and cannot silently extend past itself', () => {
  const { input, context } = fixture();
  assert.throws(() => prepareRecordReminder(input, { ...context, policyExpiresAt: input.remindAt }), /DENIED/);
  const prepared = prepareRecordReminder(input, { ...context, policyExpiresAt: '2030-10-27T10:00:00.000Z' });
  assert.equal(recordReminderAvailability(prepared, { ...reading(context), now: '2030-10-27T10:00:00.000Z' }).state, 'SUPPRESSED');
});
test('an expiring recipient is excluded instead of receiving a longer authorization', () => {
  const { input, context } = fixture();
  const prepared = prepareRecordReminder(input, { ...context, recipients: context.recipients.map(r => r.id === 'tech-a'
    ? { ...r, accessUntil: input.remindAt } : r) });
  assert.ok(prepared.excluded.some(r => r.id === 'tech-a' && r.reason === 'EXPIRES_BEFORE_REMINDER'));
  assert.equal(recordReminderAvailability(prepared, reading(context)).state, 'SUPPRESSED');
});
test('scheduling fails if no selected recipient is currently eligible', () => {
  const { input, context } = fixture();
  assert.throws(() => prepareRecordReminder({ ...input, selection: { people: ['sales-b'], groups: [] } }, context), /DENIED/);
});
test('availability changes exactly at the chosen instant and never implies email delivery', () => {
  const { input, context } = fixture(), prepared = prepareRecordReminder(input, context), current = reading(context);
  assert.deepEqual(recordReminderAvailability(prepared, { ...current, now: '2030-10-27T08:59:59.999Z' }),
    { state: 'SCHEDULED', availableAt: input.remindAt, emailSent: false });
  assert.deepEqual(recordReminderAvailability(prepared, current), { state: 'AVAILABLE', availableAt: input.remindAt, emailSent: false });
  assert.deepEqual(recordReminderAvailability(prepared, { ...current, now: '2030-10-27T09:01:00.000Z', readAt: input.remindAt }),
    { state: 'READ', availableAt: input.remindAt, readAt: input.remindAt, emailSent: false });
});
test('a read timestamp before availability or after the database clock is not a valid receipt', () => {
  const { input, context } = fixture(), prepared = prepareRecordReminder(input, context);
  for (const readAt of ['2030-10-27T08:59:59.999Z', '2030-10-27T09:00:00.001Z']) {
    assert.equal(recordReminderAvailability(prepared, { ...reading(context), readAt }).state, 'SUPPRESSED');
  }
});
test('moving a deadline and restoring the old value cannot revive the old reminder', () => {
  const { input, context } = fixture(), prepared = prepareRecordReminder(input, context), current = reading(context);
  for (const source of [{ ...context.source, generation: 4, dueAt: '2030-11-27T17:00:00.000Z' },
    { ...context.source, generation: 5 }]) {
    assert.equal(recordReminderAvailability(prepared, { ...current, source }).state, 'SUPPRESSED');
  }
});
test('task completion, trash, cancellation, reassignment and context changes suppress visibility', () => {
  const { input, context } = fixture(), prepared = prepareRecordReminder(input, context);
  for (const patch of [{ status: 'completata' as const }, { status: 'annullata' as const }, { taskDeleted: true },
    { recordDeleted: true }, { scopeDigest: OTHER }, { recordId: 'synthetic-project-b' }, { taskId: 'synthetic-task-b' },
    { generation: 4, scopeGeneration: 3 }]) {
    assert.equal(recordReminderAvailability(prepared, { ...reading(context), source: { ...context.source, ...patch } }).state, 'SUPPRESSED');
  }
});
test('author loss of access, revocation or epoch change immediately suppresses existing work', () => {
  const { input, context } = fixture(), prepared = prepareRecordReminder(input, context);
  for (const patch of [{ authorAuthorized: false }, { policyRevoked: true }, { authorEpoch: 2 }, { authorId: 'other-admin' }]) {
    assert.equal(recordReminderAvailability(prepared, { ...reading(context), ...patch }).state, 'SUPPRESSED');
  }
});
test('recipient revocation or an expired original grant cannot be replaced by later broader access', () => {
  const { input, context } = fixture();
  const ctx = { ...context, recipients: context.recipients.map(r => ({ ...r, accessUntil: '2030-10-27T10:00:00.000Z' })) };
  const prepared = prepareRecordReminder(input, ctx), current = reading(ctx);
  for (const patch of [{ epoch: 2 }, { accessBinding: OTHER }, { canReadRecord: false }, { canReadTaskDeadline: false },
    { accessUntil: input.remindAt }]) assert.equal(recordReminderAvailability(prepared, { ...current, recipient: { ...current.recipient, ...patch } }).state, 'SUPPRESSED');
  assert.equal(recordReminderAvailability(prepared, { ...current, now: '2030-10-27T10:00:00.000Z',
    recipient: { ...current.recipient, accessUntil: null } }).state, 'SUPPRESSED');
});
test('changed group membership or an account revision invalidates the original selection', () => {
  const { input, context } = fixture();
  const prepared = prepareRecordReminder({ ...input, selection: { people: [], groups: ['tecnico'] } }, context);
  const directory = context.directory.map(p => p.id === 'tech-b' ? { ...p, revision: '2' } : p);
  assert.equal(recordReminderAvailability(prepared, { ...reading(context), directory }).state, 'SUPPRESSED');
  const outsider = { ...context.directory[0], id: 'new-tech', name: 'Synthetic new tech', role: 'consulente' };
  assert.equal(recordReminderAvailability(prepared, { ...reading(context), directory: [...context.directory, outsider] }).state, 'SUPPRESSED');
});
test('same command binds one event key and preview changes cannot silently reuse it', () => {
  const { input, context } = fixture(), first = prepareRecordReminder(input, context), same = prepareRecordReminder(input, context);
  assert.equal(first.eventKey, same.eventKey); assertRecordReminderPreview(first.digest, same);
  for (const changed of [prepareRecordReminder({ ...input, remindAt: '2030-10-27T10:00:00.000Z' }, context),
    prepareRecordReminder({ ...input, selection: { people: ['tech-a'], groups: [] } }, context),
    prepareRecordReminder(input, { ...context, source: { ...context.source, generation: 4 } }),
    prepareRecordReminder(input, { ...context, actor: { ...context.actor, sessionId: 'new-session' } })]) {
    assert.throws(() => assertRecordReminderPreview(first.digest, changed), /STALE/);
  }
});
test('availability evaluation is pure and cannot fabricate read receipts or change the schedule', () => {
  const { input, context } = fixture(), prepared = prepareRecordReminder(input, context), current = reading(context);
  const before = JSON.stringify({ prepared, current });
  recordReminderAvailability(prepared, current); recordReminderAvailability(prepared, current);
  assert.equal(JSON.stringify({ prepared, current }), before); assert.equal(current.readAt, null);
  assert.deepEqual(prepared.summary, { event: 'DEADLINE', changed: ['dueDate'] });
  assert.equal(JSON.stringify(prepared).includes('@example.invalid'), false);
});
test('modified persisted bindings fail closed rather than presenting fabricated availability', () => {
  const { input, context } = fixture(), prepared = prepareRecordReminder(input, context);
  assert.equal(recordReminderAvailability({ ...prepared, eventKey: 'changed' }, reading(context)).state, 'SUPPRESSED');
});

test('restoring personal authority never revives a notice bound to the preceding revision', () => {
  const { input, context } = fixture(), prepared = prepareRecordReminder(input, context);
  for (const authorAccessBinding of ['b'.repeat(64), 'c'.repeat(64)]) {
    assert.equal(recordReminderAvailability(prepared, { ...reading(context), authorAccessBinding }).state, 'SUPPRESSED');
    const fresh = prepareRecordReminder(input, { ...context, actor: { ...context.actor, accessBinding: authorAccessBinding } });
    assert.throws(() => assertRecordReminderPreview(prepared.digest, fresh), /STALE/);
  }
});
