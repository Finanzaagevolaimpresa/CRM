import { randomUUID } from 'node:crypto';
import { setTimeout as abortableTimeout } from 'node:timers/promises';
import { canonicalSha256 } from '../canonical-json';

export const AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_CODE =
  'FAI-AI-ORCHESTRATOR-WORKER-ADMISSION-CLAIM-LEASE' as const;
export const AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_VERSION = '1.0' as const;
export const AI_ORCHESTRATOR_WORKER_WIRING_ACTIVATION_EPOCH =
  'FOUNDATION_LOCKED_V1' as const;
export const AI_ORCHESTRATOR_WORKER_WIRING_PRODUCTION_CAN_ACCEPT_LEASE = false as const;

export const AI_ORCHESTRATOR_WORKER_WIRING_STATES = Object.freeze([
  'STARTING',
  'IDLE',
  'CHECKING_AUTHORITY',
  'RECOVERING',
  'SUPERSEDING',
  'ADMITTING',
  'CLAIMING',
  'LEASED',
  'DRAINING',
  'STOPPED',
] as const);

export type AiOrchestratorWorkerWiringState =
  typeof AI_ORCHESTRATOR_WORKER_WIRING_STATES[number];

export const AI_ORCHESTRATOR_WORKER_WIRING_LIMITS = Object.freeze({
  pollIntervalMs: 5_000,
  heartbeatIntervalMs: 30_000,
} as const);

const IMPLEMENTED_OPERATIONS = Object.freeze([
  'READ_AUTHORITY',
  'RECOVER',
  'SUPERSEDE',
  'ADMIT',
  'CLAIM',
  'HEARTBEAT',
  'SURRENDER',
  'DISCONNECT',
] as const);

export const AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST = Object.freeze({
  schemaVersion: 1,
  processCode: AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_CODE,
  processVersion: AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_VERSION,
  activationEpoch: AI_ORCHESTRATOR_WORKER_WIRING_ACTIVATION_EPOCH,
  operational: false,
  lifecycle: AI_ORCHESTRATOR_WORKER_WIRING_STATES,
  implementedOperations: IMPLEMENTED_OPERATIONS,
  productionComposition: Object.freeze({
    canAcceptLease: AI_ORCHESTRATOR_WORKER_WIRING_PRODUCTION_CAN_ACCEPT_LEASE,
    leaseConsumer: 'NONE',
  }),
  authority: Object.freeze({
    defaultDecision: 'DENY',
    authorityCheckRequired: true,
    authorityCheckScope: 'ALL_DATABASE_OPERATIONS',
    authorityRecheckBeforeEachMutator: true,
    riskReductionOperations: Object.freeze(['SURRENDER'] as const),
    payloadAccessAllowed: false,
    crmDataAccessAllowed: false,
    networkAccessAllowed: false,
    providerCallAllowed: false,
    terminalMutationAllowed: false,
    workflowTransitionWriteAllowed: false,
  }),
  scheduling: Object.freeze({
    pollIntervalMs: AI_ORCHESTRATOR_WORKER_WIRING_LIMITS.pollIntervalMs,
    heartbeatIntervalMs: AI_ORCHESTRATOR_WORKER_WIRING_LIMITS.heartbeatIntervalMs,
    overlappingOperationsAllowed: false,
  }),
} as const);

export function createAiOrchestratorWorkerWiringBuildHashV1() {
  return canonicalSha256({
    domain: 'ai.workerAdmissionClaimLeaseWiringManifest.v1',
    manifest: AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST,
  });
}

export const AI_ORCHESTRATOR_WORKER_WIRING_BUILD_HASH =
  createAiOrchestratorWorkerWiringBuildHashV1();

export const AI_ORCHESTRATOR_WORKER_WIRING_ERROR_CODES = Object.freeze([
  'AI_WORKER_WIRING_GATE_INVALID',
  'AI_WORKER_WIRING_PROVIDER_NOT_MOCK',
  'AI_WORKER_WIRING_EXTERNAL_PROVIDERS_NOT_DISABLED',
  'AI_WORKER_WIRING_MODEL_ALLOWLIST_NOT_EMPTY',
  'AI_WORKER_WIRING_IDENTITY_INVALID',
  'AI_WORKER_WIRING_SEQUENCE_INVALID',
  'AI_WORKER_WIRING_TIMER_FAILURE',
  'AI_WORKER_WIRING_ADAPTER_FAILURE',
  'AI_WORKER_WIRING_DB_TRANSIENT_EXHAUSTED',
  'AI_WORKER_WIRING_DB_UNAVAILABLE',
  'AI_WORKER_WIRING_INVARIANT_VIOLATION',
  'AI_WORKER_WIRING_PROCESS_FAILURE',
] as const);

export type AiOrchestratorWorkerWiringErrorCode =
  typeof AI_ORCHESTRATOR_WORKER_WIRING_ERROR_CODES[number];

export class AiOrchestratorWorkerWiringError extends Error {
  readonly code: AiOrchestratorWorkerWiringErrorCode;

  constructor(code: AiOrchestratorWorkerWiringErrorCode) {
    super(code);
    this.name = 'AiOrchestratorWorkerWiringError';
    this.code = code;
  }
}

export interface AiOrchestratorWorkerWiringEnvironmentInput {
  readonly workerEnabled?: string;
  readonly provider?: string;
  readonly externalProvidersEnabled?: string;
  readonly allowedModels?: string;
}

export interface AiOrchestratorWorkerWiringEnvironment {
  readonly activationEpoch: typeof AI_ORCHESTRATOR_WORKER_WIRING_ACTIVATION_EPOCH;
  readonly workerEnabled: true;
  readonly provider: 'mock';
  readonly dataMode: 'synthetic';
  readonly externalProvidersEnabled: false;
  readonly allowedModels: readonly [];
}

function raise(code: AiOrchestratorWorkerWiringErrorCode): never {
  throw new AiOrchestratorWorkerWiringError(code);
}

export function parseAiOrchestratorWorkerWiringEnvironmentV1(
  input: AiOrchestratorWorkerWiringEnvironmentInput,
): Readonly<AiOrchestratorWorkerWiringEnvironment> {
  if (input.workerEnabled !== '1') raise('AI_WORKER_WIRING_GATE_INVALID');
  if ((input.provider ?? 'mock') !== 'mock') raise('AI_WORKER_WIRING_PROVIDER_NOT_MOCK');
  if ((input.externalProvidersEnabled ?? 'false') !== 'false') {
    raise('AI_WORKER_WIRING_EXTERNAL_PROVIDERS_NOT_DISABLED');
  }
  if ((input.allowedModels ?? '') !== '') raise('AI_WORKER_WIRING_MODEL_ALLOWLIST_NOT_EMPTY');

  return Object.freeze({
    activationEpoch: AI_ORCHESTRATOR_WORKER_WIRING_ACTIVATION_EPOCH,
    workerEnabled: true,
    provider: 'mock',
    dataMode: 'synthetic',
    externalProvidersEnabled: false,
    allowedModels: Object.freeze([] as const),
  });
}

export const AI_ORCHESTRATOR_WORKER_WIRING_AUTHORITY_DENIAL_CODES = Object.freeze([
  'FOUNDATION_LOCKED',
  'POLICY_DENIED',
  'CAPABILITY_DENIED',
  'CONFIGURATION_DENIED',
  'AUTHORITY_UNAVAILABLE',
] as const);

export type AiOrchestratorWorkerWiringAuthorityDenialCode =
  typeof AI_ORCHESTRATOR_WORKER_WIRING_AUTHORITY_DENIAL_CODES[number];

export type AiOrchestratorWorkerWiringAuthorityDecision =
  | Readonly<{ allowed: true; code: 'AUTHORIZED' }>
  | Readonly<{ allowed: false; code: AiOrchestratorWorkerWiringAuthorityDenialCode }>;

export const AI_ORCHESTRATOR_WORKER_WIRING_RESULT_CODES = Object.freeze([
  'AUTHORITY_FOUNDATION_LOCKED',
  'AUTHORITY_POLICY_DENIED',
  'AUTHORITY_CAPABILITY_DENIED',
  'AUTHORITY_CONFIGURATION_DENIED',
  'AUTHORITY_UNAVAILABLE',
  'LEASE_ACCEPTANCE_DISABLED',
  'NO_WORK',
  'LEASE_ACQUIRED',
  'LEASE_CURRENT',
  'LEASE_STALE',
  'DRAIN_REQUESTED',
] as const);

export type AiOrchestratorWorkerWiringResultCode =
  typeof AI_ORCHESTRATOR_WORKER_WIRING_RESULT_CODES[number];

export type AiOrchestratorWorkerWiringHeartbeatResult =
  | 'LEASE_CURRENT'
  | 'LEASE_STALE';

type MaybePromise<T> = T | Promise<T>;

export interface AiOrchestratorWorkerWiringAdaptersV1<Lease extends object> {
  readonly readAuthority: () => MaybePromise<AiOrchestratorWorkerWiringAuthorityDecision>;
  readonly canAcceptLease: () => MaybePromise<boolean>;
  readonly recover: () => MaybePromise<number>;
  readonly supersede: () => MaybePromise<number>;
  readonly admit: () => MaybePromise<number>;
  readonly claim: (identity: Readonly<{
    workerInstanceId: string;
    workerBuildHash: string;
  }>) => MaybePromise<Lease | null>;
  readonly heartbeat: (lease: Lease) => MaybePromise<AiOrchestratorWorkerWiringHeartbeatResult>;
  readonly surrender: (lease: Lease) => MaybePromise<void>;
  readonly disconnect: () => MaybePromise<void>;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface AiOrchestratorWorkerWiringSnapshotV1 {
  readonly workerInstanceId: string;
  readonly workerBuildHash: string;
  readonly state: AiOrchestratorWorkerWiringState;
  readonly lastResultCode: AiOrchestratorWorkerWiringResultCode | null;
  readonly operationSequence: number;
  readonly heartbeatSequence: number;
  readonly surrenderSequence: number;
  readonly activeLease: boolean;
  readonly operationPending: boolean;
  readonly timerPending: boolean;
}

export interface AiOrchestratorWorkerWiringProcessV1 {
  readonly workerInstanceId: string;
  readonly workerBuildHash: string;
  getSnapshot(): Readonly<AiOrchestratorWorkerWiringSnapshotV1>;
  start(): Promise<Readonly<AiOrchestratorWorkerWiringSnapshotV1>>;
  requestShutdown(): boolean;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function createAbortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function incrementSequence(value: number) {
  const next = value + 1;
  if (!Number.isSafeInteger(next) || next < 1) raise('AI_WORKER_WIRING_SEQUENCE_INVALID');
  return next;
}

function validateCount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    raise('AI_WORKER_WIRING_INVARIANT_VIOLATION');
  }
  return value;
}

function normalizeProcessError(error: unknown) {
  if (error instanceof AiOrchestratorWorkerWiringError) return error;
  return new AiOrchestratorWorkerWiringError('AI_WORKER_WIRING_PROCESS_FAILURE');
}

function normalizeAdapterError(error: unknown) {
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : null;
  if (code === 'AI_WORKER_RUNTIME_ADAPTER_DB_TRANSIENT') {
    return new AiOrchestratorWorkerWiringError(
      'AI_WORKER_WIRING_DB_TRANSIENT_EXHAUSTED',
    );
  }
  if (code === 'AI_WORKER_RUNTIME_ADAPTER_DB_UNAVAILABLE') {
    return new AiOrchestratorWorkerWiringError('AI_WORKER_WIRING_DB_UNAVAILABLE');
  }
  return new AiOrchestratorWorkerWiringError('AI_WORKER_WIRING_ADAPTER_FAILURE');
}

const authorityResultCodes: Readonly<Record<
  AiOrchestratorWorkerWiringAuthorityDenialCode,
  AiOrchestratorWorkerWiringResultCode
>> = Object.freeze({
  FOUNDATION_LOCKED: 'AUTHORITY_FOUNDATION_LOCKED',
  POLICY_DENIED: 'AUTHORITY_POLICY_DENIED',
  CAPABILITY_DENIED: 'AUTHORITY_CAPABILITY_DENIED',
  CONFIGURATION_DENIED: 'AUTHORITY_CONFIGURATION_DENIED',
  AUTHORITY_UNAVAILABLE: 'AUTHORITY_UNAVAILABLE',
});

function validateAuthorityDecision(
  value: AiOrchestratorWorkerWiringAuthorityDecision,
): AiOrchestratorWorkerWiringAuthorityDecision {
  if (!value || typeof value !== 'object' || typeof value.allowed !== 'boolean') {
    raise('AI_WORKER_WIRING_INVARIANT_VIOLATION');
  }
  if (value.allowed === true && value.code === 'AUTHORIZED') return value;
  if (
    value.allowed === false
    && (AI_ORCHESTRATOR_WORKER_WIRING_AUTHORITY_DENIAL_CODES as readonly string[])
      .includes(value.code)
  ) return value;
  raise('AI_WORKER_WIRING_INVARIANT_VIOLATION');
}

function validateLease<Lease extends object>(value: Lease | null) {
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    raise('AI_WORKER_WIRING_INVARIANT_VIOLATION');
  }
  return value;
}

function validateHeartbeatResult(value: AiOrchestratorWorkerWiringHeartbeatResult) {
  if (value !== 'LEASE_CURRENT' && value !== 'LEASE_STALE') {
    raise('AI_WORKER_WIRING_INVARIANT_VIOLATION');
  }
  return value;
}

class WorkerAdmissionClaimLeaseWiringV1<Lease extends object>
implements AiOrchestratorWorkerWiringProcessV1 {
  readonly workerInstanceId = randomUUID();
  readonly workerBuildHash = AI_ORCHESTRATOR_WORKER_WIRING_BUILD_HASH;

  #state: AiOrchestratorWorkerWiringState = 'STARTING';
  #lastResultCode: AiOrchestratorWorkerWiringResultCode | null = null;
  #operationSequence = 0;
  #heartbeatSequence = 0;
  #surrenderSequence = 0;
  #operationPending = false;
  #timerPending = false;
  #activeLease: { lease: Lease; surrenderAttempted: boolean } | null = null;
  #disconnectAttempted = false;
  #abortController = new AbortController();
  #completion: Promise<Readonly<AiOrchestratorWorkerWiringSnapshotV1>> | null = null;
  readonly #adapters: AiOrchestratorWorkerWiringAdaptersV1<Lease>;
  readonly #wait: (delayMs: number, signal: AbortSignal) => Promise<void>;

  constructor(adapters: AiOrchestratorWorkerWiringAdaptersV1<Lease>) {
    this.#adapters = adapters;
    this.#wait = adapters.wait ?? (async (delayMs, signal) => {
      await abortableTimeout(delayMs, undefined, { signal });
    });
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(this.workerInstanceId)
      || !/^[0-9a-f]{64}$/.test(this.workerBuildHash)
    ) raise('AI_WORKER_WIRING_IDENTITY_INVALID');
  }

  getSnapshot() {
    return Object.freeze({
      workerInstanceId: this.workerInstanceId,
      workerBuildHash: this.workerBuildHash,
      state: this.#state,
      lastResultCode: this.#lastResultCode,
      operationSequence: this.#operationSequence,
      heartbeatSequence: this.#heartbeatSequence,
      surrenderSequence: this.#surrenderSequence,
      activeLease: this.#activeLease !== null,
      operationPending: this.#operationPending,
      timerPending: this.#timerPending,
    });
  }

  start() {
    this.#completion ??= this.#run();
    return this.#completion;
  }

  requestShutdown() {
    if (this.#state === 'DRAINING' || this.#state === 'STOPPED') return false;
    this.#beginDrain(true);
    return true;
  }

  #beginDrain(recordRequest: boolean) {
    if (this.#state !== 'STOPPED') this.#state = 'DRAINING';
    if (recordRequest) this.#lastResultCode = 'DRAIN_REQUESTED';
    this.#abortController.abort();
  }

  #isDraining() {
    return this.#state === 'DRAINING' || this.#state === 'STOPPED';
  }

  #setState(state: AiOrchestratorWorkerWiringState) {
    if (!this.#isDraining()) this.#state = state;
  }

  async #invoke<T>(action: () => MaybePromise<T>) {
    if (this.#operationPending) raise('AI_WORKER_WIRING_INVARIANT_VIOLATION');
    this.#operationPending = true;
    this.#operationSequence = incrementSequence(this.#operationSequence);
    try {
      return await action();
    } catch (error) {
      if (error instanceof AiOrchestratorWorkerWiringError) throw error;
      throw normalizeAdapterError(error);
    } finally {
      this.#operationPending = false;
    }
  }

  async #readAuthority() {
    this.#setState('CHECKING_AUTHORITY');
    return validateAuthorityDecision(await this.#invoke(this.#adapters.readAuthority));
  }

  async #readLeaseAcceptance() {
    const accepted = await this.#invoke(this.#adapters.canAcceptLease);
    if (typeof accepted !== 'boolean') raise('AI_WORKER_WIRING_INVARIANT_VIOLATION');
    return accepted;
  }

  async #authorizeNextMutationOrWait() {
    const authority = await this.#readAuthority();
    if (this.#isDraining()) return false;
    if (!authority.allowed) {
      this.#lastResultCode = authorityResultCodes[authority.code];
    } else {
      const canAcceptLease = await this.#readLeaseAcceptance();
      if (this.#isDraining()) return false;
      if (canAcceptLease) return true;
      this.#lastResultCode = 'LEASE_ACCEPTANCE_DISABLED';
    }

    if (!this.#isDraining()) {
      this.#setState('IDLE');
      await this.#waitOnce(AI_ORCHESTRATOR_WORKER_WIRING_LIMITS.pollIntervalMs);
    }
    return false;
  }

  async #waitOnce(delayMs: number) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      raise('AI_WORKER_WIRING_TIMER_FAILURE');
    }
    const signal = this.#abortController.signal;
    if (signal.aborted) return;
    this.#timerPending = true;
    let removeAbortListener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolveAbort, rejectAbort) => {
      const onAbort = () => rejectAbort(createAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    });
    const waiting = Promise.resolve().then(() => this.#wait(delayMs, signal));
    try {
      await Promise.race([waiting, aborted]);
    } catch (error) {
      if (this.#isDraining() && signal.aborted && isAbortError(error)) return;
      throw new AiOrchestratorWorkerWiringError('AI_WORKER_WIRING_TIMER_FAILURE');
    } finally {
      removeAbortListener();
      this.#timerPending = false;
    }
  }

  async #runAvailableCycle() {
    if (!await this.#authorizeNextMutationOrWait()) return;
    this.#setState('RECOVERING');
    validateCount(await this.#invoke(this.#adapters.recover));
    if (this.#isDraining()) return;

    if (!await this.#authorizeNextMutationOrWait()) return;
    this.#setState('SUPERSEDING');
    validateCount(await this.#invoke(this.#adapters.supersede));
    if (this.#isDraining()) return;

    if (!await this.#authorizeNextMutationOrWait()) return;
    this.#setState('ADMITTING');
    validateCount(await this.#invoke(this.#adapters.admit));
    if (this.#isDraining()) return;

    if (!await this.#authorizeNextMutationOrWait()) return;
    this.#setState('CLAIMING');
    const lease = validateLease(await this.#invoke(() => this.#adapters.claim(Object.freeze({
      workerInstanceId: this.workerInstanceId,
      workerBuildHash: this.workerBuildHash,
    }))));
    if (lease !== null) {
      this.#activeLease = { lease, surrenderAttempted: false };
      if (!this.#isDraining()) this.#lastResultCode = 'LEASE_ACQUIRED';
    }
    if (this.#isDraining()) return;
    if (lease === null) {
      this.#lastResultCode = 'NO_WORK';
      this.#setState('IDLE');
      await this.#waitOnce(AI_ORCHESTRATOR_WORKER_WIRING_LIMITS.pollIntervalMs);
      return;
    }
    this.#setState('LEASED');
  }

  async #runLeasedCycle() {
    await this.#waitOnce(AI_ORCHESTRATOR_WORKER_WIRING_LIMITS.heartbeatIntervalMs);
    if (this.#isDraining() || !this.#activeLease) return;

    const authority = await this.#readAuthority();
    if (this.#isDraining() || !this.#activeLease) return;
    if (!authority.allowed) {
      this.#lastResultCode = authorityResultCodes[authority.code];
      this.#beginDrain(false);
      return;
    }

    const canAcceptLease = await this.#readLeaseAcceptance();
    if (this.#isDraining() || !this.#activeLease) return;
    if (!canAcceptLease) {
      this.#lastResultCode = 'LEASE_ACCEPTANCE_DISABLED';
      this.#beginDrain(false);
      return;
    }

    this.#setState('LEASED');
    const heartbeat = validateHeartbeatResult(
      await this.#invoke(() => this.#adapters.heartbeat(this.#activeLease!.lease)),
    );
    this.#heartbeatSequence = incrementSequence(this.#heartbeatSequence);
    const drainingAfterHeartbeat = this.#isDraining();
    if (heartbeat === 'LEASE_STALE') {
      this.#activeLease = null;
      if (!drainingAfterHeartbeat) this.#setState('IDLE');
    }
    if (!drainingAfterHeartbeat) this.#lastResultCode = heartbeat;
  }

  async #surrenderActiveLeaseOnce() {
    const active = this.#activeLease;
    if (!active || active.surrenderAttempted) return;
    active.surrenderAttempted = true;
    this.#surrenderSequence = incrementSequence(this.#surrenderSequence);
    try {
      await this.#invoke(() => this.#adapters.surrender(active.lease));
    } finally {
      this.#activeLease = null;
    }
  }

  async #disconnectOnce() {
    if (this.#disconnectAttempted) return;
    this.#disconnectAttempted = true;
    await this.#invoke(this.#adapters.disconnect);
  }

  async #run() {
    let terminalError: AiOrchestratorWorkerWiringError | null = null;
    try {
      while (!this.#isDraining()) {
        if (this.#activeLease) await this.#runLeasedCycle();
        else await this.#runAvailableCycle();
      }
    } catch (error) {
      terminalError = normalizeProcessError(error);
      this.#beginDrain(false);
    } finally {
      this.#beginDrain(false);
      try {
        await this.#surrenderActiveLeaseOnce();
      } catch (error) {
        terminalError ??= normalizeProcessError(error);
      }
      try {
        await this.#disconnectOnce();
      } catch (error) {
        terminalError ??= normalizeProcessError(error);
      }
      this.#operationPending = false;
      this.#timerPending = false;
      this.#state = 'STOPPED';
    }

    if (terminalError) throw terminalError;
    return this.getSnapshot();
  }
}

export function createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1<Lease extends object>(
  input: {
    readonly environment: AiOrchestratorWorkerWiringEnvironmentInput;
    readonly adapters: AiOrchestratorWorkerWiringAdaptersV1<Lease>;
  },
): AiOrchestratorWorkerWiringProcessV1 {
  parseAiOrchestratorWorkerWiringEnvironmentV1(input.environment);
  return new WorkerAdmissionClaimLeaseWiringV1(input.adapters);
}

export function getAiOrchestratorWorkerWiringInvariantErrorsV1() {
  const errors: string[] = [];
  const manifest = AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST;
  if (manifest.activationEpoch !== 'FOUNDATION_LOCKED_V1') {
    errors.push('Activation epoch non bloccata.');
  }
  if (manifest.operational !== false || manifest.productionComposition.canAcceptLease !== false) {
    errors.push('La composizione production dichiara autorità operativa.');
  }
  if (manifest.productionComposition.leaseConsumer !== 'NONE') {
    errors.push('La composizione production dichiara un consumer.');
  }
  if (
    manifest.authority.defaultDecision !== 'DENY'
    || manifest.authority.authorityCheckRequired !== true
    || manifest.authority.authorityRecheckBeforeEachMutator !== true
  ) errors.push('Authority default non fail-closed.');
  if (
    JSON.stringify(manifest.authority.riskReductionOperations)
    !== JSON.stringify(['SURRENDER'])
  ) errors.push('Catalogo operazioni risk-reduction non canonico.');
  if (
    manifest.authority.payloadAccessAllowed
    || manifest.authority.crmDataAccessAllowed
    || manifest.authority.networkAccessAllowed
    || manifest.authority.providerCallAllowed
    || manifest.authority.terminalMutationAllowed
    || manifest.authority.workflowTransitionWriteAllowed
  ) errors.push('Un confine vietato risulta abilitato.');
  if (manifest.scheduling.overlappingOperationsAllowed !== false) {
    errors.push('Le operazioni concorrenti risultano abilitate.');
  }
  if (JSON.stringify(manifest.implementedOperations) !== JSON.stringify(IMPLEMENTED_OPERATIONS)) {
    errors.push('Catalogo operazioni non canonico.');
  }
  if (!/^[0-9a-f]{64}$/.test(AI_ORCHESTRATOR_WORKER_WIRING_BUILD_HASH)) {
    errors.push('Build manifest hash non valido.');
  }
  return errors;
}
