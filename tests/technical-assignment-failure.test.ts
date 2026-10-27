import assert from 'node:assert/strict';
import test from 'node:test';
import { technicalAssignmentFailure } from '../src/lib/technical-assignment-failure';
import { TechnicalAssignmentPreparationError } from '../src/lib/technical-assignment-errors';

test('known pure preparation refusals are distinct from an uncertain committed command', () => {
  for (const code of ['STALE', 'SCOPE', 'EXPIRED', 'SIZE', 'HISTORY_UNAVAILABLE', 'ALREADY_REVOKED'] as const) {
    const state = technicalAssignmentFailure(new TechnicalAssignmentPreparationError(code));
    assert.equal(state.ok, false);
    assert.equal(state.rejectedBeforeWrite, true);
    assert.equal(state.uncertain, undefined);
  }
});

test('transport failures and forged error strings never imply a failed decision or permit blind repetition', () => {
  for (const error of [new Error('connection lost'), new Error('TECHNICAL_ASSIGNMENT_PREPARATION_STALE'),
    { name: 'TechnicalAssignmentPreparationError', code: 'STALE' }, null]) {
    const state = technicalAssignmentFailure(error);
    assert.equal(state.uncertain, true);
    assert.equal(state.rejectedBeforeWrite, undefined);
  }
});

test('failure of the read-only preview does not invent an uncertain mutation', () => {
  const state = technicalAssignmentFailure(new Error('read unavailable'), true);
  assert.equal(state.uncertain, undefined);
  assert.equal(state.rejectedBeforeWrite, undefined);
  assert.match(state.message, /Nessun incarico è stato modificato/);
});
