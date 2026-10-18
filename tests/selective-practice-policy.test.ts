import assert from 'node:assert/strict';
import test from 'node:test';
import { practiceFieldProjection, practiceOutsideSelection, practiceContextOutsideSelection,
  isSelectivePractice, selectivePracticeSelectionSchema } from '../src/lib/selective-practice-policy';
import { canViewClient, canViewProject, canViewTechnicalPractice, canEditTechnicalPractice,
  type Actor } from '../src/lib/access-control';

const selection = { practiceId: 'practice-synthetic', recipientId: 'reader-synthetic', revision: 0,
  commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['title', 'status'], expiresAt: null };
test('a selected practice discloses only explicitly chosen scalars', () => {
  const view = practiceFieldProjection({ title: 'Pratica sintetica', status: 'da_progettare',
    clientVisibleStatus: 'HIDDEN_STATUS', internalNotes: 'PRIVATE', targetPortal: 'HIDDEN_PORTAL',
    client: { displayName: 'HIDDEN_CLIENT' }, project: { title: 'HIDDEN_PROJECT' },
    communications: [{ content: 'HIDDEN_MESSAGE' }] }, ['title', 'status']);
  assert.deepEqual(view, [{ key: 'title', label: 'Titolo', value: 'Pratica sintetica' },
    { key: 'status', label: 'Stato', value: 'da_progettare' }]);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|HIDDEN/);
});
test('no parent, free-form private field, file or operation is included implicitly', () => {
  for (const field of ['clientId','projectId','clientServiceId','technicalOwnerId','internalNotes','targetPortal','communications','future']) {
    assert.equal(selectivePracticeSelectionSchema.safeParse({ ...selection, fields: [field] }).success, false);
  }
  for (const key of ['write','upload','download','documents','role']) {
    assert.equal(selectivePracticeSelectionSchema.safeParse({ ...selection, [key]: true }).success, false);
  }
  assert.equal(selectivePracticeSelectionSchema.safeParse(selection).success, true);
});
test('empty, duplicate, malformed and unversioned choices are denied', () => {
  for (const delta of [{ fields: [] }, { fields: ['status','status'] }, { practiceId: '../practice' },
    { revision: -1 }, { revision: 0.5 }, { commandId: 'missing' }, { expiresAt: 'tomorrow' }]) {
    assert.equal(selectivePracticeSelectionSchema.safeParse({ ...selection, ...delta }).success, false);
  }
  assert.throws(() => practiceFieldProjection({ title: { private: true } }, ['title']));
  assert.throws(() => practiceFieldProjection({ status: 'x' }, ['status','status']));
});
test('dates have a deterministic scalar projection and invalid dates cannot leak an object', () => {
  assert.deepEqual(practiceFieldProjection({ dueDate: new Date('2026-11-01T10:20:00Z') }, ['dueDate']),
    [{ key: 'dueDate', label: 'Scadenza', value: '2026-11-01' }]);
  assert.deepEqual(practiceFieldProjection({ dueDate: null }, ['dueDate']), [{ key: 'dueDate', label: 'Scadenza', value: '—' }]);
  for (const date of ['2026-11-01', new Date(NaN), { private: true }]) assert.throws(() => practiceFieldProjection({ dueDate: date }, ['dueDate']));
});
test('historical restrictions close ordinary read and write before role and ownership', () => {
  const client = { id: 'client', consultantId: 'reader', salesOwnerId: 'reader' };
  const practice = { id: 'selected', clientId: client.id, client, technicalOwnerId: 'reader', commercialOwnerId: 'reader' };
  for (const role of ['admin','direzione','amministrazione','commerciale','consulente','backoffice','revisore'] as const) {
    const ordinary: Actor = { userId: 'reader', role };
    assert.equal(canViewTechnicalPractice(ordinary, practice), true, role);
    const selected = { ...ordinary, selectivePracticeIds: ['selected'] };
    assert.equal(canViewTechnicalPractice(selected, practice), false, role);
    assert.equal(canEditTechnicalPractice(selected, practice), false, role);
    assert.equal(canViewTechnicalPractice(selected, { ...practice, id: undefined }), false);
  }
});
test('a practice selection neither grants nor removes independent parent and sibling permissions', () => {
  const actor: Actor = { userId: 'reader', role: 'admin', selectivePracticeIds: ['selected'] };
  const client = { id: 'parent', consultantId: 'reader', salesOwnerId: 'reader' };
  const project = { id: 'project', clientId: client.id, client, consultantId: actor.userId };
  assert.equal(canViewClient(actor, client), true);
  assert.equal(canViewProject(actor, project), true);
  assert.equal(canViewTechnicalPractice(actor, { id: 'sibling', clientId: client.id, client }), true);
  assert.equal(canEditTechnicalPractice(actor, { id: 'sibling' }), true);
  const restrictedParent = { ...actor, selectiveClientIds: ['parent'] };
  assert.equal(canViewTechnicalPractice(restrictedParent, { id: 'sibling', clientId: client.id, client }), false);
  assert.equal(canViewTechnicalPractice({ userId: 'stranger', role: 'commerciale', selectivePracticeIds: ['selected'] },
    { id: 'sibling', clientId: client.id, client }), false);
});
test('query exclusions are explicit, deduplicated and fail closed on incomplete identity', () => {
  const scope = { selectivePracticeIds: ['restricted','restricted'] };
  assert.equal(isSelectivePractice(scope), true);
  assert.equal(isSelectivePractice(scope, 'restricted'), true);
  assert.equal(isSelectivePractice(scope, 'other'), false);
  assert.equal(isSelectivePractice({}, 'restricted'), false);
  assert.deepEqual(practiceOutsideSelection(scope), { id: { notIn: ['restricted'] } });
  assert.deepEqual(practiceContextOutsideSelection(scope), { OR: [{ technicalPracticeId: null },
    { technicalPracticeId: { notIn: ['restricted'] } }] });
});
