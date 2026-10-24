import assert from 'node:assert/strict';
import test from 'node:test';
import { adminRequestReviewCommand, planAdminRequestReview,
  type CurrentAdminRequestReviewAdmission } from '../src/lib/admin-request-review-contract';

const current: CurrentAdminRequestReviewAdmission = {
  userId: 'personal-admin', role: 'admin', active: true, sessionLive: true,
  registryCurrent: true, personalEmailAuthority: true, contextCurrent: true,
};
const state = { requestId: 'd4edbc66-3d75-4a50-a1d3-bfe6eb968377', authorUserId: 'tech-one',
  revision: 4, status: 'OPEN', submissionSha256: 'a'.repeat(64), hasLinkedDraft: false };
const command = { commandId: '94724301-a4f9-4b45-86b7-70e0b73e467b', requestId: state.requestId,
  expectedRevision: 4, expectedSubmissionSha256: state.submissionSha256,
  action: 'REQUEST_INFORMATION', requesterReply: 'Indica quale integrazione tecnica occorre.' };

test('the personal Admin may ask for information or reject the exact open request', () => {
  const plan = planAdminRequestReview(current, state, command);
  assert(plan);
  assert.equal(plan.status, 'NEEDS_INFORMATION');
  assert.equal(plan.nextRevision, 5);
  assert.equal(plan.requesterReply, command.requesterReply);
  assert.equal(planAdminRequestReview(current, { ...state, status: 'NEEDS_INFORMATION' },
    { ...command, action: 'REJECT' })?.status, 'REJECTED');
});

test('an Admin role alone, revoked session, authority or context never admits review', () => {
  for (const field of ['active', 'sessionLive', 'registryCurrent', 'personalEmailAuthority', 'contextCurrent'] as const) {
    assert.equal(planAdminRequestReview({ ...current, [field]: false }, state, command), null, field);
  }
  for (const role of ['commerciale', 'consulente', 'backoffice', 'collaboratore_limitato']) {
    assert.equal(planAdminRequestReview({ ...current, role }, state, command), null, role);
  }
});

test('stale or cross-request review and a second use after the first revision are rejected', () => {
  for (const patch of [{ requestId: 'e4edbc66-3d75-4a50-a1d3-bfe6eb968377' },
    { expectedRevision: 3 }, { expectedSubmissionSha256: 'b'.repeat(64) }]) {
    assert.equal(planAdminRequestReview(current, state, { ...command, ...patch }), null);
  }
  const first = planAdminRequestReview(current, state, command)!;
  assert.equal(planAdminRequestReview(current, { ...state, revision: first.nextRevision, status: first.status }, command), null);
});

test('terminal requests and existing draft links require their own reconciliation path', () => {
  for (const status of ['REJECTED', 'WITHDRAWN', 'DRAFT_PREPARED']) {
    assert.equal(planAdminRequestReview(current, { ...state, status }, command), null, status);
  }
  assert.equal(planAdminRequestReview(current, { ...state, hasLinkedDraft: true }, command), null);
});

test('the review command cannot submit an approval, sender, recipients, attachments or state', () => {
  for (const key of ['userId', 'role', 'approved', 'send', 'to', 'cc', 'bcc', 'attachments', 'status', 'draftId', 'hasLinkedDraft']) {
    assert.equal(adminRequestReviewCommand.safeParse({ ...command, [key]: true }).success, false, key);
  }
  for (const action of ['APPROVE', 'SEND', 'DRAFT_PREPARED', 'DELIVERED']) {
    assert.equal(planAdminRequestReview(current, state, { ...command, action }), null, action);
  }
});

test('review audit is minimal and its digest binds actor, exact reply and decision', () => {
  const plan = planAdminRequestReview(current, state, command)!;
  assert(!JSON.stringify(plan.audit).includes(command.requesterReply));
  assert(!JSON.stringify(plan.audit).includes(state.authorUserId));
  assert.equal(plan.audit.commandSha256, planAdminRequestReview(current, state,
    { ...command, requesterReply: `  ${command.requesterReply}  ` })?.audit.commandSha256);
  assert.notEqual(plan.audit.commandSha256, planAdminRequestReview(current, state,
    { ...command, requesterReply: 'Indica un diverso documento tecnico.' })?.audit.commandSha256);
  assert.notEqual(plan.audit.commandSha256, planAdminRequestReview(current, state,
    { ...command, action: 'REJECT' })?.audit.commandSha256);
  assert.notEqual(plan.audit.commandSha256, planAdminRequestReview({ ...current, userId: 'other-personal-admin' },
    state, command)?.audit.commandSha256);
});

test('control bytes, oversize reply and a non-incrementable revision fail closed', () => {
  for (const requesterReply of ['', 'x'.repeat(2001), 'Test\u0000hidden', 'Test\u001bhidden']) {
    assert.equal(planAdminRequestReview(current, state, { ...command, requesterReply }), null);
  }
  assert.equal(planAdminRequestReview(current, { ...state, revision: Number.MAX_SAFE_INTEGER },
    { ...command, expectedRevision: Number.MAX_SAFE_INTEGER }), null);
});
