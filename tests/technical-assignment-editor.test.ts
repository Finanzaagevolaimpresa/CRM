import assert from 'node:assert/strict';
import test from 'node:test';
import { retainedTechnicalAssignmentEditor } from '../src/lib/technical-assignment-editor';
import { technicalAssignmentSelection } from '../src/lib/technical-assignment-contract';
import { selectedTechnicalDocuments } from '../src/lib/technical-document-catalog';
import { selectedTechnicalWorkItemGrants } from '../src/lib/technical-work-item-catalog';

function fixture() {
  const selection = technicalAssignmentSelection.parse({ kind: 'TechnicalPractice', userId: 'tech-synthetic',
    responsibility: 'co_responsabile', actions: ['update_fields', 'request_admin', 'manage_deadlines', 'upload_document'],
    readableFields: ['title', 'priority', 'status', 'technicalOwnerName'], editableFields: ['priority'],
    expiresAt: '2026-10-25T01:30:00.000Z',
    documents: [false, true].map((allowDownload, i) => ({ documentId: 'doc-' + i, fileId: 'file-' + i,
      version: i + 1, contentSha256: 'a'.repeat(64), contextSha256: 'b'.repeat(64), allowDownload })),
    workItems: [{ kind: 'Task', itemId: 'task-synthetic', generation: 4, scopeGeneration: 3,
      scopeSha256: 'c'.repeat(64), readableFields: ['title', 'dueAt'], editableFields: ['dueAt'] }],
    uploadProfile: { purpose: 'Deposito sintetico', formats: ['.pdf'], maxFileBytes: 1048577,
      maxFilesPerRevision: 2, maxBytesPerRevision: 2097153, visibility: 'PRIVATE_PENDING_ADMIN_REVIEW' } });
  return { kind: 'TechnicalPractice' as const, recipientId: 'tech-synthetic', assignmentId: 'assignment-synthetic',
    assignments: [{ id: 'assignment-synthetic', recipientId: 'tech-synthetic', revokedAt: null as Date | null, selection }],
    documents: [], workItems: [] };
}
test('retained grant round-trips exact fields, off-page versions, download choices, item generations and byte quotas', () => {
  const input = fixture(), source = structuredClone(input.assignments[0].selection);
  const editor = retainedTechnicalAssignmentEditor(input);
  assert.equal(editor.retained, true); assert.equal(editor.responsibility, source.responsibility);
  assert.deepEqual(editor.readable, source.readableFields); assert.deepEqual(editor.editable, source.editableFields);
  assert.deepEqual(editor.actions, source.actions); assert.equal(editor.expires, source.expiresAt);
  assert.deepEqual(selectedTechnicalDocuments(editor.documents), source.documents);
  assert.deepEqual(selectedTechnicalWorkItemGrants(editor.workItems, editor.actions), source.workItems);
  assert.equal(Number(editor.upload.fileMiB) * 1048576, source.uploadProfile!.maxFileBytes);
  assert.equal(Number(editor.upload.totalMiB) * 1048576, source.uploadProfile!.maxBytesPerRevision);
  assert.equal(editor.documents['file-0'].option.retainedReference, true);
  editor.readable.push('commercialOwnerName'); editor.documents['file-0'].download = true; editor.upload.formats.push('.txt');
  assert.deepEqual(input.assignments[0].selection, source);
});
test('catalogue metadata never refreshes an old content hash or work-item generation silently', () => {
  const input = fixture(), source = input.assignments[0].selection;
  const stale = { ...input, documents: source.documents.map(doc => ({ ...doc, contentSha256: 'd'.repeat(64),
    title: 'Different current version', fileName: 'different.pdf', mimeType: 'application/pdf' })),
    workItems: source.workItems!.map(item => ({ ...item, generation: item.generation + 1, title: 'Changed item' })) };
  const editor = retainedTechnicalAssignmentEditor(stale);
  assert.equal(editor.documents['file-0'].option.retainedReference, true);
  assert.equal(editor.workItems['Task:task-synthetic'].option.retainedReference, true);
  assert.deepEqual(selectedTechnicalDocuments(editor.documents), source.documents);
  assert.deepEqual(selectedTechnicalWorkItemGrants(editor.workItems, editor.actions), source.workItems);
});
test('only exact currently admitted metadata decorates retained references without changing permissions', () => {
  const input = fixture(), source = input.assignments[0].selection;
  const editor = retainedTechnicalAssignmentEditor({ ...input, documents: source.documents.map(doc => ({ ...doc,
    allowDownload: true, title: 'Synthetic title', fileName: 'synthetic.pdf', mimeType: 'application/pdf' })),
    workItems: source.workItems!.map(item => ({ ...item, title: 'Synthetic deadline' })) });
  assert.equal(editor.documents['file-0'].option.title, 'Synthetic title');
  assert.equal(editor.documents['file-0'].option.retainedReference, undefined);
  assert.equal(editor.documents['file-0'].download, false);
  assert.equal(editor.workItems['Task:task-synthetic'].option.title, 'Synthetic deadline');
});
test('revoked, other-recipient, other-kind and absent grants cannot seed a new assignment', () => {
  const input = fixture();
  const candidates = [{ ...input, recipientId: 'someone-else' }, { ...input, kind: 'Project' as const },
    { ...input, assignmentId: null }, { ...input, assignments: [{ ...input.assignments[0], revokedAt: new Date() }] }];
  for (const candidate of candidates) {
    const editor = retainedTechnicalAssignmentEditor(candidate);
    assert.equal(editor.retained, false); assert.deepEqual(editor.actions, []); assert.deepEqual(editor.documents, {});
    assert.deepEqual(editor.workItems, {}); assert.equal(editor.expires, '');
  }
});
test('expired grants and historical absent upload profiles are not renewed or manufactured', () => {
  const input = fixture(); delete input.assignments[0].selection.uploadProfile;
  const editor = retainedTechnicalAssignmentEditor(input);
  assert.equal(editor.expires, '2026-10-25T01:30:00.000Z');
  assert.equal(editor.upload.purpose, ''); assert.equal(editor.upload.files, ''); assert.deepEqual(editor.upload.formats, []);
});
