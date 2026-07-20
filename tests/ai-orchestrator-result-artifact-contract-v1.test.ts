import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson, canonicalSha256, sha256 } from '../src/lib/canonical-json';
import { FAI_AUDIT_JOB_CODES, type FaiAuditJobCode } from '../src/lib/ai-orchestrator/job-catalog-v1';
import {
  AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
  getAiOrchestratorWorkerCapability,
} from '../src/lib/ai-orchestrator/worker-runtime-policy-v1';
import {
  AI_RESULT_CONTRACT_CATALOG_HASH,
  AI_RESULT_LIMITS,
  createSyntheticAiResultDraft,
  getAiResultContract,
  listAiResultContracts,
  validateAiResultJsonValue,
  validateAndHashAiResultDraft,
  type AiResultArtifactDraft,
  type AiResultProvenance,
} from '../src/lib/ai-orchestrator/result-artifact-contract-v1';

function provenanceFor(jobCode: FaiAuditJobCode): AiResultProvenance {
  const capability = getAiOrchestratorWorkerCapability(jobCode)!;
  return {
    runtimeId: 'rt',
    jobId: 'job',
    attemptId: 'att',
    attemptSequence: 1,
    fencingToken: '42',
    workerInstanceId: 'worker-1',
    workerBuildHash: '1'.repeat(64),
    runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
    capabilityCode: capability.capabilityCode,
    capabilityVersion: capability.capabilityVersion,
    capabilityHash: AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[jobCode],
    handlerCode: capability.handlerCode,
    handlerVersion: capability.handlerVersion,
    jobPayloadHash: '4'.repeat(64),
    workflowInstanceId: 'wf',
    workflowDefinitionHash: '5'.repeat(64),
    phaseCode: 'PHASE',
    phaseEntrySequence: 1,
    correctionCycle: 0,
    executorAgentId: 'agent',
    executorAgentCode: capability.executorAgentCode,
    executorAgentConfigVersion: capability.executorAgentConfigVersion,
    executorAgentConfigHash: capability.executorAgentConfigHash,
    provider: 'mock',
    dataMode: 'synthetic',
  };
}

const provenance = provenanceFor('DOCUMENT_INGESTION');

function cuid(index: number) {
  return `c${index.toString(36).padStart(24, '0')}`;
}

function sourceReference(index: number, role: 'PRIMARY' | 'SUPPORTING' | 'SUPERSEDED' = 'PRIMARY') {
  return {
    sourceArtifactId: cuid(index + 1),
    sourceArtifactHash: sha256(`synthetic-source-artifact-${index}`),
    role,
    ordinal: index,
  } as const;
}

function artifactHashForDraft(draft: AiResultArtifactDraft, artifactIndex: number) {
  const contract = getAiResultContract('CORRECTION')!;
  const artifact = draft.artifacts[artifactIndex];
  const schema = contract.artifactSchemas[artifact.artifactType];
  assert.ok(schema);
  const payloadHash = sha256(`ai.payload.v1\n${canonicalJson(artifact.payload)}`);
  return canonicalSha256({
    domain: 'ai.artifact.v1',
    artifactType: artifact.artifactType,
    ordinal: artifact.ordinal,
    slotCode: artifact.slotCode,
    logicalKey: artifact.logicalKey,
    artifactVersion: artifact.artifactVersion,
    mediaType: artifact.mediaType,
    artifactSchemaHash: schema.artifactSchemaHash,
    payloadHash,
    supersedesArtifactId: artifact.supersedesArtifactId ?? null,
  });
}

function refreshCorrectionResultPayload(draft: AiResultArtifactDraft) {
  draft.resultPayload = {
    synthetic: true,
    summary: 'synthetic summary',
    correctedReportHash: artifactHashForDraft(draft, 0),
    correctionManifestHash: artifactHashForDraft(draft, 1),
  };
}

function stringArrayAtCanonicalBytes(targetBytes: number) {
  for (let count = 1; count < AI_RESULT_LIMITS.maxJsonNodes; count += 1) {
    const values = Array.from({ length: count }, () => '');
    const baseBytes = Buffer.byteLength(canonicalJson(values), 'utf8');
    const capacity = count * AI_RESULT_LIMITS.maxStringBytes;
    if (baseBytes > targetBytes || targetBytes - baseBytes > capacity) continue;
    let remaining = targetBytes - baseBytes;
    for (let index = 0; index < values.length && remaining > 0; index += 1) {
      const length = Math.min(remaining, AI_RESULT_LIMITS.maxStringBytes);
      values[index] = 'x'.repeat(length);
      remaining -= length;
    }
    assert.equal(Buffer.byteLength(canonicalJson(values), 'utf8'), targetBytes);
    return values;
  }
  throw new Error(`Unable to construct canonical JSON at ${targetBytes} bytes.`);
}

function nestedJsonAtDepth(depth: number): unknown {
  let value: unknown = null;
  for (let current = 1; current < depth; current += 1) value = { child: value };
  return value;
}

test('result contract catalog covers exactly 13 canonical jobs and exposes immutable validation policy identity', () => {
  assert.equal(listAiResultContracts().length, 13);
  assert.equal(FAI_AUDIT_JOB_CODES.map((jobCode) => getAiResultContract(jobCode)?.resultContractCode).filter(Boolean).length, 13);
  assert.equal(getAiResultContract('UNKNOWN'), null);
  const contract = getAiResultContract('DOCUMENT_INGESTION')!;
  assert.equal(contract.resultSchema.policy.objectStrictness, 'reject-unknown-keys-recursively');
  assert.equal(contract.resultSchema.policy.contentPolicy.forbiddenPatternFlags, 'i');
  assert.deepEqual(contract.resultSchema.policy.limits, AI_RESULT_LIMITS);
  assert.equal(contract.envelopePolicy.sourceReferenceUniqueness, 'sourceArtifactId');
  assert.throws(() => ((contract.requiredArtifactTypes as string[]).push('BAD')), /extensible|read only|object is not extensible/i);
  assert.throws(() => ((contract.resultSchema.policy.limits as { maxArtifacts: number }).maxArtifacts = 99), /read only|assign/i);

  const correction = getAiResultContract('CORRECTION')! as unknown as Record<string, unknown>;
  const { resultContractHash, ...contractIdentity } = correction;
  assert.equal(resultContractHash, canonicalSha256({ domain: 'ai.resultContract.v1', ...contractIdentity }));
  assert.notEqual(
    resultContractHash,
    canonicalSha256({
      domain: 'ai.resultContract.v1',
      ...contractIdentity,
      requiredArtifactTypes: [...(contractIdentity.requiredArtifactTypes as string[])].reverse(),
    }),
  );
});

test('all 13 jobs bind canonical capabilities and validate their synthetic drafts', () => {
  for (const jobCode of FAI_AUDIT_JOB_CODES) {
    const hashed = validateAndHashAiResultDraft(jobCode, createSyntheticAiResultDraft(jobCode), provenanceFor(jobCode));
    assert.match(hashed.resultHash, /^[0-9a-f]{64}$/);
    assert.equal(hashed.artifacts.length, getAiResultContract(jobCode)!.requiredArtifactTypes.length);
    for (const artifact of hashed.artifacts) assert.match(artifact.artifactSchemaHash, /^[0-9a-f]{64}$/);
  }
});

test('provenance is strict, binds canonical policy/capability/handler/executor, and hashes causal identity', () => {
  const draft = createSyntheticAiResultDraft('DOCUMENT_INGESTION');
  const base = validateAndHashAiResultDraft('DOCUMENT_INGESTION', draft, provenance);
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', draft, { ...provenance, extra: true }), /unrecognized/i);

  const mutableChanges: Partial<Record<keyof AiResultProvenance, unknown>> = {
    runtimeId: 'rt-2', jobId: 'job-2', attemptId: 'att-2', attemptSequence: 2, fencingToken: '43',
    workerInstanceId: 'worker-2', workerBuildHash: '7'.repeat(64), jobPayloadHash: '8'.repeat(64),
    workflowInstanceId: 'wf-2', workflowDefinitionHash: '9'.repeat(64), phaseCode: 'PHASE_2',
    phaseEntrySequence: 2, correctionCycle: 1, executorAgentId: 'agent-2',
  };
  for (const [key, value] of Object.entries(mutableChanges)) {
    const changed = { ...provenance, [key]: value };
    assert.notEqual(base.resultHash, validateAndHashAiResultDraft('DOCUMENT_INGESTION', draft, changed).resultHash, key);
  }

  const capability = getAiOrchestratorWorkerCapability('DOCUMENT_INGESTION')!;
  const canonicalMismatches = [
    { ...provenance, runtimePolicyHash: 'a'.repeat(64) },
    { ...provenance, capabilityCode: `${capability.capabilityCode}_OTHER` },
    { ...provenance, capabilityHash: 'b'.repeat(64) },
    { ...provenance, handlerCode: `${capability.handlerCode}_OTHER` },
    { ...provenance, executorAgentCode: `${capability.executorAgentCode}_other` },
    { ...provenance, executorAgentConfigHash: 'c'.repeat(64) },
  ];
  for (const mismatch of canonicalMismatches) assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', draft, mismatch), /MISMATCH/);
});

test('hashes are deterministic and literal golden vectors remain stable', () => {
  const a = validateAndHashAiResultDraft('DOCUMENT_INGESTION', createSyntheticAiResultDraft('DOCUMENT_INGESTION'), provenance);
  const b = validateAndHashAiResultDraft('DOCUMENT_INGESTION', createSyntheticAiResultDraft('DOCUMENT_INGESTION'), provenance);
  assert.equal(a.resultHash, b.resultHash);
  assert.equal(a.resultPayloadHash, 'b5f3ea898d7665f4526fed693de928dbd5d9acc3374494097613cf66c6893b76');
  assert.equal(a.artifacts[0].artifactSchemaHash, 'bf299a9b90f895ffc467a95824711498416a6d2693548cb8e71da6b7ab2cce94');
  assert.equal(a.artifacts[0].artifactHash, 'df149ab23456042b1e775f8d1673582b7e34f0be22bbe5affbc87ef6e5656810');
  assert.equal(a.manifestHash, 'ce22bc4926323ab240670532d639fa511ee421164a69d5dd772e2d40eae90f8f');
  assert.equal(a.resultContractHash, '66e22e704b466528b5126ac8cfb036ee149c243dd47552d2aa239f5cf246f7dc');
  assert.equal(a.resultHash, 'aa447290836ad6e56877d71274e9c4f670e66aac231a709a375d6543000d1e54');
  assert.equal(AI_RESULT_CONTRACT_CATALOG_HASH, 'ad847b572e7c7369249ecdfa63acbfaa8e699b705a9e8623b31d0315c122c9f2');
});

test('resultPayload is validated, hashed and compared with mono-artifact payload', () => {
  const draft = createSyntheticAiResultDraft('DOCUMENT_INGESTION');
  const changed = structuredClone(draft);
  changed.resultPayload = { synthetic: true, summary: 'different synthetic summary', documentCount: 1 };
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', changed, provenance), /PAYLOAD_ARTIFACT_MISMATCH/);
  const forbidden = structuredClone(draft);
  forbidden.resultPayload = { synthetic: true, summary: '<b>html<\/b>', documentCount: 1 };
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', forbidden, provenance), /FORBIDDEN|REDACTED/);
});

test('CORRECTION binds result hashes and manifest supersession hashes to exact source references', () => {
  const emptyCorrection = createSyntheticAiResultDraft('CORRECTION');
  validateAndHashAiResultDraft('CORRECTION', emptyCorrection, provenanceFor('CORRECTION'));

  const draft = createSyntheticAiResultDraft('CORRECTION');
  const superseded = sourceReference(0, 'SUPERSEDED');
  draft.artifacts[0].supersedesArtifactId = superseded.sourceArtifactId;
  draft.sourceReferences = [superseded];
  (draft.artifacts[1].payload as { supersededArtifactHashes: string[] }).supersededArtifactHashes = [superseded.sourceArtifactHash];
  refreshCorrectionResultPayload(draft);
  const hashed = validateAndHashAiResultDraft('CORRECTION', draft, provenanceFor('CORRECTION'));
  assert.equal((hashed.resultPayload as { correctedReportHash: string }).correctedReportHash, hashed.artifacts[0].artifactHash);
  assert.deepEqual((hashed.artifacts[1].payload as { supersededArtifactHashes: string[] }).supersededArtifactHashes, [superseded.sourceArtifactHash]);

  const wrongHash = structuredClone(draft);
  (wrongHash.artifacts[1].payload as { supersededArtifactHashes: string[] }).supersededArtifactHashes = ['f'.repeat(64)];
  refreshCorrectionResultPayload(wrongHash);
  assert.throws(() => validateAndHashAiResultDraft('CORRECTION', wrongHash, provenanceFor('CORRECTION')), /SUPERSESSION_MISMATCH/);

  const missingSource = structuredClone(draft);
  missingSource.sourceReferences = [{ ...superseded, sourceArtifactId: cuid(99) }];
  refreshCorrectionResultPayload(missingSource);
  assert.throws(() => validateAndHashAiResultDraft('CORRECTION', missingSource, provenanceFor('CORRECTION')), /SUPERSESSION_SOURCE_MISMATCH/);

  const wrongRole = structuredClone(draft);
  wrongRole.sourceReferences = [{ ...superseded, role: 'PRIMARY' }];
  refreshCorrectionResultPayload(wrongRole);
  assert.throws(() => validateAndHashAiResultDraft('CORRECTION', wrongRole, provenanceFor('CORRECTION')), /SUPERSESSION_SOURCE_MISMATCH/);

  const fakeResult = structuredClone(draft);
  (fakeResult.resultPayload as { correctedReportHash: string }).correctedReportHash = '0'.repeat(64);
  assert.throws(() => validateAndHashAiResultDraft('CORRECTION', fakeResult, provenanceFor('CORRECTION')), /CORRECTION_HASH_MISMATCH/);
});

test('artifact slots, logical keys, order, media type and supersession fail closed', () => {
  const badOrder = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); badOrder.artifacts[0].ordinal = 1;
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', badOrder, provenance), /ORDER/);
  const badSlot = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); badSlot.artifacts[0].slotCode = 'OTHER';
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', badSlot, provenance), /SLOT_INVALID/);
  const duplicateLogicalKey = createSyntheticAiResultDraft('CORRECTION'); duplicateLogicalKey.artifacts[1].logicalKey = duplicateLogicalKey.artifacts[0].logicalKey;
  assert.throws(() => validateAndHashAiResultDraft('CORRECTION', duplicateLogicalKey, provenanceFor('CORRECTION')), /LOGICAL_KEY_DUPLICATE/);
  const badMedia = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); badMedia.artifacts[0].mediaType = 'text/plain' as 'application/json';
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', badMedia, provenance));
  const forbiddenSupersession = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); forbiddenSupersession.artifacts[0].supersedesArtifactId = cuid(1);
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', forbiddenSupersession, provenance), /SUPERSESSION_NOT_ALLOWED/);
});

test('source references are closed-role, unique, ordinal and hash-order bound', () => {
  const draft = createSyntheticAiResultDraft('DOCUMENT_INGESTION');
  draft.sourceReferences = [sourceReference(0, 'PRIMARY'), sourceReference(1, 'SUPPORTING')];
  const first = validateAndHashAiResultDraft('DOCUMENT_INGESTION', draft, provenance);

  const reordered = structuredClone(draft);
  reordered.sourceReferences = [
    { ...draft.sourceReferences[1], ordinal: 0 },
    { ...draft.sourceReferences[0], ordinal: 1 },
  ];
  const second = validateAndHashAiResultDraft('DOCUMENT_INGESTION', reordered, provenance);
  assert.notEqual(first.manifestHash, second.manifestHash);
  assert.notEqual(first.resultHash, second.resultHash);

  const outOfOrder = structuredClone(draft);
  outOfOrder.sourceReferences = [draft.sourceReferences[1], draft.sourceReferences[0]];
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', outOfOrder, provenance), /SOURCE_ORDER/);

  const duplicate = structuredClone(draft);
  duplicate.sourceReferences[1] = { ...duplicate.sourceReferences[1], sourceArtifactId: duplicate.sourceReferences[0].sourceArtifactId };
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', duplicate, provenance), /SOURCE_DUPLICATE/);

  const openRole = structuredClone(draft);
  openRole.sourceReferences[0].role = 'ARBITRARY' as 'PRIMARY';
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', openRole, provenance));
});

test('byte boundaries are real at -1, exact and +1 for artifact and result limits', () => {
  for (const limit of [AI_RESULT_LIMITS.maxArtifactBytes, AI_RESULT_LIMITS.maxResultBytes]) {
    const below = validateAiResultJsonValue(stringArrayAtCanonicalBytes(limit - 1), limit);
    const exact = validateAiResultJsonValue(stringArrayAtCanonicalBytes(limit), limit);
    assert.equal(below.bytes, limit - 1);
    assert.equal(exact.bytes, limit);
    assert.throws(() => validateAiResultJsonValue(stringArrayAtCanonicalBytes(limit + 1), limit), /BYTES_TOO_LARGE/);
  }
});

test('depth, node and string boundaries are real at -1, exact and +1', () => {
  assert.equal(validateAiResultJsonValue(nestedJsonAtDepth(AI_RESULT_LIMITS.maxJsonDepth - 1), AI_RESULT_LIMITS.maxResultBytes).maxDepth, AI_RESULT_LIMITS.maxJsonDepth - 1);
  assert.equal(validateAiResultJsonValue(nestedJsonAtDepth(AI_RESULT_LIMITS.maxJsonDepth), AI_RESULT_LIMITS.maxResultBytes).maxDepth, AI_RESULT_LIMITS.maxJsonDepth);
  assert.throws(() => validateAiResultJsonValue(nestedJsonAtDepth(AI_RESULT_LIMITS.maxJsonDepth + 1), AI_RESULT_LIMITS.maxResultBytes), /JSON_TOO_DEEP/);

  assert.equal(validateAiResultJsonValue(Array(AI_RESULT_LIMITS.maxJsonNodes - 2).fill(null), AI_RESULT_LIMITS.maxResultBytes).nodes, AI_RESULT_LIMITS.maxJsonNodes - 1);
  assert.equal(validateAiResultJsonValue(Array(AI_RESULT_LIMITS.maxJsonNodes - 1).fill(null), AI_RESULT_LIMITS.maxResultBytes).nodes, AI_RESULT_LIMITS.maxJsonNodes);
  assert.throws(() => validateAiResultJsonValue(Array(AI_RESULT_LIMITS.maxJsonNodes).fill(null), AI_RESULT_LIMITS.maxResultBytes), /JSON_TOO_LARGE/);

  validateAiResultJsonValue('x'.repeat(AI_RESULT_LIMITS.maxStringBytes - 1), AI_RESULT_LIMITS.maxResultBytes);
  validateAiResultJsonValue('x'.repeat(AI_RESULT_LIMITS.maxStringBytes), AI_RESULT_LIMITS.maxResultBytes);
  assert.throws(() => validateAiResultJsonValue('x'.repeat(AI_RESULT_LIMITS.maxStringBytes + 1), AI_RESULT_LIMITS.maxResultBytes), /STRING_TOO_LARGE/);
});

test('artifact and source cardinality boundaries reject both underflow and overflow', () => {
  const correction = createSyntheticAiResultDraft('CORRECTION');
  validateAndHashAiResultDraft('CORRECTION', correction, provenanceFor('CORRECTION'));
  const artifactUnderflow = structuredClone(correction); artifactUnderflow.artifacts.pop();
  assert.throws(() => validateAndHashAiResultDraft('CORRECTION', artifactUnderflow, provenanceFor('CORRECTION')), /CARDINALITY/);
  const artifactOverflow = structuredClone(correction); artifactOverflow.artifacts.push({ ...artifactOverflow.artifacts[0], ordinal: 2, logicalKey: 'synthetic.extra' });
  assert.throws(() => validateAndHashAiResultDraft('CORRECTION', artifactOverflow, provenanceFor('CORRECTION')), /CARDINALITY/);

  for (const count of [AI_RESULT_LIMITS.maxSourceReferences - 1, AI_RESULT_LIMITS.maxSourceReferences]) {
    const draft = createSyntheticAiResultDraft('DOCUMENT_INGESTION');
    draft.sourceReferences = Array.from({ length: count }, (_, index) => sourceReference(index, index === 0 ? 'PRIMARY' : 'SUPPORTING'));
    assert.equal(validateAndHashAiResultDraft('DOCUMENT_INGESTION', draft, provenance).sourceReferences.length, count);
  }
  const sourceOverflow = createSyntheticAiResultDraft('DOCUMENT_INGESTION');
  sourceOverflow.sourceReferences = Array.from({ length: AI_RESULT_LIMITS.maxSourceReferences + 1 }, (_, index) => sourceReference(index));
  assert.throws(() => validateAndHashAiResultDraft('DOCUMENT_INGESTION', sourceOverflow, provenance));
});

test('redacted forbidden content is enforced before persistence', () => {
  const html = createSyntheticAiResultDraft('DOCUMENT_INGESTION'); (html.artifacts[0].payload as { summary: string }).summary = '<b>html<\/b>';
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
