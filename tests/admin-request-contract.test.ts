import assert from 'node:assert/strict';
import test from 'node:test';
import { adminRequestSubmission, adminRequestStatus, adminRequestStatusLabels, admitsAdminRequestSubmission,
  adminRequestSubmissionDigest, type CurrentAdminRequestAdmission, type CurrentCommercialRequestAdmission } from '../src/lib/admin-request-contract';
import { technicalImplementedActions, type CurrentTechnicalAssignmentAdmission, type TechnicalAssignmentSelection } from '../src/lib/technical-assignment-contract';

const now = new Date('2026-10-23T10:00:00Z');
const request = {
  commandId: '5d3b72c3-f4a0-4574-8352-0019235b1f18', subject: { kind: 'Client' as const, targetId: 'client-one' },
  expectedContextSha256: 'a'.repeat(64), expectedRecipientEpoch: 4, expectedAccessRevision: 3,
  kind: 'DOCUMENT' as const, title: 'Documento tecnico richiesto', details: 'Occorre integrare il documento tecnico già previsto.',
};
const commercial: CurrentCommercialRequestAdmission = {
  role: 'commerciale', userId: 'sales-one', active: true, sessionLive: true, registryCurrent: true,
  recordWorkable: true, selectiveCeilingAllows: true, subject: request.subject, commercialOwnerId: 'sales-one',
  contextSha256: request.expectedContextSha256, recipientEpoch: 4, accessRevision: 3,
};
const selection: TechnicalAssignmentSelection = {
  kind: 'TechnicalPractice', userId: 'tech-one', responsibility: 'co_responsabile',
  actions: ['request_admin'], readableFields: ['title', 'status'], editableFields: [], documents: [],
  expiresAt: '2026-10-24T10:00:00Z',
};
const technical: CurrentTechnicalAssignmentAdmission = {
  userId: 'tech-one', role: 'consulente', active: true, sessionLive: true, targetId: 'practice-one',
  kind: 'TechnicalPractice', targetWorkable: true, parentContextValid: true, selectiveCeilingAllows: true,
  currentContextSha256: request.expectedContextSha256, currentRecipientEpoch: 4, currentRevision: 3,
  assignmentRevision: 3, assignmentContextSha256: request.expectedContextSha256, assignmentRecipientEpoch: 4, revoked: false,
};
const technicalRequest = { ...request, subject: { kind: 'TechnicalPractice' as const, targetId: 'practice-one' } };
const owner = (current = commercial): CurrentAdminRequestAdmission => ({ kind: 'COMMERCIAL_OWNER', current });
const assigned = (current = technical, scope = selection): CurrentAdminRequestAdmission => ({ kind: 'TECHNICAL_ASSIGNMENT', current, selection: scope });

test('commercial requests are limited to the current own client or lead', () => {
  assert(admitsAdminRequestSubmission(owner(), request, now));
  const lead = { kind: 'Lead' as const, targetId: 'lead-one' };
  assert(admitsAdminRequestSubmission(owner({ ...commercial, subject: lead }), { ...request, subject: lead }, now));
  assert(!admitsAdminRequestSubmission(owner(), { ...request, subject: { ...request.subject, targetId: 'client-two' } }, now));
  assert(!admitsAdminRequestSubmission(owner({ ...commercial, commercialOwnerId: 'sales-two' }), request, now));
  assert(!admitsAdminRequestSubmission(owner({ ...commercial, commercialOwnerId: null }), request, now));
});

test('another sales identity and Admin role cannot inherit the requester origin', () => {
  for (const role of ['admin', 'backoffice', 'consulente', 'collaboratore_limitato', '']) {
    assert(!admitsAdminRequestSubmission(owner({ ...commercial, role }), request, now), role);
  }
  assert(!admitsAdminRequestSubmission(owner({ ...commercial, userId: 'sales-two' }), request, now));
});

test('a commercial owner cannot claim a project or practice through a malformed server snapshot', () => {
  for (const kind of ['Project', 'TechnicalPractice'] as const) {
    const subject = { kind, targetId: 'technical-one' };
    const malformed = { ...commercial, subject } as unknown as CurrentCommercialRequestAdmission;
    assert(!admitsAdminRequestSubmission(owner(malformed), { ...request, subject }, now));
  }
});

test('closed record, access ceiling, registry and session revocation block a previously open form', () => {
  for (const field of ['active', 'sessionLive', 'registryCurrent', 'recordWorkable', 'selectiveCeilingAllows'] as const) {
    assert(!admitsAdminRequestSubmission(owner({ ...commercial, [field]: false }), request, now), field);
  }
});

test('context and monotonic access revisions reject changed or restored ownership', () => {
  for (const patch of [{ contextSha256: 'b'.repeat(64) }, { recipientEpoch: 6 }, { accessRevision: 5 },
    { recipientEpoch: -1 }, { accessRevision: Number.NaN }, { contextSha256: 'bad' }]) {
    assert(!admitsAdminRequestSubmission(owner({ ...commercial, ...patch }), request, now));
  }
});

test('the technician needs the separate request action on that exact assignment', () => {
  assert(admitsAdminRequestSubmission(assigned(), technicalRequest, now));
  assert(!admitsAdminRequestSubmission(assigned(technical, { ...selection, actions: ['update_status'] }), technicalRequest, now));
  assert(!admitsAdminRequestSubmission(assigned(), request, now));
  assert(!admitsAdminRequestSubmission(assigned(), { ...technicalRequest, subject: { ...technicalRequest.subject, targetId: 'practice-two' } }, now));
  assert(!admitsAdminRequestSubmission(assigned({ ...technical, userId: 'tech-two' }), technicalRequest, now));
});

test('two technicians can submit independently but cannot reuse each other assignment', () => {
  const second = { ...technical, userId: 'tech-two' };
  const secondSelection = { ...selection, userId: 'tech-two' };
  assert(admitsAdminRequestSubmission(assigned(second, secondSelection), technicalRequest, now));
  assert(!admitsAdminRequestSubmission(assigned(technical, secondSelection), technicalRequest, now));
  assert(!admitsAdminRequestSubmission(assigned(second, selection), technicalRequest, now));
});

test('technical request checks revocation, expiry, context, session and exact revision', () => {
  for (const patch of [{ revoked: true }, { active: false }, { sessionLive: false }, { targetWorkable: false },
    { parentContextValid: false }, { selectiveCeilingAllows: false }, { currentRevision: 4 },
    { currentRecipientEpoch: 5 }, { currentContextSha256: 'b'.repeat(64) }]) {
    assert(!admitsAdminRequestSubmission(assigned({ ...technical, ...patch }), technicalRequest, now));
  }
  assert(!admitsAdminRequestSubmission(assigned(), technicalRequest, new Date(selection.expiresAt)));
  assert(!admitsAdminRequestSubmission(assigned(), technicalRequest, new Date('invalid')));
});

test('a request is not a recipient list, email approval, upload or impersonation command', () => {
  for (const field of ['userId', 'role', 'clientId', 'assignmentId', 'recipients', 'to', 'cc', 'bcc',
    'replyTo', 'attachments', 'approved', 'send', 'provider', 'authority', 'status']) {
    assert(!adminRequestSubmission.safeParse({ ...request, [field]: true }).success, field);
  }
  assert(!adminRequestSubmission.safeParse({ ...request, subject: { ...request.subject, owner: 'sales-two' } }).success);
  assert(!adminRequestSubmission.safeParse({ ...request, expectedRecipientEpoch: -1 }).success);
});

test('bounded plain request text preserves intended paragraphs and rejects control bytes', () => {
  const input = { ...request, details: '  Prima integrazione.\nSeconda integrazione.  ' };
  assert.equal(adminRequestSubmission.parse(input).details, 'Prima integrazione.\nSeconda integrazione.');
  for (const details of [' ', 'x'.repeat(3001), 'Test\u0000segreto', 'Test\u001bmarkup']) {
    assert(!adminRequestSubmission.safeParse({ ...request, details }).success);
  }
  assert(!adminRequestSubmission.safeParse({ ...request, title: 'x'.repeat(161) }).success);
});

test('idempotency is bound to author, session, command and exact normalized request', () => {
  const author = { userId: 'sales-one', sessionId: 'session-one' };
  const original = adminRequestSubmissionDigest(author, request);
  assert.equal(original, adminRequestSubmissionDigest(author, { ...request, title: `  ${request.title}  ` }));
  for (const other of [{ userId: 'sales-two', sessionId: author.sessionId }, { ...author, sessionId: 'session-two' }]) {
    assert.notEqual(original, adminRequestSubmissionDigest(other, request));
  }
  for (const patch of [{ commandId: '6d3b72c3-f4a0-4574-8352-0019235b1f18' }, { details: 'Richiesta modificata' },
    { expectedContextSha256: 'c'.repeat(64) }, { expectedAccessRevision: 4 }, { kind: 'INTEGRATION' },
    { subject: { ...request.subject, targetId: 'client-two' } }]) {
    assert.notEqual(original, adminRequestSubmissionDigest(author, { ...request, ...patch }));
  }
  assert.throws(() => adminRequestSubmissionDigest({ ...author, userId: '' }, request));
});

test('request status cannot manufacture a send, delivery, read receipt or enable a dormant operation', () => {
  for (const state of ['SENT', 'DELIVERED', 'READ', 'APPROVED', 'ACCEPTED']) assert(!adminRequestStatus.safeParse(state).success);
  assert.equal(adminRequestStatusLabels.DRAFT_PREPARED, 'Bozza preparata, invio da decidere');
  assert(!technicalImplementedActions.some(action => String(action) === 'request_admin'));
});
