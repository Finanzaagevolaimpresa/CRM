import assert from 'node:assert/strict';
import test from 'node:test';
import { accountPasswordSchema, accountProfileSchema, passwordChangeSchema, passwordResetSchema } from '../src/lib/user-account-contract';

test('account profile accepts only the editable professional fields', () => {
  assert.deepEqual(accountProfileSchema.parse({ name: ' Operatore ', email: 'Worker@EXAMPLE.TEST', role: 'admin', active: true }),
    { name: 'Operatore', email: 'worker@example.test' });
  assert.equal(accountProfileSchema.safeParse({ name: '', email: 'missing' }).success, false);
});
test('password validation prevents bcrypt truncation and requires a matching new value', () => {
  const password = 'Synthetic-new-password-only!';
  assert.equal(accountPasswordSchema.safeParse('short').success, false);
  assert.equal(accountPasswordSchema.safeParse('é'.repeat(37)).success, false);
  assert.equal(accountPasswordSchema.safeParse('a'.repeat(72)).success, true);
  assert.equal(passwordResetSchema.safeParse({ password, confirmation: 'different' }).success, false);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: password, password, confirmation: password }).success, false);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: 'old', password, confirmation: password }).success, true);
});
