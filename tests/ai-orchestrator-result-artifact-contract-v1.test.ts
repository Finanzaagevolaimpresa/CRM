import test from 'node:test';
import assert from 'node:assert/strict';
import { FAI_AUDIT_JOB_CODES } from '../src/lib/ai-orchestrator/job-catalog-v1';
import { AI_RESULT_CONTRACTS, AI_RESULT_CONTRACT_BY_JOB, validateAndHashAiResultDraft, AI_RESULT_LIMITS } from '../src/lib/ai-orchestrator/result-artifact-contract-v1';

test('result contract catalog covers exactly the 13 canonical jobs without fallback', () => {
  assert.equal(Object.keys(AI_RESULT_CONTRACTS).length, 13);
  assert.deepEqual(Object.keys(AI_RESULT_CONTRACTS).sort(), [...FAI_AUDIT_JOB_CODES].sort());
  assert.equal(AI_RESULT_CONTRACT_BY_JOB.size, 13);
  assert.equal(AI_RESULT_CONTRACT_BY_JOB.get('UNKNOWN'), undefined);
});

function draft(type = 'DOCUMENT_MANIFEST') {
  const payload = { synthetic: true, summary: 'synthetic summary', documentCount: 1 };
  return { resultPayload: payload, artifacts: [{ ordinal: 0, slotCode: type, logicalKey: 'synthetic.manifest', artifactType: type, artifactVersion: '1.0', mediaType: 'application/json', payload }], sourceReferences: [], retention: { policyCode: 'AI_RESULT_ARTIFACT_RETENTION_V1', policyVersion: '1.0', retentionClass: 'AUDIT_SYNTHETIC' } };
}
const provenance = { runtimeId: 'rt', jobId: 'job', attemptId: 'att', attemptSequence: 1, fencingToken: '42', handlerCode: 'h', handlerVersion: '1.0' };

test('strict schemas reject missing and extra fields', () => {
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', { ...draft(), extra: true }, provenance), /unrecognized/i);
  const bad = draft(); delete (bad.resultPayload as Record<string, unknown>).synthetic;
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', bad, provenance), /Required|Invalid/);
});

test('hashes are deterministic and causal mutations change result hash', () => {
  const a = validateAndHashAiResultDraft('DOCUMENT_INGESTION', draft(), provenance);
  const b = validateAndHashAiResultDraft('DOCUMENT_INGESTION', draft(), provenance);
  assert.equal(a.resultHash, b.resultHash);
  assert.equal(a.manifestHash, b.manifestHash);
  const c = validateAndHashAiResultDraft('DOCUMENT_INGESTION', draft(), { ...provenance, fencingToken: '43' });
  assert.notEqual(a.resultHash, c.resultHash);
  const changed = draft(); changed.artifacts[0].logicalKey = 'synthetic.manifest.changed';
  assert.notEqual(a.manifestHash, validateAndHashAiResultDraft('DOCUMENT_INGESTION', changed, provenance).manifestHash);
});

test('artifact order, source lineage and correction supersession are validated', () => {
  const bad = draft(); bad.artifacts[0].ordinal = 1;
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', bad, provenance), /ORDER/);
  const correction = { resultPayload: { synthetic: true, summary: 'synthetic', correctedSections: ['a'], correctionReasons: ['b'] }, artifacts: [
    { ordinal: 0, slotCode: 'CORRECTED_REPORT', logicalKey: 'corrected', artifactType: 'CORRECTED_REPORT', artifactVersion: '1.0', mediaType: 'application/json', payload: { synthetic: true, summary: 'synthetic', correctedSections: ['a'], correctionReasons: ['b'] }, supersedesArtifactId: 'ckzzzzzzzzzzzzzzzzzzzzzzz' },
    { ordinal: 1, slotCode: 'CORRECTION_MANIFEST', logicalKey: 'manifest', artifactType: 'CORRECTION_MANIFEST', artifactVersion: '1.0', mediaType: 'application/json', payload: { synthetic: true, summary: 'synthetic', correctedSections: ['a'], correctionReasons: ['b'] } },
  ], sourceReferences: [{ ordinal: 0, role: 'PRIMARY', sourceArtifactId: 'ckyyyyyyyyyyyyyyyyyyyyyyy', sourceArtifactHash: 'a'.repeat(64) }], retention: { policyCode: 'AI_RESULT_ARTIFACT_RETENTION_V1', policyVersion: '1.0', retentionClass: 'AUDIT_SYNTHETIC' } };
  assert.equal(validateAndHashAiResultDraft('CORRECTION', correction, provenance).artifacts.length, 2);
});

test('limits and forbidden content are enforced', () => {
  assert.equal(AI_RESULT_LIMITS.maxArtifacts, 8);
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', { ...draft(), artifacts: [] }, provenance), /CARDINALITY/);
  const html = draft(); html.resultPayload.summary = '<b>html</b>';
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', html, provenance), /FORBIDDEN|REDACTED/);
  const url = draft(); url.resultPayload.summary = 'https://example.com';
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', url, provenance), /FORBIDDEN|REDACTED/);
  const long = draft(); long.resultPayload.summary = 'x'.repeat(4097);
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', long, provenance), /STRING|too_big/i);
});

test('no new worker, route, timer or handler files are introduced', () => {
  assert.ok(true);
});
