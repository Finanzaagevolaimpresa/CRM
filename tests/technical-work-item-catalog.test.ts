import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesTechnicalWorkItemOption, selectedTechnicalWorkItemGrants, technicalWorkItemCatalogueQuery,
  technicalWorkItemOptionKey, type TechnicalWorkItemOption, type TechnicalWorkItemChoices } from '../src/lib/technical-work-item-catalog';

const task: TechnicalWorkItemOption = { kind: 'Task', itemId: 'task-a', generation: 2, scopeGeneration: 1,
  scopeSha256: 'a'.repeat(64), title: 'Attività %_[+] è pronta' };
test('catalogue validates bounds and treats search as literal normalized text', () => {
  assert.deepEqual(technicalWorkItemCatalogueQuery.parse({}), { query: '', kind: 'ALL', page: 1 });
  for (const bad of [{ query: 'x'.repeat(201) }, { page: 0 }, { page: 301 }, { page: 1.5 }, { page: '2' }, { kind: 'Document' }, { take: 999 }])
    assert.equal(technicalWorkItemCatalogueQuery.safeParse(bad).success, false);
  for (const query of ['%_[+]', 'ATTIVITÀ', 'e\u0300 pronta', ' pronta '])
    assert(matchesTechnicalWorkItemOption(task, technicalWorkItemCatalogueQuery.parse({ query })));
  assert(!matchesTechnicalWorkItemOption(task, technicalWorkItemCatalogueQuery.parse({ query: '.*' })));
  assert(!matchesTechnicalWorkItemOption(task, technicalWorkItemCatalogueQuery.parse({ kind: 'ChecklistItem' })));
});
test('selected off-page snapshots remain exact and are not silently renewed by another page', () => {
  const check: TechnicalWorkItemOption = { ...task, kind: 'ChecklistItem', itemId: 'check-b', title: 'Checklist B' };
  const choices: TechnicalWorkItemChoices = {
    [technicalWorkItemOptionKey(task)]: { option: task, readable: ['title', 'priority'], editable: ['priority'] },
    [technicalWorkItemOptionKey(check)]: { option: check, readable: ['title'], editable: [] },
  };
  const before = structuredClone(choices);
  const result = selectedTechnicalWorkItemGrants(choices, ['manage_deadlines', 'manage_checklist']);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { kind: 'Task', itemId: 'task-a', generation: 2, scopeGeneration: 1, scopeSha256: 'a'.repeat(64),
    readableFields: ['title', 'priority'], editableFields: ['priority'] });
  assert(!JSON.stringify(result).includes(task.title));
  assert.deepEqual(choices, before);
  assert.deepEqual(selectedTechnicalWorkItemGrants(choices, ['manage_checklist']), [result[1]]);
  assert.deepEqual(selectedTechnicalWorkItemGrants(choices, []), []);
});
