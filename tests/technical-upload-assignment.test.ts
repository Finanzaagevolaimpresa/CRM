import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../src/lib/canonical-json';
import { admitsTechnicalAssignmentAction, technicalAssignmentCommand, technicalAssignmentSelection,
  type TechnicalAssignmentSelection, type CurrentTechnicalAssignmentAdmission } from '../src/lib/technical-assignment-contract';
import { createTechnicalAssignmentPreview, readTechnicalAssignmentPreview,
  type TechnicalAssignmentPreviewAdmission } from '../src/lib/technical-assignment-preview';
import { technicalAssignmentProof } from '../src/lib/technical-assignment-proof';
import { technicalUploadProfile, type TechnicalUploadProfile } from '../src/lib/technical-upload-profile';

const now = Date.parse('2026-10-24T12:00:00Z');
const key = { version: 1, secret: 'synthetic-upload-assignment-key-01' };
const profile: TechnicalUploadProfile = { purpose: 'Elaborati tecnici', formats: ['.pdf', '.txt'],
  maxFileBytes: 1024, maxFilesPerRevision: 3, maxBytesPerRevision: 2048, visibility: 'PRIVATE_PENDING_ADMIN_REVIEW' };
const legacy: TechnicalAssignmentSelection = { kind: 'TechnicalPractice', userId: 'tech_a', responsibility: 'supporto',
  actions: ['request_admin'], readableFields: ['title'], editableFields: [], documents: [],
  expiresAt: '2026-10-25T12:00:00Z' };
const selection: TechnicalAssignmentSelection = { ...legacy, actions: ['request_admin', 'upload_document'], uploadProfile: profile };
const command = { commandId: 'd52308eb-266d-4c24-a342-0189c6bdaf8d', targetId: 'practice_a',
  expectedRevision: 0, expectedRecipientEpoch: 3, expectedContextSha256: 'a'.repeat(64),
  selection, reason: 'Deposito privato di elaborati' };
const previewAdmission: TechnicalAssignmentPreviewAdmission = { actorId: 'personal_admin',
  sessionId: '4925c88d-61e3-490c-b035-d323eebbd5b0', authorityRevision: 1, actorEpoch: 2, recipientEpoch: 3,
  kind: 'TechnicalPractice', targetId: 'practice_a', recipientId: 'tech_a',
  assignmentId: null, assignmentRevision: 0, assignmentStateSha256: null,
  contextSha256: command.expectedContextSha256, validUntil: now + 600_000 };
const current: CurrentTechnicalAssignmentAdmission = { userId: 'tech_a', role: 'consulente', active: true, sessionLive: true,
  targetId: 'practice_a', kind: 'TechnicalPractice', targetWorkable: true, parentContextValid: true,
  selectiveCeilingAllows: true, currentContextSha256: 'a'.repeat(64), assignmentContextSha256: 'a'.repeat(64),
  currentRecipientEpoch: 3, assignmentRecipientEpoch: 3, currentRevision: 1, assignmentRevision: 1, revoked: false };
const requested = { targetId: 'practice_a', kind: 'TechnicalPractice' as const, action: 'upload_document' as const };
const encode = (value: unknown) => Buffer.from(canonicalJson(value)).toString('base64url');
const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

test('omitted upload profiles preserve historical canonical selection and signature without defaults', () => {
  const parsed = technicalAssignmentSelection.parse(legacy);
  assert.deepEqual(parsed, legacy);
  assert.equal(Object.hasOwn(parsed, 'uploadProfile'), false);
  assert.equal(canonicalJson(parsed), canonicalJson(legacy));
  assert.equal(technicalAssignmentProof(key, 'assignment', parsed), technicalAssignmentProof(key, 'assignment', legacy));
  assert.deepEqual(technicalAssignmentCommand.parse({ ...command, selection: legacy }).selection, legacy);
});

test('retained dormant action remains parseable but cannot authorize a deposit or a new decision without a profile', () => {
  const historical = technicalAssignmentSelection.parse({ ...legacy, actions: ['request_admin', 'upload_document'] });
  assert.equal(Object.hasOwn(historical, 'uploadProfile'), false);
  assert.equal(admitsTechnicalAssignmentAction(current, historical, requested, new Date(now)), false);
  assert.equal(admitsTechnicalAssignmentAction(current, historical, { ...requested, action: 'request_admin' }, new Date(now)), true);
  assert.equal(technicalAssignmentCommand.safeParse({ ...command, selection: historical }).success, false);
  assert.throws(() => createTechnicalAssignmentPreview('ASSIGN', key, { ...command, selection: historical }, previewAdmission, now));
});

test('a profile cannot bypass separate action, private visibility, bounded quotas or closed formats', () => {
  assert.equal(technicalAssignmentSelection.safeParse({ ...legacy, uploadProfile: profile }).success, false);
  for (const delta of [{ visibility: 'PUBLISHED' }, { allowDownload: true }, { formats: ['.zip'] },
    { formats: ['.pdf', '.pdf'] }, { maxFileBytes: 26 * 1024 * 1024 }, { maxFilesPerRevision: 21 },
    { maxBytesPerRevision: 4096 }, { maxBytesPerRevision: 512 }, { purpose: '' }]) {
    assert.equal(technicalUploadProfile.safeParse({ ...profile, ...delta }).success, false);
    assert.equal(technicalAssignmentCommand.safeParse({ ...command, selection: { ...selection, uploadProfile: { ...profile, ...delta } } }).success, false);
  }
});

test('personal preview signs each selected profile value, recipient and exact target', () => {
  const token = createTechnicalAssignmentPreview('ASSIGN', key, command, previewAdmission, now);
  assert.deepEqual(readTechnicalAssignmentPreview('ASSIGN', key, token, previewAdmission, now + 1), command);
  for (const delta of [{ purpose: 'Altra finalità' }, { formats: ['.pdf'] }, { maxFileBytes: 800 },
    { maxFilesPerRevision: 2 }, { maxBytesPerRevision: 3072 }]) {
    const row = decode(token); row.payload.input.selection.uploadProfile = { ...profile, ...delta };
    assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, encode(row), previewAdmission, now + 1), null);
  }
  for (const delta of [{ recipientId: 'tech_b' }, { targetId: 'practice_b' }, { authorityRevision: 2 }, { recipientEpoch: 4 }])
    assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, token, { ...previewAdmission, ...delta }, now + 1), null);
});

test('an earlier preview cannot acquire an upload profile or action after the Admin decision', () => {
  const prior = { ...command, selection: legacy };
  const token = createTechnicalAssignmentPreview('ASSIGN', key, prior, previewAdmission, now);
  assert.deepEqual(readTechnicalAssignmentPreview('ASSIGN', key, token, previewAdmission, now + 1), prior);
  const row = decode(token); row.payload.input.selection = selection;
  assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, encode(row), previewAdmission, now + 1), null);
});

test('an explicitly profiled action still obeys current recipient, role, lifecycle, expiry and revocation', () => {
  assert.equal(admitsTechnicalAssignmentAction(current, selection, requested, new Date(now)), true);
  for (const delta of [{ userId: 'tech_b' }, { role: 'commerciale' }, { role: 'admin' }, { active: false },
    { sessionLive: false }, { revoked: true }, { currentRevision: 2 }, { currentRecipientEpoch: 4 },
    { targetWorkable: false }, { parentContextValid: false }, { selectiveCeilingAllows: false }])
    assert.equal(admitsTechnicalAssignmentAction({ ...current, ...delta }, selection, requested, new Date(now)), false);
  assert.equal(admitsTechnicalAssignmentAction(current, selection, { ...requested, targetId: 'practice_b' }, new Date(now)), false);
  assert.equal(admitsTechnicalAssignmentAction(current, selection, requested, new Date(selection.expiresAt)), false);
});

