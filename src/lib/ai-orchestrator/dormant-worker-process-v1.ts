import { randomUUID } from 'node:crypto';
import { setTimeout as abortableTimeout } from 'node:timers/promises';
import { canonicalSha256 } from '../canonical-json';

export const AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_CODE =
  'FAI-AI-ORCHESTRATOR-DORMANT-WORKER' as const;
export const AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_VERSION = '1.0' as const;
export const AI_ORCHESTRATOR_DORMANT_WORKER_ACTIVATION_EPOCH =
  'FOUNDATION_LOCKED_V1' as const;
export const AI_ORCHESTRATOR_DORMANT_WORKER_POLL_RESULT =
  'NO_WORK_FOUNDATION_LOCKED' as const;

export const AI_ORCHESTRATOR_DORMANT_WORKER_STATES = Object.freeze([
  'DORMANT',
  'DRAINING',
  'STOPPED',
] as const);

export type AiOrchestratorDormantWorkerState =
  typeof AI_ORCHESTRATOR_DORMANT_WORKER_STATES[number];

export const AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS = Object.freeze({
  pollBaseIntervalMs: 5_000,
  pollJitterBasisPoints: 2_000,
  heartbeatIntervalMs: 30_000,
} as const);

const HEARTBEAT_FIELDS = Object.freeze([
  'schemaVersion',
  'workerProcessVersion',
  'workerInstanceId',
  'workerBuildHash',
  'state',
  'sequence',
  'timestamp',
] as const);

export const AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST = Object.freeze({
  schemaVersion: 1,
  processCode: AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_CODE,
  processVersion: AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_VERSION,
  activationEpoch: AI_ORCHESTRATOR_DORMANT_WORKER_ACTIVATION_EPOCH,
  operational: false,
  lifecycle: AI_ORCHESTRATOR_DORMANT_WORKER_STATES,
  authority: Object.freeze({
    databaseAccessAllowed: false,
    jobAccessAllowed: false,
    crmDataAccessAllowed: false,
    networkAccessAllowed: false,
    providerCallAllowed: false,
    workflowTransitionWriteAllowed: false,
  }),
  executionBoundary: Object.freeze({
    provider: 'mock',
    dataMode: 'synthetic',
    activationAllowed: false,
  }),
  polling: Object.freeze({
    baseIntervalMs: AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS.pollBaseIntervalMs,
    jitterBasisPoints: AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS.pollJitterBasisPoints,
    outcome: AI_ORCHESTRATOR_DORMANT_WORKER_POLL_RESULT,
    dataSource: 'NONE',
  }),
  heartbeat: Object.freeze({
    intervalMs: AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS.heartbeatIntervalMs,
    format: 'JSONL',
    fields: HEARTBEAT_FIELDS,
  }),
} as const);

export function createAiOrchestratorDormantWorkerBuildHashV1() {
  return canonicalSha256({
    domain: 'ai.dormantWorkerProcessManifest.v1',
    manifest: AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST,
  });
}

export const AI_ORCHESTRATOR_DORMANT_WORKER_BUILD_HASH =
  createAiOrchestratorDormantWorkerBuildHashV1();

export const AI_ORCHESTRATOR_DORMANT_WORKER_ERROR_CODES = Object.freeze([
  'AI_DORMANT_WORKER_GATE_INVALID',
  'AI_DORMANT_WORKER_FOUNDATION_LOCKED',
  'AI_DORMANT_WORKER_PROVIDER_NOT_MOCK',
  'AI_DORMANT_WORKER_EXTERNAL_PROVIDERS_NOT_DISABLED',
  'AI_DORMANT_WORKER_MODEL_ALLOWLIST_NOT_EMPTY',
  'AI_DORMANT_WORKER_CLOCK_INVALID',
  'AI_DORMANT_WORKER_SEQUENCE_INVALID',
  'AI_DORMANT_WORKER_STDOUT_FAILURE',
  'AI_DORMANT_WORKER_TIMER_FAILURE',
  'AI_DORMANT_WORKER_PROCESS_FAILURE',
] as const);

export type AiOrchestratorDormantWorkerErrorCode =
  typeof AI_ORCHESTRATOR_DORMANT_WORKER_ERROR_CODES[number];

export class AiOrchestratorDormantWorkerProcessError extends Error {
  readonly code: AiOrchestratorDormantWorkerErrorCode;

  constructor(code: AiOrchestratorDormantWorkerErrorCode) {
    super(code);
    this.name = 'AiOrchestratorDormantWorkerProcessError';
    this.code = code;
  }
}

export interface AiOrchestratorDormantWorkerEnvironmentInput {
  readonly workerEnabled?: string;
  readonly provider?: string;
  readonly externalProvidersEnabled?: string;
  readonly allowedModels?: string;
}

export interface AiOrchestratorDormantWorkerEnvironment {
  readonly activationEpoch: typeof AI_ORCHESTRATOR_DORMANT_WORKER_ACTIVATION_EPOCH;
  readonly workerEnabled: false;
  readonly provider: 'mock';
  readonly dataMode: 'synthetic';
  readonly externalProvidersEnabled: false;
  readonly allowedModels: readonly [];
}

function fail(code: AiOrchestratorDormantWorkerErrorCode): never {
  throw new AiOrchestratorDormantWorkerProcessError(code);
}

export function parseAiOrchestratorDormantWorkerEnvironmentV1(
  input: AiOrchestratorDormantWorkerEnvironmentInput,
): Readonly<AiOrchestratorDormantWorkerEnvironment> {
  if (input.workerEnabled === '1') fail('AI_DORMANT_WORKER_FOUNDATION_LOCKED');
  if (input.workerEnabled !== undefined && input.workerEnabled !== '0') {
    fail('AI_DORMANT_WORKER_GATE_INVALID');
  }
  if ((input.provider ?? 'mock') !== 'mock') fail('AI_DORMANT_WORKER_PROVIDER_NOT_MOCK');
  if ((input.externalProvidersEnabled ?? 'false') !== 'false') {
    fail('AI_DORMANT_WORKER_EXTERNAL_PROVIDERS_NOT_DISABLED');
  }
  if ((input.allowedModels ?? '') !== '') fail('AI_DORMANT_WORKER_MODEL_ALLOWLIST_NOT_EMPTY');

  return Object.freeze({
    activationEpoch: AI_ORCHESTRATOR_DORMANT_WORKER_ACTIVATION_EPOCH,
    workerEnabled: false,
    provider: 'mock',
    dataMode: 'synthetic',
    externalProvidersEnabled: false,
    allowedModels: Object.freeze([] as const),
  });
}

function assertSafeSequence(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) fail('AI_DORMANT_WORKER_SEQUENCE_INVALID');
  return value;
}

function assertSafeTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    fail('AI_DORMANT_WORKER_CLOCK_INVALID');
  }
  return value;
}

function safeDeadline(nowMs: number, delayMs: number) {
  const deadline = assertSafeTimestamp(nowMs) + delayMs;
  return assertSafeTimestamp(deadline);
}

export function calculateAiOrchestratorDormantWorkerPollDelayMsV1(input: {
  readonly workerInstanceId: string;
  readonly pollSequence: number;
}) {
  const pollSequence = assertSafeSequence(input.pollSequence);
  const maxJitterMs = Math.floor(
    AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS.pollBaseIntervalMs
      * AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS.pollJitterBasisPoints
      / 10_000,
  );
  const entropy = canonicalSha256({
    domain: 'ai.dormantWorkerPollJitter.v1',
    workerBuildHash: AI_ORCHESTRATOR_DORMANT_WORKER_BUILD_HASH,
    workerInstanceId: input.workerInstanceId,
    pollSequence,
  });
  const sample = Number.parseInt(entropy.slice(0, 8), 16);
  return AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS.pollBaseIntervalMs
    + (sample % (maxJitterMs + 1));
}

export interface AiOrchestratorDormantWorkerHeartbeatV1 {
  readonly schemaVersion: 1;
  readonly workerProcessVersion: typeof AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_VERSION;
  readonly workerInstanceId: string;
  readonly workerBuildHash: string;
  readonly state: 'DORMANT';
  readonly sequence: number;
  readonly timestamp: string;
}

export function createAiOrchestratorDormantWorkerHeartbeatV1(input: {
  readonly workerInstanceId: string;
  readonly sequence: number;
  readonly nowMs: number;
}): Readonly<AiOrchestratorDormantWorkerHeartbeatV1> {
  const nowMs = assertSafeTimestamp(input.nowMs);
  return Object.freeze({
    schemaVersion: 1,
    workerProcessVersion: AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_VERSION,
    workerInstanceId: input.workerInstanceId,
    workerBuildHash: AI_ORCHESTRATOR_DORMANT_WORKER_BUILD_HASH,
    state: 'DORMANT',
    sequence: assertSafeSequence(input.sequence),
    timestamp: new Date(nowMs).toISOString(),
  });
}

export interface AiOrchestratorDormantWorkerSnapshotV1 {
  readonly workerInstanceId: string;
  readonly workerBuildHash: string;
  readonly state: AiOrchestratorDormantWorkerState;
  readonly heartbeatSequence: number;
  readonly pollSequence: number;
  readonly lastPollResult: typeof AI_ORCHESTRATOR_DORMANT_WORKER_POLL_RESULT | null;
  readonly timerPending: boolean;
}

export interface AiOrchestratorDormantWorkerProcessV1 {
  readonly workerInstanceId: string;
  readonly workerBuildHash: string;
  getSnapshot(): Readonly<AiOrchestratorDormantWorkerSnapshotV1>;
  start(): Promise<Readonly<AiOrchestratorDormantWorkerSnapshotV1>>;
  requestShutdown(): boolean;
}

export interface AiOrchestratorDormantWorkerProcessAdaptersV1 {
  readonly nowMs?: () => number;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly writeJsonLine: (line: string, signal: AbortSignal) => void | Promise<void>;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function createAbortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeProcessError(error: unknown) {
  if (error instanceof AiOrchestratorDormantWorkerProcessError) return error;
  return new AiOrchestratorDormantWorkerProcessError('AI_DORMANT_WORKER_PROCESS_FAILURE');
}

class DormantWorkerProcessV1 implements AiOrchestratorDormantWorkerProcessV1 {
  readonly workerInstanceId = randomUUID();
  readonly workerBuildHash = AI_ORCHESTRATOR_DORMANT_WORKER_BUILD_HASH;

  #state: AiOrchestratorDormantWorkerState = 'DORMANT';
  #heartbeatSequence = 0;
  #pollSequence = 0;
  #lastPollResult: typeof AI_ORCHESTRATOR_DORMANT_WORKER_POLL_RESULT | null = null;
  #timerPending = false;
  #abortController = new AbortController();
  #completion: Promise<Readonly<AiOrchestratorDormantWorkerSnapshotV1>> | null = null;
  readonly #nowMs: () => number;
  readonly #wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly #writeJsonLine: (line: string, signal: AbortSignal) => void | Promise<void>;

  constructor(adapters: AiOrchestratorDormantWorkerProcessAdaptersV1) {
    this.#nowMs = adapters.nowMs ?? Date.now;
    this.#wait = adapters.wait ?? (async (delayMs, signal) => {
      await abortableTimeout(delayMs, undefined, { signal });
    });
    this.#writeJsonLine = adapters.writeJsonLine;
  }

  getSnapshot() {
    return Object.freeze({
      workerInstanceId: this.workerInstanceId,
      workerBuildHash: this.workerBuildHash,
      state: this.#state,
      heartbeatSequence: this.#heartbeatSequence,
      pollSequence: this.#pollSequence,
      lastPollResult: this.#lastPollResult,
      timerPending: this.#timerPending,
    });
  }

  start() {
    this.#completion ??= this.#run();
    return this.#completion;
  }

  requestShutdown() {
    if (this.#state !== 'DORMANT') return false;
    this.#state = 'DRAINING';
    this.#abortController.abort();
    return true;
  }

  async #emitHeartbeat() {
    if (this.#state !== 'DORMANT') return;
    this.#heartbeatSequence = assertSafeSequence(this.#heartbeatSequence + 1);
    const heartbeat = createAiOrchestratorDormantWorkerHeartbeatV1({
      workerInstanceId: this.workerInstanceId,
      sequence: this.#heartbeatSequence,
      nowMs: this.#nowMs(),
    });
    const signal = this.#abortController.signal;
    let removeAbortListener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolveAbort, rejectAbort) => {
      const onAbort = () => rejectAbort(createAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    });
    const write = Promise.resolve().then(() => (
      this.#writeJsonLine(`${JSON.stringify(heartbeat)}\n`, signal)
    ));
    try {
      await Promise.race([write, aborted]);
    } catch {
      if (this.#state !== 'DORMANT' && signal.aborted) return;
      throw new AiOrchestratorDormantWorkerProcessError('AI_DORMANT_WORKER_STDOUT_FAILURE');
    } finally {
      removeAbortListener();
    }
  }

  #pollFoundationLock() {
    this.#pollSequence = assertSafeSequence(this.#pollSequence + 1);
    this.#lastPollResult = AI_ORCHESTRATOR_DORMANT_WORKER_POLL_RESULT;
  }

  async #waitOnce(delayMs: number) {
    this.#timerPending = true;
    try {
      await this.#wait(delayMs, this.#abortController.signal);
    } catch (error) {
      if (this.#state !== 'DORMANT' && this.#abortController.signal.aborted && isAbortError(error)) {
        return;
      }
      throw new AiOrchestratorDormantWorkerProcessError('AI_DORMANT_WORKER_TIMER_FAILURE');
    } finally {
      this.#timerPending = false;
    }
  }

  async #run() {
    let terminalError: AiOrchestratorDormantWorkerProcessError | null = null;
    try {
      if (this.#state === 'DORMANT') await this.#emitHeartbeat();
      const initialNow = assertSafeTimestamp(this.#nowMs());
      let nextHeartbeatAt = safeDeadline(
        initialNow,
        AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS.heartbeatIntervalMs,
      );
      let nextPollAt = safeDeadline(
        initialNow,
        calculateAiOrchestratorDormantWorkerPollDelayMsV1({
          workerInstanceId: this.workerInstanceId,
          pollSequence: 1,
        }),
      );

      while (this.#state === 'DORMANT') {
        const now = assertSafeTimestamp(this.#nowMs());
        if (now >= nextHeartbeatAt) {
          await this.#emitHeartbeat();
          if (this.#state !== 'DORMANT') break;
          nextHeartbeatAt = safeDeadline(
            assertSafeTimestamp(this.#nowMs()),
            AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS.heartbeatIntervalMs,
          );
        }
        if (now >= nextPollAt) {
          this.#pollFoundationLock();
          nextPollAt = safeDeadline(
            assertSafeTimestamp(this.#nowMs()),
            calculateAiOrchestratorDormantWorkerPollDelayMsV1({
              workerInstanceId: this.workerInstanceId,
              pollSequence: this.#pollSequence + 1,
            }),
          );
        }
        if (this.#state !== 'DORMANT') break;
        const beforeWait = assertSafeTimestamp(this.#nowMs());
        await this.#waitOnce(Math.max(0, Math.min(nextHeartbeatAt, nextPollAt) - beforeWait));
      }
    } catch (error) {
      terminalError = normalizeProcessError(error);
      this.requestShutdown();
    } finally {
      this.#abortController.abort();
      this.#timerPending = false;
      this.#state = 'STOPPED';
    }

    if (terminalError) throw terminalError;
    return this.getSnapshot();
  }
}

export function createAiOrchestratorDormantWorkerProcessV1(input: {
  readonly environment: AiOrchestratorDormantWorkerEnvironmentInput;
  readonly adapters: AiOrchestratorDormantWorkerProcessAdaptersV1;
}): AiOrchestratorDormantWorkerProcessV1 {
  parseAiOrchestratorDormantWorkerEnvironmentV1(input.environment);
  return new DormantWorkerProcessV1(input.adapters);
}

export function getAiOrchestratorDormantWorkerProcessInvariantErrorsV1() {
  const errors: string[] = [];
  const manifest = AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST;
  if (manifest.activationEpoch !== 'FOUNDATION_LOCKED_V1') errors.push('Activation epoch non bloccata.');
  if (manifest.operational !== false || manifest.executionBoundary.activationAllowed !== false) {
    errors.push('Il processo dormiente dichiara autorità operativa.');
  }
  if (JSON.stringify(manifest.lifecycle) !== JSON.stringify(['DORMANT', 'DRAINING', 'STOPPED'])) {
    errors.push('Lifecycle non canonico.');
  }
  if (Object.values(manifest.authority).some((allowed) => allowed !== false)) {
    errors.push('Una authority vietata risulta abilitata.');
  }
  if (manifest.executionBoundary.provider !== 'mock'
    || manifest.executionBoundary.dataMode !== 'synthetic') {
    errors.push('Boundary non mock/synthetic.');
  }
  if (manifest.polling.outcome !== 'NO_WORK_FOUNDATION_LOCKED'
    || manifest.polling.dataSource !== 'NONE') {
    errors.push('Polling non sigillato.');
  }
  if (JSON.stringify(manifest.heartbeat.fields) !== JSON.stringify(HEARTBEAT_FIELDS)) {
    errors.push('Campi heartbeat non canonici.');
  }
  if (!/^[0-9a-f]{64}$/.test(AI_ORCHESTRATOR_DORMANT_WORKER_BUILD_HASH)) {
    errors.push('Build manifest hash non valido.');
  }
  return errors;
}
