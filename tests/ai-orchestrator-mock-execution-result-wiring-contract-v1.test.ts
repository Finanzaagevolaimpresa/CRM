import assert from 'node:assert/strict';
import test from 'node:test';
import { FAI_AUDIT_JOB_CODES } from '../src/lib/ai-orchestrator/job-catalog-v1';
import { listAiOrchestratorMockHandlerDefinitions } from '../src/lib/ai-orchestrator/mock-handler-registry-v1';
import { listAiResultContracts } from '../src/lib/ai-orchestrator/result-artifact-contract-v1';
import { AI_MOCK_EXECUTION_RESULT_WIRING_HASH, AI_MOCK_EXECUTION_RESULT_WIRING_KEY, AI_MOCK_EXECUTION_RESULT_WIRING_MANIFEST, createAiMockExecutionResultWiringHashV1 } from '../src/lib/ai-orchestrator/mock-execution-result-wiring-contract-v1';

test('PR83 manifest is canonical, locked, and covers 13/13 jobs', () => {
  assert.equal(AI_MOCK_EXECUTION_RESULT_WIRING_KEY, 'FAI-AI-ORCHESTRATOR-MOCK-EXECUTION-RESULT-WIRING@1.0');
  assert.equal(AI_MOCK_EXECUTION_RESULT_WIRING_MANIFEST.operational, false);
  assert.deepEqual(AI_MOCK_EXECUTION_RESULT_WIRING_MANIFEST.productionComposition, { canAcceptLease: false, consumer: 'NONE' });
  assert.equal(AI_MOCK_EXECUTION_RESULT_WIRING_MANIFEST.authority.adminAuthorityAtomicWithCompletion, false);
  assert.equal(AI_MOCK_EXECUTION_RESULT_WIRING_HASH, createAiMockExecutionResultWiringHashV1());
  assert.match(AI_MOCK_EXECUTION_RESULT_WIRING_HASH, /^[0-9a-f]{64}$/);
  assert.equal(FAI_AUDIT_JOB_CODES.length, 13);
  assert.equal(listAiOrchestratorMockHandlerDefinitions().length, 13);
  assert.equal(listAiResultContracts().length, 13);
  assert.ok(Object.values(AI_MOCK_EXECUTION_RESULT_WIRING_MANIFEST.sideEffects).every((value) => value === false));
});
