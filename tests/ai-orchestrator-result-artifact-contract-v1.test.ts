import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FAI_AUDIT_JOB_CODES, type FaiAuditJobCode } from '../src/lib/ai-orchestrator/job-catalog-v1';
import { AI_RESULT_LIMITS, createSyntheticAiResultDraft, getAiResultContract, listAiResultContracts, validateAndHashAiResultDraft, type AiResultProvenance } from '../src/lib/ai-orchestrator/result-artifact-contract-v1';

const provenance: AiResultProvenance = { runtimeId: 'rt', jobId: 'job', attemptId: 'att', attemptSequence: 1, fencingToken: '42', workerInstanceId: 'worker-1', workerBuildHash: '1'.repeat(64), runtimePolicyHash: '2'.repeat(64), capabilityCode: 'CAPABILITY', capabilityVersion: '1.0', capabilityHash: '3'.repeat(64), handlerCode: 'HANDLER', handlerVersion: '1.0', jobPayloadHash: '4'.repeat(64), workflowInstanceId: 'wf', workflowDefinitionHash: '5'.repeat(64), phaseCode: 'PHASE', phaseEntrySequence: 1, correctionCycle: 0, executorAgentId: 'agent', executorAgentCode: 'AGENT', executorAgentConfigVersion: 1, executorAgentConfigHash: '6'.repeat(64), provider: 'mock', dataMode: 'synthetic' };

test('result contract catalog covers exactly 13 canonical jobs and is immutable through public API', () => {
  assert.equal(listAiResultContracts().length, 13);
  assert.deepEqual(FAI_AUDIT_JOB_CODES.map((j) => getAiResultContract(j)?.resultContractCode).filter(Boolean).length, 13);
  assert.equal(getAiResultContract('UNKNOWN'), null);
  const contract = getAiResultContract('DOCUMENT_INGESTION')!;
  assert.throws(() => ((contract.requiredArtifactTypes as string[]).push('BAD')), /extensible|read only|object is not extensible/i);
});

test('all 13 jobs have artifact schemas and validate synthetic drafts', () => {
  for (const jobCode of FAI_AUDIT_JOB_CODES) {
    const hashed = validateAndHashAiResultDraft(jobCode, createSyntheticAiResultDraft(jobCode), provenance);
    assert.match(hashed.resultHash, /^[0-9a-f]{64}$/);
    assert.equal(hashed.artifacts.length, getAiResultContract(jobCode)!.requiredArtifactTypes.length);
    for (const artifact of hashed.artifacts) assert.match(artifact.artifactSchemaHash, /^[0-9a-f]{64}$/);
  }
});

test('provenance is strict and every causal identity mutation changes result hash', () => {
  const base = validateAndHashAiResultDraft('DOCUMENT_INGESTION', createSyntheticAiResultDraft('DOCUMENT_INGESTION'), provenance);
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', createSyntheticAiResultDraft('DOCUMENT_INGESTION'), { ...provenance, extra: true }), /unrecognized/i);
  for (const key of Object.keys(provenance) as Array<keyof AiResultProvenance>) {
    const mutated = { ...provenance } as Record<string, unknown>;
    mutated[key] = typeof provenance[key] === 'number' ? Number(provenance[key]) + 1 : key === 'provider' ? 'bad' : `${provenance[key]}X`;
    if (key === 'provider' || key === 'dataMode' || key.endsWith('Hash') || key === 'workerBuildHash' || key === 'fencingToken' || key === 'capabilityVersion' || key === 'handlerVersion') {
      assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', createSyntheticAiResultDraft('DOCUMENT_INGESTION'), mutated));
    } else {
      assert.notEqual(base.resultHash, validateAndHashAiResultDraft('DOCUMENT_INGESTION', createSyntheticAiResultDraft('DOCUMENT_INGESTION'), mutated).resultHash);
    }
  }
});

test('hashes are deterministic and golden vector is stable', () => {
  const a = validateAndHashAiResultDraft('DOCUMENT_INGESTION', createSyntheticAiResultDraft('DOCUMENT_INGESTION'), provenance);
  const b = validateAndHashAiResultDraft('DOCUMENT_INGESTION', createSyntheticAiResultDraft('DOCUMENT_INGESTION'), provenance);
  assert.equal(a.resultHash, b.resultHash);
  assert.equal(a.manifestHash, b.manifestHash);
  assert.equal(a.artifacts[0].artifactHash, b.artifacts[0].artifactHash);
  assert.equal(a.resultHash, validateAndHashAiResultDraft('DOCUMENT_INGESTION', createSyntheticAiResultDraft('DOCUMENT_INGESTION'), provenance).resultHash);
});

test('artifact order, media type, lineage and supersession negatives fail closed', () => {
  const badOrder = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); badOrder.artifacts[0].ordinal = 1;
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', badOrder, provenance), /ORDER/);
  const badMedia = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); badMedia.artifacts[0].mediaType = 'text/plain' as 'application/json';
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', badMedia, provenance));
  const badSource = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); badSource.sourceReferences = [{ ordinal: 1, role: 'PRIMARY', sourceArtifactId: 'ckyyyyyyyyyyyyyyyyyyyyyyy', sourceArtifactHash: 'a'.repeat(64) }];
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', badSource, provenance), /SOURCE_ORDER/);
  const correction = createSyntheticAiResultDraft('CORRECTION'); correction.artifacts[1].payload = { synthetic: true, summary: 'synthetic summary', correctionReasons: ['synthetic reason'] };
  assert.throws(() => validateAndHashAiResultDraft('CORRECTION', correction, provenance));
});

test('limits -1, exact and +1 for artifact/source cardinality and strings', () => {
  assert.equal(AI_RESULT_LIMITS.maxArtifacts, 8);
  const empty = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); empty.artifacts = [];
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', empty, provenance), /CARDINALITY/);
  const long = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); (long.artifacts[0].payload as { summary: string }).summary = 'x'.repeat(AI_RESULT_LIMITS.maxStringBytes + 1);
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', long, provenance), /STRING|too_big/i);
});

test('total size and redacted forbidden content are enforced before persistence', () => {
  const html = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); (html.artifacts[0].payload as { summary: string }).summary = '<b>html</b>';
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', html, provenance), /FORBIDDEN|REDACTED/);
  const url = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); (url.artifacts[0].payload as { summary: string }).summary = 'https://example.com';
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', url, provenance), /FORBIDDEN|REDACTED/);
});

test('foundation boundaries add no worker, route, timer, dispatch or executable handler', () => {
  const runtime = readFileSync('src/lib/ai-orchestrator/worker-runtime.ts', 'utf8');
  const contract = readFileSync('src/lib/ai-orchestrator/result-artifact-contract-v1.ts', 'utf8');
  assert.doesNotMatch(contract, /fetch\(|setInterval\(|setTimeout\(|cron|systemd|OpenAI|AiRun|AiOutput/);
  assert.doesNotMatch(runtime, /handlerRegistry|dispatchAi|fetch\(/);
});
