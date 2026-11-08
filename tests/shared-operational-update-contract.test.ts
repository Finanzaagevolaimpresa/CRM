import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedUpdateCommand, sharedUpdateTransition, sharedUpdateRequestDigest, operationalDay } from '../src/lib/shared-operational-update-contract';
import { companyProfileSchema, personProfileSchema } from '../src/lib/record-profile-contract';
const input = { commandId: '79012345-6789-4012-8123-123456789012', target: { kind: 'PRACTICE', id: 'synthetic-practice' },
  expectedContext: 'a'.repeat(64), expectedVersion: '2026-11-08T10:00:00.000Z',
  text: 'Aggiornamento operativo sintetico', state: null, nextAction: null, nextActionDueOn: null,
  correctionOfId: null, classification: 'SHARED_OPERATIONAL' };
test('shared update requires a typed nonempty operational body and rejects extra financial/recipient properties', () => {
  assert(sharedUpdateCommand.safeParse(input).success);
  for (const patch of [{ text: '   ' }, { classification: 'ORDINARY' }, { paymentId: 'not-authorized' },
    { recipients: ['not-authorized'] }, { authorId: 'not-authorized' }, { createdAt: input.expectedVersion }])
    assert.equal(sharedUpdateCommand.safeParse({ ...input, ...patch }).success, false);
});
test('client operating states cannot be Lead, lifecycle, payment or contract states', () => {
  const target = { kind: 'CLIENT', id: 'synthetic-client' };
  for (const state of ['vinto', 'archiviato', 'sospeso', 'incassato', 'firmato', 'approvata'])
    assert.equal(sharedUpdateCommand.safeParse({ ...input, target, state }).success, false);
  assert.equal(sharedUpdateCommand.parse({ ...input, target, state: 'in_attesa_cliente' }).state, 'in_attesa_cliente');
});
test('a correction appends text without reapplying a state transition', () => {
  const corrected = { ...input, correctionOfId: '79012345-6789-4012-8123-123456789013' };
  assert(sharedUpdateCommand.safeParse(corrected).success);
  assert.equal(sharedUpdateCommand.safeParse({ ...corrected, state: 'approvata' }).success, false);
});
test('optional due date preserves day precision and rejects impossible calendar dates', () => {
  assert.equal(operationalDay.parse('2028-02-29'), '2028-02-29');
  for (const value of ['2027-02-29', '2026-11-31', '2026-11-08T00:00:00Z']) assert.equal(operationalDay.safeParse(value).success, false);
});
test('unchosen state is retained and explicit valid changes remain in their own domain', () => {
  assert.deepEqual(sharedUpdateTransition('PRACTICE', 'presentata', null), { changed: false, before: 'presentata', after: 'presentata' });
  assert.deepEqual(sharedUpdateTransition('PRACTICE', 'presentata', 'approvata'), { changed: true, before: 'presentata', after: 'approvata' });
  assert.throws(() => sharedUpdateTransition('PRACTICE', 'presentata', 'archiviata'));
});
test('idempotency binds body, context, date and command identity; normalized whitespace is stable', () => {
  const parsed = sharedUpdateCommand.parse(input), hash = sharedUpdateRequestDigest(parsed);
  assert.equal(sharedUpdateRequestDigest(sharedUpdateCommand.parse({ ...input, text: '  ' + input.text + '  ' })), hash);
  for (const patch of [{ text: 'Diverso' }, { expectedContext: 'b'.repeat(64) }, { nextActionDueOn: '2026-11-09' },
    { commandId: '79012345-6789-4012-8123-123456789014' }])
    assert.notEqual(sharedUpdateRequestDigest(sharedUpdateCommand.parse({ ...input, ...patch })), hash);
});
test('canonical company additions preserve omitted old-form fields instead of clearing them', () => {
  const shape = companyProfileSchema.shape;
  assert.equal(shape.sdiCode.parse(undefined), undefined);
  assert.equal(shape.legalPostalCode.parse(undefined), undefined);
  assert.equal(shape.sdiCode.parse('ab123cd'), 'AB123CD');
  assert.equal(shape.sdiCode.parse(''), null);
  assert.equal(shape.sdiCode.safeParse('wrong-length').success, false);
});
test('administrator and operational-contact choices are independent explicit membership facts', () => {
  const shape = personProfileSchema.shape;
  assert.equal(shape.isAdministrator.parse(undefined), undefined);
  assert.equal(shape.isAdministrator.parse('true'), true);
  assert.equal(shape.isOperationalContact.parse('false'), false);
  assert.equal(shape.isOperationalContact.safeParse('amministratore').success, false);
});
