import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createAiOrchestratorWorkerProductionProcessV1,
  mapAiOrchestratorWorkerAuthorityDecisionV1,
  type LoadAiOrchestratorWorkerRuntimeAdapterV1,
} from '../src/lib/ai-orchestrator/worker-admission-claim-lease-process-v1';
import type {
  AiOrchestratorWorkerControlPlaneAuthorityV1,
} from '../src/lib/ai-orchestrator/worker-control-plane-authority-v1';

const foundationAuthority = Object.freeze({
  schemaVersion: 1,
  authorityVersion: '1.0',
  activationEpoch: 'FOUNDATION_LOCKED_V1',
  operational: false,
  databaseEligible: false,
  canAdmit: false,
  canClaim: false,
  canHeartbeat: false,
  ledger: Object.freeze({
    valid: true,
    targetCount: 36,
    revisionCount: 36,
  }),
  gates: Object.freeze({
    valid: true,
    stateMachineEnabled: false,
    dispatchEnabled: false,
    syntheticDataOnly: true,
    providerIsMock: true,
    externalProvidersDisabled: true,
    capabilitySettingCount: 13,
    canonicalCapabilityCount: 13,
    enabledCapabilityCount: 0,
    physicalDispatchBarrierPresent: true,
  }),
  blockReasons: Object.freeze(['FOUNDATION_LOCKED_V1'] as const),
} as const satisfies AiOrchestratorWorkerControlPlaneAuthorityV1);

test('authority production mappa integrità e foundation lock con decisioni chiuse', () => {
  assert.deepEqual(
    mapAiOrchestratorWorkerAuthorityDecisionV1(foundationAuthority),
    { allowed: false, code: 'FOUNDATION_LOCKED' },
  );

  const invalid = {
    ...foundationAuthority,
    ledger: Object.freeze({
      valid: false,
      targetCount: 35,
      revisionCount: 35,
    }),
    blockReasons: Object.freeze([
      'FOUNDATION_LOCKED_V1',
      'LEDGER_INTEGRITY_ERROR',
    ] as const),
  } satisfies AiOrchestratorWorkerControlPlaneAuthorityV1;
  assert.deepEqual(
    mapAiOrchestratorWorkerAuthorityDecisionV1(invalid),
    { allowed: false, code: 'AUTHORITY_UNAVAILABLE' },
  );
});

test('configurazione invalida viene respinta prima di caricare il runtime DB', () => {
  let loadCount = 0;
  const loadRuntimeAdapter: LoadAiOrchestratorWorkerRuntimeAdapterV1 = async () => {
    loadCount += 1;
    throw new Error('must not load');
  };
  assert.throws(
    () => createAiOrchestratorWorkerProductionProcessV1({
      environment: {
        workerEnabled: '1',
        provider: 'openai',
        externalProvidersEnabled: 'false',
        allowedModels: '',
      },
      loadRuntimeAdapter,
    }),
    (error: unknown) => (
      error instanceof Error
      && error.message === 'AI_WORKER_WIRING_PROVIDER_NOT_MOCK'
    ),
  );
  assert.equal(loadCount, 0);
});

test('composizione production legge authority e non esegue alcun mutatore', async () => {
  const calls: string[] = [];
  let worker: ReturnType<typeof createAiOrchestratorWorkerProductionProcessV1>;
  const capturedIdentities: Array<Readonly<{
    workerInstanceId: string;
    workerBuildHash: string;
    workerEnabled?: string;
  }>> = [];

  const loadRuntimeAdapter: LoadAiOrchestratorWorkerRuntimeAdapterV1 = async (identity) => {
    capturedIdentities.push(identity);
    return Object.freeze({
      adapterVersion: '1.0',
      readAuthority: async () => {
        calls.push('authority');
        queueMicrotask(() => worker.requestShutdown());
        return foundationAuthority;
      },
      recover: async () => {
        calls.push('recover');
        return Object.freeze({ recovered: 0 });
      },
      supersede: async () => {
        calls.push('supersede');
        return Object.freeze({ superseded: 0 });
      },
      admit: async () => {
        calls.push('admit');
        return Object.freeze({ admitted: 0 });
      },
      claim: async () => {
        calls.push('claim');
        return null;
      },
      heartbeat: async () => {
        calls.push('heartbeat');
      },
      surrender: async () => {
        calls.push('surrender');
      },
      disconnect: async () => {
        calls.push('disconnect');
      },
    });
  };

  worker = createAiOrchestratorWorkerProductionProcessV1({
    environment: {
      workerEnabled: '1',
      provider: 'mock',
      externalProvidersEnabled: 'false',
      allowedModels: '',
    },
    loadRuntimeAdapter,
  });
  const stopped = await worker.start();

  assert.deepEqual(calls, ['authority', 'disconnect']);
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.activeLease, false);
  assert.equal(capturedIdentities.length, 1);
  const capturedIdentity = capturedIdentities[0];
  assert.ok(capturedIdentity);
  assert.equal(capturedIdentity.workerInstanceId, worker.workerInstanceId);
  assert.equal(capturedIdentity.workerBuildHash, worker.workerBuildHash);
  assert.equal(capturedIdentity.workerEnabled, '1');
});

test('process composition scarta payload e superfici terminali o di rete', () => {
  const source = readFileSync(
    'src/lib/ai-orchestrator/worker-admission-claim-lease-process-v1.ts',
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /completeAiWorkflowJob|failAiWorkflowJob|mock-handler-registry|result-artifact-contract/,
  );
  assert.doesNotMatch(source, /\b(?:payload|handlerInput|resultArtifact)\b/);
  assert.doesNotMatch(
    source,
    /\bfetch\s*\(|\bWebSocket\b|\bOpenAI\b|\baxios\b|\bundici\b/,
  );
  assert.doesNotMatch(
    source,
    /from\s+['"](?:node:)?(?:http|https|net|dns|tls|dgram)['"]/,
  );
});

test('smoke gate 1 richiede lifecycle vivo, SIGTERM pulito e snapshot invariato', () => {
  const smoke = readFileSync('scripts/smoke-docker-prod.sh', 'utf8');
  assert.match(smoke, /seq 1 75/);
  assert.match(smoke, /Gate 1 worker exited before completing/);
  assert.match(smoke, /docker kill --signal=TERM "\$LOCKED_WORKER_CONTAINER"/);
  assert.match(smoke, /\[\[ "\$LOCKED_EXIT" == "0" \]\]/);
  assert.match(smoke, /LOCKED_SNAPSHOT_BEFORE/);
  assert.match(smoke, /LOCKED_SNAPSHOT_AFTER/);
  assert.doesNotMatch(smoke, /0\|1/);
  assert.doesNotMatch(smoke, /Gate 1 worker output is not canonical JSONL/);
});
