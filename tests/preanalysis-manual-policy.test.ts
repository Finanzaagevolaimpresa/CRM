import assert from 'node:assert/strict';
import test from 'node:test';
import { isEditableManualPreAnalysis, manualPreAnalysisFields } from '../src/lib/preanalysis-policy';
import { preAnalysisSchema, preAnalysisUpdateSchema } from '../src/lib/validation';
import { canEditProject } from '../src/lib/access-control';
import { hasPermission, type AuthSession } from '../src/lib/auth';

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

test('UI edit admission requires both project.write and canonical project ABAC', () => {
  const context = { id: 'project', clientId: 'client', consultantId: 'owner', client: { id: 'client', salesOwnerId: null, consultantId: 'owner' } };
  const session = (userId: string, role: AuthSession['role'], permissionOverrides: AuthSession['permissionOverrides'] = []): AuthSession => ({ userId, role, active: true, permissionOverrides, expiresAt: 4_102_444_800 });
  const readOnly = session('reviewer', 'revisore');
  const overrideDenied = session('operator', 'backoffice', [{ permission: 'project.write', allowed: true }]);
  const owner = session('owner', 'consulente');
  assert.equal(hasPermission(readOnly, 'project.write') && canEditProject(readOnly, context), false);
  assert.equal(hasPermission(overrideDenied, 'project.write'), true);
  assert.equal(canEditProject(overrideDenied, context), false);
  assert.equal(hasPermission(owner, 'project.write') && canEditProject(owner, context), true);
});
