import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { contractActivitiesCommand } from '../src/lib/contract-activities-contract';

const input = () => ({ commandId: randomUUID(), clientId: 'client_synthetic', contractId: 'contract_synthetic', activities: 'Attività concordate', confirmed: true });
test('activities require an explicit confirmation and a nonempty agreed description', () => {
  for (const activities of ['', ' ', '\n\t']) assert.equal(contractActivitiesCommand.safeParse({ ...input(), activities }).success, false);
  assert.equal(contractActivitiesCommand.safeParse({ ...input(), confirmed: false }).success, false);
});
test('activities preserve paragraphs and accents while trimming outer whitespace', () => {
  assert.equal(contractActivitiesCommand.parse({ ...input(), activities: '  Attività è prevista.\nSeconda attività.  ' }).activities, 'Attività è prevista.\nSeconda attività.');
});
test('activity size is bounded to the declared 5000 characters', () => {
  assert.equal(contractActivitiesCommand.parse({ ...input(), activities: 'x'.repeat(5000) }).activities.length, 5000);
  assert.equal(contractActivitiesCommand.safeParse({ ...input(), activities: 'x'.repeat(5001) }).success, false);
});
test('the completion command cannot mutate signature, money, clients or arbitrary fields', () => {
  for (const extra of [{ signedAt: '2026-01-01' }, { status: 'firmato' }, { totalAmount: 1 }, { projectId: 'other' }, { notes: 'private' }]) {
    assert.equal(contractActivitiesCommand.safeParse({ ...input(), ...extra }).success, false);
  }
});
test('command ids and record references are validated', () => {
  for (const extra of [{ commandId: 'retry' }, { clientId: '' }, { contractId: '../other' }]) {
    assert.equal(contractActivitiesCommand.safeParse({ ...input(), ...extra }).success, false);
  }
});
