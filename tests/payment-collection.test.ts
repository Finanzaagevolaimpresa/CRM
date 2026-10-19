import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { paymentCollectionCommand } from '../src/lib/payment-collection-contract';

const valid = { commandId: randomUUID(), clientId: 'synthetic_client', paymentId: 'synthetic_payment',
  documentVersionId: 'synthetic_version', collectedAt: '2026-10-18T10:00:00.000Z', confirmed: true };
test('collection command requires an explicit actual timestamp and personal confirmation', () => {
  assert.deepEqual(paymentCollectionCommand.parse(valid), valid);
  for (const delta of [{ confirmed: false }, { confirmed: undefined }, { collectedAt: '' }, { collectedAt: 'ieri' }, { documentVersionId: '' }]) {
    assert.equal(paymentCollectionCommand.safeParse({ ...valid, ...delta }).success, false);
  }
});
test('collection cannot carry an amount override, arbitrary status or a replacement payment', () => {
  for (const key of ['amount', 'status', 'accountingDocumentId', 'newPayment', 'recipientId']) {
    assert.equal(paymentCollectionCommand.safeParse({ ...valid, [key]: 'injected' }).success, false);
  }
  assert.equal(paymentCollectionCommand.safeParse({ ...valid, commandId: 'not-a-command' }).success, false);
});
