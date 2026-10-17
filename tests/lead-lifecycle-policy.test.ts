import assert from 'node:assert/strict';
import test from 'node:test';
import { leadLifecycleActionAllowed, leadLifecycleSchema } from '../src/lib/lead-lifecycle-policy';
test('lead trash requires an exact version, consequence confirmation and constrained optional reason', () => {
  const input = { id: 'synthetic', updatedAt: new Date().toISOString(), action: 'trash', confirmed: 'yes' };
  assert.ok(leadLifecycleSchema.safeParse(input).success);
  for (const value of [{ ...input, confirmed: 'no' }, { ...input, updatedAt: '' }, { ...input, permanentlyDelete: true },
    { ...input, action: 'purge' }, { ...input, reasonCode: 'private customer free text' }]) assert.equal(leadLifecycleSchema.safeParse(value).success, false);
});
test('only the appropriate transition is offered for the stored state', () => {
  assert.equal(leadLifecycleActionAllowed(null, 'trash'), true);
  assert.equal(leadLifecycleActionAllowed(null, 'restore'), false);
  assert.equal(leadLifecycleActionAllowed(new Date(), 'trash'), false);
  assert.equal(leadLifecycleActionAllowed(new Date(), 'restore'), true);
});
