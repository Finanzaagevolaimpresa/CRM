import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { prepareTechnicalAssignmentDecision, readTechnicalAssignmentDecisionOutcome,
  technicalAssignmentRequestDigest, type PreparedTechnicalAssignmentDecision } from '../src/lib/technical-assignment-decision';
import { createTechnicalAssignmentPreview, type TechnicalAssignmentPreviewAdmission } from '../src/lib/technical-assignment-preview';
import { readRetainedTechnicalAssignmentJournal } from '../src/lib/technical-assignment-journal';
import { decodeTechnicalAssignmentRecord, type StoredTechnicalAssignment } from '../src/lib/technical-assignment-record';
import { TechnicalAssignmentPreparationError } from '../src/lib/technical-assignment-errors';
import { technicalAssignmentFailure } from '../src/lib/technical-assignment-failure';

const key = { version: 1, secret: 'isolated-assignment-decision-test-key' };
const now = new Date('2026-10-23T06:00:00Z');
const assignmentId = 'a1111111-1111-4111-8111-111111111111';
const revisionId = 'b1111111-1111-4111-8111-111111111111';
const commandId = 'c1111111-1111-4111-8111-111111111111';
const sessionId = 'd1111111-1111-4111-8111-111111111111';
const reference = { kind: 'Project' as const, targetId: 'project-a', recipientId: 'technician-a' };
const admission: TechnicalAssignmentPreviewAdmission = { actorId: 'personal-admin', sessionId,
  authorityRevision: 1, actorEpoch: 2, recipientEpoch: 3, ...reference,
  assignmentId: null, assignmentRevision: 0, assignmentStateSha256: null,
  contextSha256: 'a'.repeat(64), validUntil: now.getTime() + 3600_000 };
const command = { commandId, targetId: reference.targetId, expectedRevision: 0,
  expectedContextSha256: admission.contextSha256, expectedRecipientEpoch: 3,
  selection: { kind: 'Project' as const, userId: reference.recipientId, responsibility: 'supporto' as const,
    actions: ['request_admin'] as const, readableFields: ['title'] as const, editableFields: [], documents: [],
    expiresAt: '2026-10-24T06:00:00Z' }, reason: 'Explicit isolated technical responsibility' };
const firstToken = createTechnicalAssignmentPreview('ASSIGN', key, command, admission, now.getTime());
const firstArgs = { operation: 'ASSIGN' as const, key, raw: command, token: firstToken, admission,
  previous: null, journal: null, assignmentId, revisionId, now };
const first = prepareTechnicalAssignmentDecision(firstArgs);
// Pure fixtures, not DB evidence: real transaction identity/constraints are
// qualified only by the separate isolated PostgreSQL suite.
function journal(change: PreparedTechnicalAssignmentDecision) {
  return { ...change, decision: { ...change.decision, transactionId: 42n },
    revision: { ...change.revision, transactionId: 42n } };
}
function record(change: PreparedTechnicalAssignmentDecision): StoredTechnicalAssignment {
  const { payload: p, proof, revokedAt } = change.assignment;
  return decodeTechnicalAssignmentRecord({ id: p.id, kind: p.selection.kind, projectId: p.targetId,
    practiceId: null, recipientId: p.selection.userId, revision: p.revision, payload: p, proof,
    revokedAt: revokedAt ? new Date(revokedAt) : null })!;
}
const stored = record(first);
const expected = { ...reference, actorId: admission.actorId, sessionId, commandId,
  requestDigest: technicalAssignmentRequestDigest('ASSIGN', reference, command) };

test('the prepared decision binds personal identity, exact scope and request without auditing content', () => {
  assert.equal(first.assignment.payload.selection.userId, reference.recipientId);
  assert.equal(first.decision.receipt.actorId, admission.actorId);
  assert.equal(first.decision.receipt.sessionId, sessionId);
  assert.equal(first.decision.requestDigest, expected.requestDigest);
  assert.equal(JSON.stringify(first).includes(command.reason), false);
  assert.deepEqual(first.audit.before, { version: 0 });
  assert.deepEqual(first.audit.after, { version: 1, action: 'ASSIGN', fieldCount: 1, actionCount: 1, documentCount: 0 });
  assert.ok(readRetainedTechnicalAssignmentJournal(journal(first), key, now));
});

test('outcome reconciliation is exact and cannot migrate to another actor, session, recipient, target or request', () => {
  assert.deepEqual(readTechnicalAssignmentDecisionOutcome(journal(first), key, expected, now), first.decision.receipt);
  for (const change of [{ actorId: 'another-admin' }, { sessionId: revisionId }, { recipientId: 'technician-b' },
    { targetId: 'project-b' }, { kind: 'TechnicalPractice' as const }, { commandId: revisionId },
    { requestDigest: 'b'.repeat(64) }]) {
    assert.equal(readTechnicalAssignmentDecisionOutcome(journal(first), key, { ...expected, ...change }, now), null);
  }
});

test('changing unsigned command/session columns cannot make an old receipt reconcile a different request', () => {
  for (const delta of [{ sessionId: revisionId }, { requestDigest: 'b'.repeat(64) }]) {
    const row = journal(first);
    assert.equal(readRetainedTechnicalAssignmentJournal({ ...row, decision: { ...row.decision, ...delta } }, key, now), null);
    assert.equal(readRetainedTechnicalAssignmentJournal({ ...row, decision: { ...row.decision, ...delta,
      receipt: { ...row.decision.receipt, ...delta } } }, key, now), null);
  }
});

test('the preview cannot be reused after editing reason, fields, recipient, action or expiry', () => {
  for (const raw of [{ ...command, reason: 'Different reason' },
    { ...command, selection: { ...command.selection, readableFields: ['status'] } },
    { ...command, selection: { ...command.selection, userId: 'technician-b' } },
    { ...command, selection: { ...command.selection, actions: ['update_status'] } },
    { ...command, selection: { ...command.selection, expiresAt: '2026-10-25T06:00:00Z' } }]) {
    assert.throws(() => prepareTechnicalAssignmentDecision({ ...firstArgs, raw }));
  }
  assert.throws(() => prepareTechnicalAssignmentDecision({ ...firstArgs, now: new Date(now.getTime() + 300_000) }),
    error => {
      assert(error instanceof TechnicalAssignmentPreparationError);
      assert.equal(error.code, 'STALE');
      assert.equal(technicalAssignmentFailure(error).rejectedBeforeWrite, true);
      return true;
    });
});

test('concurrent current-state changes and missing retained evidence prevent replacement', () => {
  const nextAdmission = { ...admission, assignmentId, assignmentRevision: 1, assignmentStateSha256: stored.stateSha256 };
  const nextCommand = { ...command, commandId: revisionId, expectedRevision: 1 };
  const token = createTechnicalAssignmentPreview('ASSIGN', key, nextCommand, nextAdmission, now.getTime());
  const args = { ...firstArgs, raw: nextCommand, token, admission: nextAdmission, previous: stored, journal: journal(first) };
  assert.ok(prepareTechnicalAssignmentDecision(args));
  for (const delta of [{ journal: null }, { assignmentId: revisionId },
    { previous: { ...stored, stateSha256: 'f'.repeat(64) } }, { previous: { ...stored, revision: 2 } }]) {
    assert.throws(() => prepareTechnicalAssignmentDecision({ ...args, ...delta }));
  }
});

function revokedDecision() {
  const later = new Date('2026-10-25T06:00:00Z');
  const current = { ...admission, assignmentId, assignmentRevision: 1,
    assignmentStateSha256: stored.stateSha256, validUntil: later.getTime() + 3600_000,
    contextSha256: 'd'.repeat(64), recipientEpoch: 4 };
  const raw = { commandId: revisionId, assignmentId, expectedRevision: 1,
    expectedContextSha256: current.contextSha256, reason: 'Explicit revocation after expiry' };
  const token = createTechnicalAssignmentPreview('REVOKE', key, raw, current, later.getTime());
  const change = prepareTechnicalAssignmentDecision({ ...firstArgs, operation: 'REVOKE', raw, token, admission: current,
    previous: stored, journal: journal(first), revisionId: sessionId, now: later });
  return { change, later, current, raw, token };
}

test('explicit revocation of an expired assignment preserves selection/history and records a new decision', () => {
  const { change, later } = revokedDecision();
  assert.equal(change.assignment.payload.id, assignmentId);
  assert.equal(change.assignment.payload.revision, 2);
  assert.deepEqual(change.assignment.payload.selection, first.assignment.payload.selection);
  assert.equal(change.assignment.revokedAt, later.toISOString());
  assert.equal(change.audit.after.action, 'REVOKE');
  assert.ok(readRetainedTechnicalAssignmentJournal(journal(change), key, later));
  assert.deepEqual(readTechnicalAssignmentDecisionOutcome(journal(first), key, expected, later), first.decision.receipt);
});

test('a new command cannot silently replay a revocation; it requires an actual unrevoked prior revision', () => {
  const { change, later, current, raw } = revokedDecision();
  const revoked = record(change);
  const latest = { ...current, assignmentRevision: 2, assignmentStateSha256: revoked.stateSha256 };
  const newer = { ...raw, commandId: sessionId, expectedRevision: 2 };
  const token = createTechnicalAssignmentPreview('REVOKE', key, newer, latest, later.getTime());
  assert.throws(() => prepareTechnicalAssignmentDecision({ ...firstArgs, operation: 'REVOKE', raw: newer, token,
    admission: latest, previous: revoked, journal: journal(change), now: later }), /ALREADY_REVOKED/);
});

test('reactivation requires a new exact preview and creates a third version without resurrecting old expiry', () => {
  const { change, later, current } = revokedDecision();
  const revoked = record(change);
  const latest = { ...current, assignmentRevision: 2, assignmentStateSha256: revoked.stateSha256 };
  const raw = { ...command, commandId: sessionId, expectedRevision: 2, expectedContextSha256: latest.contextSha256,
    expectedRecipientEpoch: 4, selection: { ...command.selection, expiresAt: '2026-10-26T06:00:00Z' } };
  const token = createTechnicalAssignmentPreview('ASSIGN', key, raw, latest, later.getTime());
  const restored = prepareTechnicalAssignmentDecision({ ...firstArgs, raw, token, admission: latest,
    previous: revoked, journal: journal(change), revisionId: commandId, now: later });
  assert.equal(restored.assignment.payload.revision, 3);
  assert.equal(restored.assignment.revokedAt, null);
  assert.equal(restored.assignment.payload.selection.expiresAt, raw.selection.expiresAt);
  assert.throws(() => prepareTechnicalAssignmentDecision({ ...firstArgs, raw, token: firstToken, admission: latest,
    previous: revoked, journal: journal(change), revisionId: commandId, now: later }));
});

test('retained reconciliation rejects future timestamps, a changed key and incomplete atomic history', () => {
  assert.equal(readRetainedTechnicalAssignmentJournal(journal(first), key, new Date(now.getTime() - 1)), null);
  assert.equal(readRetainedTechnicalAssignmentJournal(journal(first), { ...key, version: 2 }, now), null);
  assert.equal(readRetainedTechnicalAssignmentJournal({ ...journal(first), audit: null }, key, now), null);
  assert.equal(readRetainedTechnicalAssignmentJournal({ ...journal(first), revision: { ...journal(first).revision, transactionId: 43n } }, key, now), null);
});

test('same command text has different request identity for a second technician or project', () => {
  assert.notEqual(expected.requestDigest, technicalAssignmentRequestDigest('ASSIGN', { ...reference, recipientId: 'technician-b' }, command));
  assert.notEqual(expected.requestDigest, technicalAssignmentRequestDigest('ASSIGN', { ...reference, targetId: 'project-b' }, command));
  assert.notEqual(expected.requestDigest, canonicalSha256(command));
});
