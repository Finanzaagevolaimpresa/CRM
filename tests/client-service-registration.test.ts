import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceRegistrationCommand, registrationDay, registrationServiceId } from '../src/lib/client-service-registration-contract';

test('registration accepts a calendar date but not rollover or a future free-form timestamp', () => {
  assert.equal(registrationDay.parse('2024-02-29'), '2024-02-29');
  for (const value of ['2025-02-29', '2026-04-31', '2026-1-2', 'today', '2026-10-19T12:00:00Z']) assert.equal(registrationDay.safeParse(value).success, false);
});
test('registration cannot carry assignments, financial assertions or a replacement service id', () => {
  const command = { operation: 'REGISTER', commandId: randomUUID(), clientId: 'client', catalogId: 'catalog', contractId: 'contract', paymentId: null, purchasedOn: '2026-10-19' };
  assert.equal(serviceRegistrationCommand.safeParse(command).success, true);
  for (const [key, value] of Object.entries({ assignedToId: 'user', paymentStatus: 'incassato', status: 'pagato', projectId: 'other', serviceId: 'other' }))
    assert.equal(serviceRegistrationCommand.safeParse({ ...command, [key]: value }).success, false);
  assert.equal(registrationServiceId(command.commandId), registrationServiceId(command.commandId));
});
test('payment linking cannot change the client contract, catalog or purchase date', () => {
  const command = { operation: 'LINK_PAYMENT', commandId: randomUUID(), clientId: 'client', serviceId: 'service', paymentId: 'payment' };
  assert.equal(serviceRegistrationCommand.safeParse(command).success, true);
  for (const [key, value] of Object.entries({ contractId: 'other', catalogId: 'other', purchasedOn: '2026-10-19' }))
    assert.equal(serviceRegistrationCommand.safeParse({ ...command, [key]: value }).success, false);
});
