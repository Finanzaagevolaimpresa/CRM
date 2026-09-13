import assert from 'node:assert/strict';
import test from 'node:test';
import { isEditableManualPreAnalysis, manualPreAnalysisFields } from '../src/lib/preanalysis-policy';
import { preAnalysisSchema, preAnalysisUpdateSchema } from '../src/lib/validation';

const draft = { status: 'da_avviare', aiRunId: null, reviewedById: null, approvedById: null, approvedAt: null };

test('manual pre-analysis permits only the two draft states with no review or AI evidence', () => {
  assert.equal(isEditableManualPreAnalysis(draft), true);
  assert.equal(isEditableManualPreAnalysis({ ...draft, status: 'raccolta_dati' }), true);
  for (const status of ['da_revisionare', 'revisionata', 'approvata', 'rifiutata']) assert.equal(isEditableManualPreAnalysis({ ...draft, status }), false);
  assert.equal(isEditableManualPreAnalysis({ ...draft, aiRunId: 'run' }), false);
  assert.equal(isEditableManualPreAnalysis({ ...draft, reviewedById: 'reviewer' }), false);
  assert.equal(isEditableManualPreAnalysis({ ...draft, approvedById: 'approver' }), false);
  assert.equal(isEditableManualPreAnalysis({ ...draft, approvedAt: new Date() }), false);
});

test('manual schemas expose exactly the five narrative fields and immutable context only on creation', () => {
  const narratives = Object.keys(preAnalysisSchema.shape).filter((key) => !['clientId', 'projectId', 'companyId'].includes(key));
  assert.deepEqual(narratives, [...manualPreAnalysisFields]);
  assert.deepEqual(Object.keys(preAnalysisUpdateSchema.shape), ['id', 'version', ...manualPreAnalysisFields]);
  assert.equal(preAnalysisUpdateSchema.safeParse({ id: 'pre', version: 'not-a-version' }).success, false);
});
