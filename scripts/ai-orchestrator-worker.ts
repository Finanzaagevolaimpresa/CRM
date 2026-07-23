import {
  AI_ORCHESTRATOR_DORMANT_WORKER_ACTIVATION_EPOCH,
  AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_VERSION,
  AiOrchestratorDormantWorkerProcessError,
  createAiOrchestratorDormantWorkerProcessV1,
  type AiOrchestratorDormantWorkerErrorCode,
} from '../src/lib/ai-orchestrator/dormant-worker-process-v1';

function createAbortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function createStdoutJsonLineWriter() {
  let streamFailed = false;
  let streamErrorObserved = false;
  let nativeWritePending = false;
  let disposeRequested = false;
  let rejectPendingWrite: (() => void) | null = null;

  const removeStreamListener = () => {
    process.stdout.removeListener('error', onStreamError);
  };
  const maybeDispose = () => {
    if (!disposeRequested || nativeWritePending) return;
    if (streamFailed && !streamErrorObserved) return;
    removeStreamListener();
  };
  const onStreamError = () => {
    streamFailed = true;
    streamErrorObserved = true;
    rejectPendingWrite?.();
    maybeDispose();
  };
  process.stdout.on('error', onStreamError);

  const writeJsonLine = (line: string, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (rejectPendingWrite === rejectForStreamFailure) rejectPendingWrite = null;
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      if (nativeWritePending && !process.stdout.destroyed) process.stdout.destroy();
      finish(createAbortError());
    };
    const rejectForStreamFailure = () => finish(new Error('stdout unavailable'));
    rejectPendingWrite = rejectForStreamFailure;
    signal.addEventListener('abort', onAbort, { once: true });

    if (signal.aborted) {
      onAbort();
      return;
    }
    if (streamFailed) {
      rejectForStreamFailure();
      return;
    }
    try {
      nativeWritePending = true;
      process.stdout.write(line, 'utf8', (error) => {
        nativeWritePending = false;
        if (error) {
          streamFailed = true;
          finish(new Error('stdout unavailable'));
        }
        else finish();
        maybeDispose();
      });
    } catch {
      nativeWritePending = false;
      streamFailed = true;
      finish(new Error('stdout unavailable'));
      maybeDispose();
    }
  });

  return Object.freeze({
    writeJsonLine,
    dispose() {
      disposeRequested = true;
      rejectPendingWrite = null;
      maybeDispose();
    },
  });
}

function writeMinimizedFailure(line: string) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.stderr.removeListener('error', finish);
      resolve();
    };
    process.stderr.once('error', finish);
    try {
      process.stderr.write(line, 'utf8', finish);
    } catch {
      finish();
    }
  });
}

const AI_ORCHESTRATOR_WORKER_WIRING_ERROR_CODE_VALUES = [
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
] as const;

type AiOrchestratorWorkerWiringScriptErrorCode =
  typeof AI_ORCHESTRATOR_WORKER_WIRING_ERROR_CODE_VALUES[number];
type AiOrchestratorWorkerScriptErrorCode =
  | AiOrchestratorDormantWorkerErrorCode
  | AiOrchestratorWorkerWiringScriptErrorCode;

const AI_ORCHESTRATOR_WORKER_WIRING_ERROR_CODES: ReadonlySet<string> =
  new Set(AI_ORCHESTRATOR_WORKER_WIRING_ERROR_CODE_VALUES);

let defaultFailureCode: AiOrchestratorWorkerScriptErrorCode =
  'AI_DORMANT_WORKER_PROCESS_FAILURE';

function safeErrorCode(error: unknown): AiOrchestratorWorkerScriptErrorCode {
  if (error instanceof AiOrchestratorDormantWorkerProcessError) return error.code;
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : null;
  if (typeof code === 'string' && AI_ORCHESTRATOR_WORKER_WIRING_ERROR_CODES.has(code)) {
    return code as AiOrchestratorWorkerWiringScriptErrorCode;
  }
  return defaultFailureCode;
}

type WorkerEnvironment = Readonly<{
  workerEnabled?: string;
  provider?: string;
  externalProvidersEnabled?: string;
  allowedModels?: string;
}>;

function readWorkerEnvironment(): WorkerEnvironment {
  return Object.freeze({
    workerEnabled: process.env.AI_ORCHESTRATOR_WORKER_ENABLED,
    provider: process.env.AI_PROVIDER,
    externalProvidersEnabled: process.env.AI_EXTERNAL_PROVIDERS_ENABLED,
    allowedModels: process.env.AI_ALLOWED_MODELS,
  });
}

async function runWithSignals(worker: {
  start(): Promise<unknown>;
  requestShutdown(): boolean;
}) {
  const requestShutdown = () => {
    worker.requestShutdown();
  };
  process.on('SIGTERM', requestShutdown);
  process.on('SIGINT', requestShutdown);
  try {
    await worker.start();
  } finally {
    process.removeListener('SIGTERM', requestShutdown);
    process.removeListener('SIGINT', requestShutdown);
  }
}

async function runDormantWorker(environment: WorkerEnvironment) {
  const stdout = createStdoutJsonLineWriter();
  try {
    const worker = createAiOrchestratorDormantWorkerProcessV1({
      environment,
      adapters: { writeJsonLine: stdout.writeJsonLine },
    });

    await runWithSignals(worker);
  } finally {
    stdout.dispose();
  }
}

async function runAdmissionClaimLeaseWorker(environment: WorkerEnvironment) {
  defaultFailureCode = 'AI_WORKER_WIRING_PROCESS_FAILURE';
  const wiringModule = await import(
    '../src/lib/ai-orchestrator/worker-admission-claim-lease-process-v1'
  );
  const worker = wiringModule.createAiOrchestratorWorkerProductionProcessV1({
    environment,
  });
  await runWithSignals(worker);
}

async function main() {
  const environment = readWorkerEnvironment();
  if (environment.workerEnabled === '1') {
    await runAdmissionClaimLeaseWorker(environment);
    return;
  }
  await runDormantWorker(environment);
}

void main().catch(async (error: unknown) => {
  process.exitCode = 1;
  const failure = {
    schemaVersion: 1,
    workerProcessVersion: AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_VERSION,
    activationEpoch: AI_ORCHESTRATOR_DORMANT_WORKER_ACTIVATION_EPOCH,
    errorCode: safeErrorCode(error),
  };
  await writeMinimizedFailure(`${JSON.stringify(failure)}\n`);
});
