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

function safeErrorCode(error: unknown): AiOrchestratorDormantWorkerErrorCode {
  if (error instanceof AiOrchestratorDormantWorkerProcessError) return error.code;
  return 'AI_DORMANT_WORKER_PROCESS_FAILURE';
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

async function main() {
  const stdout = createStdoutJsonLineWriter();
  try {
    const worker = createAiOrchestratorDormantWorkerProcessV1({
      environment: {
        workerEnabled: process.env.AI_ORCHESTRATOR_WORKER_ENABLED,
        provider: process.env.AI_PROVIDER,
        externalProvidersEnabled: process.env.AI_EXTERNAL_PROVIDERS_ENABLED,
        allowedModels: process.env.AI_ALLOWED_MODELS,
      },
      adapters: { writeJsonLine: stdout.writeJsonLine },
    });

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
  } finally {
    stdout.dispose();
  }
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
