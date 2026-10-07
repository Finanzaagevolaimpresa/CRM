import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoleCode } from '@prisma/client';
import { contractOperationalState, contractOperationalLabel, clientHasOperationalHold } from '../src/lib/contract-operational-state';

const now = new Date('2026-10-05T10:00:00Z');
const contract = { id: 'synthetic-contract', clientId: 'synthetic-client', status: 'firmato' as const,
  signedAt: new Date('2026-09-24T00:00:00Z'), signedDocumentId: 'synthetic-signed-document' };
const payment = { contractId: contract.id, clientId: contract.clientId, status: 'incassato' as const,
  collectedAt: now, accountingDocumentId: 'synthetic-payment-document' };

test('signed contract without verified payment remains operationally suspended; receipt never starts a service', () => {
  assert.equal(contractOperationalState(contract, [], now), 'PAYMENT_PENDING');
  assert.match(contractOperationalLabel({ role: 'admin' }, 'PAYMENT_PENDING'), /sospesa.*pagamento verificato/);
  assert.equal(contractOperationalState(contract, [payment], now), 'PAYMENT_EVIDENCE_TO_VERIFY');
  assert.equal(contractOperationalState({ ...contract, signedAt: null }, [payment], now), 'SIGNATURE_PENDING');
  assert.equal(contractOperationalState({ ...contract, status: 'annullato' }, [payment], now), 'CLOSED');
});
test('foreign, future, uncollected or undocumented payments cannot clear pending payment', () => {
  for (const invalid of [{ ...payment, clientId: 'other' }, { ...payment, contractId: 'other' },
    { ...payment, status: 'da_incassare' as const }, { ...payment, collectedAt: null },
    { ...payment, collectedAt: new Date(now.getTime() + 1) }, { ...payment, accountingDocumentId: null }]) {
    assert.equal(contractOperationalState(contract, [invalid], now), 'PAYMENT_PENDING');
  }
});
test('excluded roles receive one generic impediment across all financial states', () => {
  for (const role of ['commerciale', 'consulente', 'collaboratore_limitato'] as RoleCode[]) {
    const labels = ['CLOSED', 'SIGNATURE_PENDING', 'PAYMENT_PENDING', 'PAYMENT_EVIDENCE_TO_VERIFY'].map(state =>
      contractOperationalLabel({ role }, state as ReturnType<typeof contractOperationalState>));
    assert.equal(new Set(labels).size, 1);
    assert.doesNotMatch(labels[0], /contratt|firma|incasso|pagamento/i);
  }
  assert.match(contractOperationalLabel({ role: 'amministrazione', permissionOverrides: [{ permission: 'payment.read', allowed: false }] }, 'PAYMENT_PENDING'), /verifica interna/);
  assert.equal(clientHasOperationalHold('sospeso'), true);
  assert.equal(clientHasOperationalHold('attivo'), false);
});
