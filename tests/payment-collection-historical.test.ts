import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { historicalPaymentCommand, historicalDayLabel, historicalPaymentSource } from '../src/lib/payment-historical-attestation-contract';
import { technicalActionAllowed, technicalPageMode } from '../src/lib/technical-surface-policy';
const input = { commandId: randomUUID(), clientId: 'synthetic_client', paymentId: 'synthetic_payment', expectedAmount: '61.00',
  effectiveDay: '2026-01-15', attestedOn: '2026-01-20', declarant: 'Titolare sintetico',
  provenance: 'Dichiarazione sintetica nel canale autorizzato', reason: 'Riconciliazione storica sintetica',
  expiresAt: '2026-11-03T10:00:00.000Z', confirmed: true };
test('historical attestation preserves day precision and rejects invented time, method, files and amount overrides', () => {
  assert.deepEqual(historicalPaymentCommand.parse(input), input);
  for (const key of ['collectedAt','method','documentVersionId','newPayment','status','amount','signedAt','serviceId']) {
    assert.equal(historicalPaymentCommand.safeParse({ ...input, [key]: 'injected' }).success, false);
  }
  for (const day of ['2026-02-30','2026-13-01','2026-01-01T00:00:00Z','1899-12-31']) {
    assert.equal(historicalPaymentCommand.safeParse({ ...input, effectiveDay: day }).success, false);
  }
  assert.equal(historicalDayLabel('2026-01-15'), '15/01/2026');
  assert.equal(historicalDayLabel('2026-02-28'), '28/02/2026');
});
test('historical source cannot claim bank verification, exact time or known method', () => {
  const source = { type: 'OWNER_ADMIN_ATTESTATION_V1', effectiveDay: input.effectiveDay, precision: 'DAY',
    effectiveTime: null, declaredMethod: null, attestedOn: input.attestedOn, declarant: input.declarant,
    provenance: input.provenance, bankEvidenceVerified: false, storageNormalization: 'UTC_MIDNIGHT_NOT_ACTUAL_CREDIT_TIME' };
  assert.deepEqual(historicalPaymentSource.parse(source), source);
  for (const delta of [{ bankEvidenceVerified: true }, { effectiveTime: '12:00' }, { declaredMethod: 'bonifico' }, { precision: 'SECOND' }]) {
    assert.equal(historicalPaymentSource.safeParse({ ...source, ...delta }).success, false);
  }
});
test('all technical functions deny new page and actions even with payment permission overrides', () => {
  assert.equal(technicalPageMode('/payments/[id]/historical-attestation'), 'denied');
  for (const actor of [
    { role: 'consulente' as const, active: true, permissionOverrides: [{ permission: 'payment.write' as const, allowed: true }] },
    { role: 'commerciale' as const, active: true, technicalRestricted: true },
    { role: 'backoffice' as const, active: true, technicalRestricted: true },
  ]) for (const name of ['previewHistoricalPaymentAction','confirmHistoricalPaymentAction','verifyHistoricalPaymentAction']) {
    assert.equal(technicalActionAllowed(actor, 'payment-historical-attestation-actions:' + name), false);
  }
});
