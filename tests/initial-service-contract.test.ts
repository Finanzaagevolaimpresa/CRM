import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { initialServiceCodes, INITIAL_SERVICES, INITIAL_SERVICE_AGENT_IDS, INITIAL_SERVICE_DISCLAIMER, INITIAL_SERVICE_LOGO_SHA256,
  initialServicePlanHash, initialServiceStages, assessInitialServiceReviews, buildInitialServiceTemplate,
  type InitialServicePlan, type InitialServiceReview } from '../src/lib/initial-service-contract';

const plan = (serviceCode: InitialServicePlan['serviceCode']): InitialServicePlan => ({
  protocol: 'FAI_INITIAL_SERVICE_MANUAL_V1', workflowId: randomUUID(), caseId: 'synthetic-case', serviceId: 'synthetic-service',
  serviceCode, definitionVersion: 1, outputKind: 'REPORT', numericAnalysis: false, supportingAgents: [],
  planVersion: 1, responsibleUserId: null, humanReviewerIds: [],
});
function evidence(p: InitialServicePlan, version: { id: string; contentHash: string }) {
  const policy = initialServiceStages(p);
  return policy.stages.map((stage): InitialServiceReview => ({ stage, decision: stage === 'Q02' && !policy.q02Required ? 'NOT_APPLICABLE' : 'PASS',
    versionId: version.id, versionHash: version.contentHash, planHash: initialServicePlanHash(p),
    actorId: stage.startsWith('HUMAN_') ? 'synthetic-' + stage : 'synthetic-operator', recordedAt: '2026-09-27T00:00:00.000Z',
    source: stage.startsWith('HUMAN_') || (stage === 'Q02' && !policy.q02Required) ? 'AUTHENTICATED_HUMAN' : 'MANUAL_WORK_ATTESTATION',
    reference: 'SYNTHETIC_EVIDENCE', artifactHash: 'a'.repeat(64), note: 'Synthetic evidence with explicit applicability rationale.',
    agentId: stage.startsWith('HUMAN_') || (stage === 'Q02' && !policy.q02Required) ? null : stage === 'PRODUCER' ? policy.producer : stage as 'A00' | 'Q01' | 'Q02' | 'Q03' | 'D01',
    agentVersionReference: stage.startsWith('HUMAN_') || (stage === 'Q02' && !policy.q02Required) ? null : 'SYNTHETIC_VERSION',
  }));
}
test('M5 five initial services have autonomous outputs, original brand and explicit manual review contracts', () => {
  assert.equal(INITIAL_SERVICE_AGENT_IDS.length, 16);
  assert.equal(createHash('sha256').update(readFileSync('public/logo-fai.png')).digest('hex'), INITIAL_SERVICE_LOGO_SHA256);
  for (const code of initialServiceCodes) {
    const p = plan(code), definition = INITIAL_SERVICES[code], version = { id: randomUUID(), contentHash: 'b'.repeat(64), createdById: 'synthetic-author' };
    const content = buildInitialServiceTemplate(code, { clientName: 'Synthetic client', date: '2026-09-27', revision: 1,
      sections: Object.fromEntries(definition.sections.map(section => [section, 'Synthetic complete example; no financial advice or real delivery.'])),
      sources: [{ title: 'Synthetic source', reference: 'SYNTHETIC_SOURCE', verifiedAt: '2026-09-27', limitation: 'Synthetic evidence, no live measure qualification.' }],
      limits: 'Synthetic case only.', nextStep: 'Human validates the result; no further purchase is required.' });
    assert.ok(content.includes(INITIAL_SERVICE_DISCLAIMER)); assert.ok(content.includes('logo-fai.png'));
    assert.equal(assessInitialServiceReviews(p, evidence(p, version), version).ready, true);
    assert.equal(assessInitialServiceReviews(p, [], version).nextStage, 'A00');
  }
});
test('M5 exact version and ordered stages prevent stale approval and bypass of review changes', () => {
  const p = plan('dossier_preanalisi'), version = { id: randomUUID(), contentHash: 'b'.repeat(64), createdById: 'synthetic-author' }, rows = evidence(p, version);
  assert.throws(() => assessInitialServiceReviews(p, rows.slice(1), version), /CONFLICT/);
  assert.throws(() => assessInitialServiceReviews(p, rows, { ...version, contentHash: 'c'.repeat(64) }), /CONFLICT/);
  const changes = [...rows.slice(0, 2), { ...rows[2], decision: 'REQUEST_CHANGES' }];
  assert.equal(assessInitialServiceReviews(p, changes, version).blocked, 'CHANGES_REQUIRED');
  assert.throws(() => assessInitialServiceReviews(p, [...changes, rows[3]], version), /CONFLICT/);
  assert.throws(() => assessInitialServiceReviews(p, rows.map(r => r.stage === 'HUMAN_1' ? { ...r, actorId: version.createdById } : r), version), /DENIED/);
});
test('M5 numerical review and two real human reviewers cannot be replaced by non-applicability or an AI identity', () => {
  for (const outputKind of ['BUSINESS_PLAN', 'APPLICATION'] as const) {
    const p = { ...plan('dossier_preanalisi'), outputKind }, version = { id: randomUUID(), contentHash: 'b'.repeat(64), createdById: 'synthetic-author' }, rows = evidence(p, version);
    assert.equal(initialServiceStages(p).humanReviewersRequired, 2);
    assert.throws(() => assessInitialServiceReviews(p, rows.map(r => r.stage === 'Q02' ? { ...r, decision: 'NOT_APPLICABLE' } : r), version), /DENIED/);
    assert.throws(() => assessInitialServiceReviews(p, rows.map(r => r.stage === 'HUMAN_2' ? { ...r, actorId: 'synthetic-HUMAN_1' } : r), version), /DENIED/);
    assert.throws(() => assessInitialServiceReviews(p, rows.map(r => r.stage === 'HUMAN_1' ? { ...r, source: 'MANUAL_WORK_ATTESTATION', agentId: 'Q03' } : r), version), /DENIED/);
  }
  for (const supportingAgent of ['A07', 'A09', 'A10', 'A11'] as const)
    assert.equal(initialServiceStages({ ...plan('dossier_preanalisi'), supportingAgents: [supportingAgent] }).humanReviewersRequired, 2);
  assert.equal(initialServiceStages(plan('audit_ai_bancabilita')).q02Required, true);
});
test('M5 templates require service-specific sections and traceable sources without invented current measures', () => {
  assert.throws(() => buildInitialServiceTemplate('verifica_ai_essenziale', { clientName: 'Synthetic', date: '2026-09-27', revision: 1,
    sections: { Generic: 'Not the contracted result' }, sources: [], limits: 'Synthetic only', nextStep: 'Human review' }));
});
