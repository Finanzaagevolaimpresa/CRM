import assert from 'node:assert/strict';
import test from 'node:test';
import { projectParametersSchema } from '../src/lib/project-parameters-input';
import { assertProjectParametersCurrent } from '../src/lib/project-parameters-state';
import { projectRecordChange } from '../src/lib/record-update-projection';
const sample = () => ({ description: 'PRIVATE DESCRIPTION', totalInvestment: '1000.25', requestedAmount: '', expenseVersion: 'a'.repeat(64),
  expenses: [{ id: 'original', category: 'software' as const, description: 'PRIVATE EXPENSE', amount: '200.50', estimated: true }] });
test('project parameter amounts reject rounding, non-finite, negative and excessive inputs', () => {
  assert.equal(projectParametersSchema.safeParse(sample()).success, true);
  for (const amount of ['-1', 'NaN', 'Infinity', '1e5', '1.123', '1000000000000', '01', ''])
    assert.equal(projectParametersSchema.safeParse({ ...sample(), expenses: [{ ...sample().expenses[0], amount }] }).success, false, amount);
});
test('expense row replacement cannot delete, cross-link or duplicate existing expenses', () => {
  const original = sample();
  for (const expenses of [[], [{ ...original.expenses[0], id: 'foreign' }]])
    assert.throws(() => assertProjectParametersCurrent({ ...original, expenses }, original));
  assert.equal(projectParametersSchema.safeParse({ ...original, expenses: [...original.expenses, ...original.expenses] }).success, false);
  assert.throws(() => assertProjectParametersCurrent({ ...original, expenseVersion: 'b'.repeat(64) }, original));
  assert.doesNotThrow(() => assertProjectParametersCurrent({ ...original, expenses: [...original.expenses, { ...original.expenses[0], id: null }] }, original));
});
test('eligibility and ownership are outside the project edit input', () => {
  for (const extra of [{ potentiallyEligible: true }, { eligibilityNotes: 'override' }, { projectId: 'foreign' }, { priority: 'alta' }])
    assert.equal(projectParametersSchema.safeParse({ ...sample(), expenses: [{ ...sample().expenses[0], ...extra }] }).success, false);
});
test('project change summary contains labels only and accepts legacy title-only patches', () => {
  const before = { title: 'Title', status: 'idea', parameters: sample() };
  const after = { ...before, parameters: { ...sample(), description: 'NEW PRIVATE', totalInvestment: '2000.50' } };
  assert.deepEqual(projectRecordChange('PROJECT', before, after).summaries, [{ event: 'RECORD_CHANGED', changed: ['profile'] }]);
  assert.doesNotMatch(JSON.stringify(projectRecordChange('PROJECT', before, after)), /PRIVATE|2000|1000/);
  assert.deepEqual(projectRecordChange('PROJECT', before, { title: 'Title', status: 'idea' }).summaries, []);
});
