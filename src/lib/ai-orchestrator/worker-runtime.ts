import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { assertSha256, canonicalSha256, sha256 } from '../canonical-json';
import { prisma } from '../prisma';
import {
  AI_ORCHESTRATOR_RETRYABLE_FAILURE_CODES,
  AI_ORCHESTRATOR_TERMINAL_FAILURE_CODES,
  AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES,
  AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION,
  calculateAiOrchestratorRetryDelayMs,
  getAiOrchestratorWorkerCapability,
  type AiOrchestratorFailureCode,
} from './worker-runtime-policy-v1';

export const AI_ORCHESTRATOR_WORKER_ENV_GATE = 'AI_ORCHESTRATOR_WORKER_ENABLED' as const;
const OUTBOX_CONSUMER_CODE = 'AI_ORCHESTRATOR_JOB_PLANNED_CONSUMER' as const;
const OUTBOX_CONSUMER_VERSION = '1.0' as const;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class AiOrchestratorWorkerDisabledError extends Error {
  constructor(message = 'AI Orchestrator Worker Runtime disabilitato o configurazione fail-closed.') {
    super(message);
    this.name = 'AiOrchestratorWorkerDisabledError';
  }
}

export class AiOrchestratorLeaseLostError extends Error {
  constructor(message = 'Lease AI Orchestrator scaduta, revocata o non più posseduta.') {
    super(message);
    this.name = 'AiOrchestratorLeaseLostError';
  }
}

declare const workflowJobLeaseBrand: unique symbol;
export type AiWorkflowJobLease = { readonly [workflowJobLeaseBrand]: true };

type LeaseClaims = {
  runtimeId: string;
  jobId: string;
  attemptSequence: number;
  fencingToken: bigint;
  workerInstanceId: string;
  secret: string;
  tokenHash: string;
  leaseExpiresAt: Date;
};

const activeWorkflowJobLeases = new WeakMap<object, LeaseClaims>();

export type ClaimedAiWorkflowJob = {
  runtimeId: string;
  jobId: string;
  jobCode: string;
  jobVersion: string;
  jobPayloadHash: string;
  payload: Prisma.JsonValue;
  workflowInstanceId: string;
  workflowDefinitionHash: string;
  phaseCode: string;
  phaseEntrySequence: number;
  correctionCycle: number;
  executorAgentId: string;
  executorAgentCode: string;
  executorAgentConfigVersion: number;
  executorAgentConfigHash: string;
  capabilityCode: string;
  capabilityHash: string;
  handlerCode: string;
  handlerVersion: string;
  attemptSequence: number;
  fencingToken: bigint;
  leaseExpiresAt: Date;
  lease: AiWorkflowJobLease;
};

type RuntimeDb = Prisma.TransactionClient;

type RuntimeGateRow = {
  stateMachineEnabled: boolean;
  dispatchEnabled: boolean;
  syntheticDataOnly: boolean;
  provider: string;
  externalProvidersEnabled: boolean;
};

type AdmissionCandidate = {
  outboxEventId: string;
  eventKey: string;
  eventPayloadHash: string;
  jobId: string;
  workflowInstanceId: string;
  workflowDefinitionHash: string;
  phaseCode: string;
  phaseEntrySequence: number;
  correctionCycle: number;
  executorAgentId: string;
  executorAgentCode: string;
  executorAgentConfigVersion: number;
  executorAgentConfigHash: string;
  jobCode: string;
  jobVersion: string;
  jobDefinitionHash: string;
  jobDedupeKey: string;
  jobPayloadHash: string;
  availableAt: Date;
};

type ClaimCandidate = {
  runtimeId: string;
  jobId: string;
  workflowInstanceId: string;
  runtimePolicyHash: string;
  capabilityCode: string;
  capabilityHash: string;
  handlerCode: string;
  handlerVersion: string;
  attemptSequence: number;
  retryFailureCount: number;
  fencingToken: bigint;
  jobCode: string;
  jobVersion: string;
  jobPayloadHash: string;
  workflowDefinitionHash: string;
  phaseCode: string;
  phaseEntrySequence: number;
  correctionCycle: number;
  executorAgentId: string;
  executorAgentCode: string;
  executorAgentConfigVersion: number;
  executorAgentConfigHash: string;
  payload: Prisma.JsonValue;
};

function assertWorkerEnvironmentEnabled() {
  if (process.env[AI_ORCHESTRATOR_WORKER_ENV_GATE] !== '1') {
    throw new AiOrchestratorWorkerDisabledError(`${AI_ORCHESTRATOR_WORKER_ENV_GATE} non abilitato.`);
  }
}

function normalizeBatchSize(value: number | undefined, maximum: number) {
  if (value === undefined) return maximum;
  if (!Number.isFinite(value)) throw new TypeError('Dimensione batch runtime non valida.');
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function assertWorkerIdentity(workerInstanceId: string, workerBuildHash: string) {
  if (!WORKER_ID_PATTERN.test(workerInstanceId)) throw new TypeError('Identità worker non valida.');
  assertSha256(workerBuildHash, 'Worker build hash');
}

async function databaseNow(tx: Pick<RuntimeDb, '$queryRaw'>) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new AiOrchestratorWorkerDisabledError('Orologio PostgreSQL non disponibile.');
  }
  return now;
}

async function lockAndAssertRuntimeGates(tx: RuntimeDb) {
  const rows = await tx.$queryRaw<RuntimeGateRow[]>(Prisma.sql`
    SELECT
      orchestrator."stateMachineEnabled",
      orchestrator."dispatchEnabled",
      orchestrator."syntheticDataOnly",
      orchestrator."provider",
      control."externalProvidersEnabled"
    FROM "AiOrchestratorSetting" orchestrator
    CROSS JOIN "AiControlSetting" control
    WHERE orchestrator."id" = 'global' AND control."id" = 'global'
    FOR UPDATE OF orchestrator, control
  `);
  const gates = rows[0];
  if (
    !gates
    || gates.stateMachineEnabled !== true
    || gates.dispatchEnabled !== true
    || gates.syntheticDataOnly !== true
    || gates.provider !== 'mock'
    || gates.externalProvidersEnabled !== false
  ) throw new AiOrchestratorWorkerDisabledError();
}

async function runtimeJobIsCurrent(tx: RuntimeDb, jobId: string) {
  const rows = await tx.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
    SELECT "ai_workflow_runtime_job_is_current"(${jobId}) AS "valid"
  `);
  return rows[0]?.valid === true;
}

async function appendRuntimeEvent(
  tx: RuntimeDb,
  input: {
    runtimeId: string;
    jobId: string;
    workflowInstanceId: string;
    eventType: 'ADMITTED' | 'CLAIMED' | 'RETRY_SCHEDULED' | 'FAILED_TERMINAL'
      | 'SURRENDERED' | 'SUCCEEDED' | 'SUPERSEDED' | 'LEASE_RECOVERED';
    attemptSequence?: number | null;
    fencingToken?: bigint | null;
    reasonCode?: string | null;
    payload: Record<string, string | number | boolean | null>;
    occurredAt: Date;
  },
) {
  const previous = await tx.aiWorkflowJobRuntimeEvent.findFirst({
    where: { runtimeId: input.runtimeId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true, eventHash: true },
  });
  const sequence = (previous?.sequence ?? 0) + 1;
  const payload = {
    schemaVersion: 1,
    runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
    ...input.payload,
  };
  const payloadHash = canonicalSha256(payload);
  const eventHash = canonicalSha256({
    schemaVersion: 1,
    runtimeId: input.runtimeId,
    jobId: input.jobId,
    workflowInstanceId: input.workflowInstanceId,
    sequence,
    eventType: input.eventType,
    attemptSequence: input.attemptSequence ?? null,
    fencingToken: input.fencingToken === undefined || input.fencingToken === null
      ? null
      : String(input.fencingToken),
    reasonCode: input.reasonCode ?? null,
    payloadHash,
    previousEventHash: previous?.eventHash ?? null,
    occurredAt: input.occurredAt.toISOString(),
  });
  await tx.aiWorkflowJobRuntimeEvent.create({
    data: {
      id: randomUUID(),
      runtimeId: input.runtimeId,
      jobId: input.jobId,
      workflowInstanceId: input.workflowInstanceId,
      sequence,
      eventType: input.eventType,
      attemptSequence: input.attemptSequence ?? null,
      fencingToken: input.fencingToken ?? null,
      reasonCode: input.reasonCode ?? null,
      payload,
      payloadHash,
      previousEventHash: previous?.eventHash ?? null,
      eventHash,
      occurredAt: input.occurredAt,
    },
  });
}

export async function admitAiWorkflowJobOutbox(options: {
  batchSize?: number;
  workflowInstanceId?: string;
} = {}) {
  assertWorkerEnvironmentEnabled();
  if (options.workflowInstanceId !== undefined && !options.workflowInstanceId.trim()) {
    throw new TypeError('Workflow filter non valido.');
  }
  const batchSize = normalizeBatchSize(
    options.batchSize,
    AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.outboxAdmissionBatchSize,
  );
  return prisma.$transaction(async (tx) => {
    await lockAndAssertRuntimeGates(tx);
    const candidates = await tx.$queryRaw<AdmissionCandidate[]>(Prisma.sql`
      SELECT
        event."id" AS "outboxEventId",
        event."eventKey",
        event."payloadHash" AS "eventPayloadHash",
        job."id" AS "jobId",
        job."workflowInstanceId",
        job."workflowDefinitionHash",
        job."phaseCode",
        job."phaseEntrySequence",
        job."correctionCycle",
        job."executorAgentId",
        job."executorAgentCode",
        job."executorAgentConfigVersion",
        job."executorAgentConfigHash",
        job."jobCode",
        job."jobVersion",
        job."jobDefinitionHash",
        job."dedupeKey" AS "jobDedupeKey",
        job."payloadHash" AS "jobPayloadHash",
        job."availableAt"
      FROM "AiWorkflowJobOutboxEvent" event
      JOIN "AiWorkflowJob" job ON job."id" = event."jobId"
      WHERE event."eventType" = 'AI_JOB_PLANNED'
        AND event."eventVersion" = 1 AND event."deliveryState" = 'PENDING'
        AND NOT EXISTS (
          SELECT 1 FROM "AiWorkflowOutboxConsumption" consumed
          WHERE consumed."outboxEventId" = event."id"
        )
        ${options.workflowInstanceId
          ? Prisma.sql`AND job."workflowInstanceId" = ${options.workflowInstanceId}`
          : Prisma.empty}
        AND "ai_workflow_runtime_job_is_current"(job."id")
        AND "ai_workflow_runtime_executor_is_valid"(job."id")
      ORDER BY job."availableAt", event."occurredAt", event."id"
      LIMIT ${batchSize}
      FOR UPDATE OF event SKIP LOCKED
    `);
    const now = await databaseNow(tx);
    let admitted = 0;
    for (const candidate of candidates) {
      const capability = getAiOrchestratorWorkerCapability(candidate.jobCode);
      if (
        !capability
        || capability.jobVersion !== candidate.jobVersion
        || capability.jobDefinitionHash !== candidate.jobDefinitionHash
        || capability.executorAgentCode !== candidate.executorAgentCode
        || capability.executorAgentConfigVersion !== candidate.executorAgentConfigVersion
        || capability.executorAgentConfigHash !== candidate.executorAgentConfigHash
      ) throw new AiOrchestratorWorkerDisabledError('Capability runtime non coerente con il job canonico.');
      const capabilityHash = AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[capability.jobCode];
      const runtimeId = randomUUID();
      await tx.aiWorkflowJobRuntime.create({
        data: {
          id: runtimeId,
          jobId: candidate.jobId,
          workflowInstanceId: candidate.workflowInstanceId,
          runtimePolicyCode: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE,
          runtimePolicyVersion: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION,
          runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
          capabilityCode: capability.capabilityCode,
          capabilityVersion: capability.capabilityVersion,
          capabilityHash,
          handlerCode: capability.handlerCode,
          handlerVersion: capability.handlerVersion,
          state: 'AVAILABLE',
          effectiveAvailableAt: candidate.availableAt,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.aiWorkflowOutboxConsumption.create({
        data: {
          id: randomUUID(),
          outboxEventId: candidate.outboxEventId,
          jobId: candidate.jobId,
          runtimeId,
          consumerCode: OUTBOX_CONSUMER_CODE,
          consumerVersion: OUTBOX_CONSUMER_VERSION,
          runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
          capabilityHash,
          eventKey: candidate.eventKey,
          eventPayloadHash: candidate.eventPayloadHash,
          jobDedupeKey: candidate.jobDedupeKey,
          jobPayloadHash: candidate.jobPayloadHash,
          workflowDefinitionHash: candidate.workflowDefinitionHash,
          phaseCode: candidate.phaseCode,
          phaseEntrySequence: candidate.phaseEntrySequence,
          correctionCycle: candidate.correctionCycle,
          executorAgentId: candidate.executorAgentId,
          executorAgentConfigVersion: candidate.executorAgentConfigVersion,
          executorAgentConfigHash: candidate.executorAgentConfigHash,
          consumedAt: now,
        },
      });
      await appendRuntimeEvent(tx, {
        runtimeId,
        jobId: candidate.jobId,
        workflowInstanceId: candidate.workflowInstanceId,
        eventType: 'ADMITTED',
        payload: {
          jobCode: candidate.jobCode,
          capabilityCode: capability.capabilityCode,
          capabilityHash,
          eventKey: candidate.eventKey,
          provider: 'mock',
          dataMode: 'synthetic',
          networkAccessAllowed: false,
          providerCallAllowed: false,
        },
        occurredAt: now,
      });
      admitted += 1;
    }
    return admitted;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

function createOpaqueLease(claims: LeaseClaims) {
  const lease = Object.freeze({}) as AiWorkflowJobLease;
  activeWorkflowJobLeases.set(lease, claims);
  return lease;
}

function getLeaseClaims(lease: AiWorkflowJobLease | null | undefined) {
  if (!lease || typeof lease !== 'object') throw new AiOrchestratorLeaseLostError();
  const claims = activeWorkflowJobLeases.get(lease);
  if (!claims || sha256(claims.secret) !== claims.tokenHash) throw new AiOrchestratorLeaseLostError();
  return claims;
}

export async function claimNextAiWorkflowJob(input: {
  workerInstanceId: string;
  workerBuildHash: string;
  workflowInstanceId?: string;
}): Promise<ClaimedAiWorkflowJob | null> {
  assertWorkerEnvironmentEnabled();
  assertWorkerIdentity(input.workerInstanceId, input.workerBuildHash);
  if (input.workflowInstanceId !== undefined && !input.workflowInstanceId.trim()) {
    throw new TypeError('Workflow filter non valido.');
  }
  const secret = randomBytes(32).toString('base64url');
  const tokenHash = sha256(secret);
  const claimed = await prisma.$transaction(async (tx) => {
    await lockAndAssertRuntimeGates(tx);
    const now = await databaseNow(tx);
    const active = await tx.aiWorkflowJobRuntime.count({
      where: { state: 'LEASED', leaseExpiresAt: { gt: now } },
    });
    if (active >= AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.maxConcurrentGlobal) return null;
    const candidates = await tx.$queryRaw<ClaimCandidate[]>(Prisma.sql`
      SELECT
        runtime."id" AS "runtimeId", runtime."jobId", runtime."workflowInstanceId",
        runtime."runtimePolicyHash", runtime."capabilityCode", runtime."capabilityHash",
        runtime."handlerCode", runtime."handlerVersion", runtime."attemptSequence",
        runtime."retryFailureCount", runtime."fencingToken",
        job."jobCode", job."jobVersion", job."payloadHash" AS "jobPayloadHash",
        job."workflowDefinitionHash", job."phaseCode", job."phaseEntrySequence",
        job."correctionCycle", job."executorAgentId", job."executorAgentCode",
        job."executorAgentConfigVersion", job."executorAgentConfigHash", job."payload"
      FROM "AiWorkflowJobRuntime" runtime
      JOIN "AiWorkflowJob" job ON job."id" = runtime."jobId"
      WHERE runtime."state" IN ('AVAILABLE', 'RETRY_WAIT')
        AND runtime."effectiveAvailableAt" <= ${now}
        AND runtime."runtimePolicyHash" = ${AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH}
        ${input.workflowInstanceId
          ? Prisma.sql`AND runtime."workflowInstanceId" = ${input.workflowInstanceId}`
          : Prisma.empty}
        AND "ai_workflow_runtime_job_is_current"(job."id")
        AND "ai_workflow_runtime_executor_is_valid"(job."id")
      ORDER BY runtime."effectiveAvailableAt", job."plannedAt", runtime."id"
      LIMIT 1
      FOR UPDATE OF runtime SKIP LOCKED
    `);
    const candidate = candidates[0];
    if (!candidate) return null;
    const [activeForWorkflow, activeForExecutor] = await Promise.all([
      tx.aiWorkflowJobRuntime.count({
        where: {
          state: 'LEASED',
          leaseExpiresAt: { gt: now },
          workflowInstanceId: candidate.workflowInstanceId,
        },
      }),
      tx.aiWorkflowJobRuntime.count({
        where: {
          state: 'LEASED',
          leaseExpiresAt: { gt: now },
          job: {
            executorAgentId: candidate.executorAgentId,
            executorAgentConfigVersion: candidate.executorAgentConfigVersion,
          },
        },
      }),
    ]);
    if (
      activeForWorkflow >= AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.maxConcurrentPerWorkflow
      || activeForExecutor >= AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.maxConcurrentPerExecutorConfig
    ) return null;
    const capability = getAiOrchestratorWorkerCapability(candidate.jobCode);
    if (
      !capability
      || candidate.capabilityHash !== AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[capability.jobCode]
      || candidate.capabilityCode !== capability.capabilityCode
      || candidate.handlerCode !== capability.handlerCode
    ) throw new AiOrchestratorWorkerDisabledError('Capability del runtime non verificabile.');
    const attemptSequence = candidate.attemptSequence + 1;
    const fencingToken = candidate.fencingToken + 1n;
    const leaseExpiresAt = new Date(now.getTime() + AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.leaseDurationMs);
    const leaseMaxExpiresAt = new Date(now.getTime() + AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.maxAttemptDurationMs);
    const updated = await tx.aiWorkflowJobRuntime.updateMany({
      where: {
        id: candidate.runtimeId,
        state: { in: ['AVAILABLE', 'RETRY_WAIT'] },
        attemptSequence: candidate.attemptSequence,
        fencingToken: candidate.fencingToken,
      },
      data: {
        state: 'LEASED',
        attemptSequence,
        fencingToken,
        leaseOwnerId: input.workerInstanceId,
        leaseTokenHash: tokenHash,
        leaseClaimedAt: now,
        leaseExpiresAt,
        leaseMaxExpiresAt,
        lastFailureCode: null,
        updatedAt: now,
      },
    });
    if (updated.count !== 1) throw new AiOrchestratorLeaseLostError('Claim concorrente perso.');
    await tx.aiWorkflowJobAttempt.create({
      data: {
        id: randomUUID(),
        runtimeId: candidate.runtimeId,
        jobId: candidate.jobId,
        attemptSequence,
        fencingToken,
        workerInstanceId: input.workerInstanceId,
        workerBuildHash: input.workerBuildHash,
        leaseTokenHash: tokenHash,
        claimedAt: now,
        leaseExpiresAt,
        leaseMaxExpiresAt,
        runtimePolicyHash: candidate.runtimePolicyHash,
        capabilityHash: candidate.capabilityHash,
        handlerCode: candidate.handlerCode,
        handlerVersion: candidate.handlerVersion,
        workflowDefinitionHash: candidate.workflowDefinitionHash,
        phaseCode: candidate.phaseCode,
        phaseEntrySequence: candidate.phaseEntrySequence,
        correctionCycle: candidate.correctionCycle,
        executorAgentId: candidate.executorAgentId,
        executorAgentConfigVersion: candidate.executorAgentConfigVersion,
        executorAgentConfigHash: candidate.executorAgentConfigHash,
        jobPayloadHash: candidate.jobPayloadHash,
      },
    });
    await appendRuntimeEvent(tx, {
      runtimeId: candidate.runtimeId,
      jobId: candidate.jobId,
      workflowInstanceId: candidate.workflowInstanceId,
      eventType: 'CLAIMED',
      attemptSequence,
      fencingToken,
      payload: {
        workerInstanceId: input.workerInstanceId,
        workerBuildHash: input.workerBuildHash,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        leaseMaxExpiresAt: leaseMaxExpiresAt.toISOString(),
        capabilityHash: candidate.capabilityHash,
      },
      occurredAt: now,
    });
    return { ...candidate, attemptSequence, fencingToken, leaseExpiresAt };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  if (!claimed) return null;
  const lease = createOpaqueLease({
    runtimeId: claimed.runtimeId,
    jobId: claimed.jobId,
    attemptSequence: claimed.attemptSequence,
    fencingToken: claimed.fencingToken,
    workerInstanceId: input.workerInstanceId,
    secret,
    tokenHash,
    leaseExpiresAt: claimed.leaseExpiresAt,
  });
  return {
    runtimeId: claimed.runtimeId,
    jobId: claimed.jobId,
    jobCode: claimed.jobCode,
    jobVersion: claimed.jobVersion,
    jobPayloadHash: claimed.jobPayloadHash,
    payload: claimed.payload,
    workflowInstanceId: claimed.workflowInstanceId,
    workflowDefinitionHash: claimed.workflowDefinitionHash,
    phaseCode: claimed.phaseCode,
    phaseEntrySequence: claimed.phaseEntrySequence,
    correctionCycle: claimed.correctionCycle,
    executorAgentId: claimed.executorAgentId,
    executorAgentCode: claimed.executorAgentCode,
    executorAgentConfigVersion: claimed.executorAgentConfigVersion,
    executorAgentConfigHash: claimed.executorAgentConfigHash,
    capabilityCode: claimed.capabilityCode,
    capabilityHash: claimed.capabilityHash,
    handlerCode: claimed.handlerCode,
    handlerVersion: claimed.handlerVersion,
    attemptSequence: claimed.attemptSequence,
    fencingToken: claimed.fencingToken,
    leaseExpiresAt: claimed.leaseExpiresAt,
    lease,
  };
}

export async function heartbeatAiWorkflowJobLease(lease: AiWorkflowJobLease) {
  assertWorkerEnvironmentEnabled();
  const claims = getLeaseClaims(lease);
  const leaseExpiresAt = await prisma.$transaction(async (tx) => {
    await lockAndAssertRuntimeGates(tx);
    const now = await databaseNow(tx);
    const runtime = await tx.aiWorkflowJobRuntime.findUnique({ where: { id: claims.runtimeId } });
    if (
      !runtime || runtime.state !== 'LEASED' || runtime.attemptSequence !== claims.attemptSequence
      || runtime.fencingToken !== claims.fencingToken || runtime.leaseTokenHash !== claims.tokenHash
      || !runtime.leaseExpiresAt || runtime.leaseExpiresAt <= now || !runtime.leaseMaxExpiresAt
    ) throw new AiOrchestratorLeaseLostError();
    const nextExpiry = new Date(Math.min(
      now.getTime() + AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.leaseDurationMs,
      runtime.leaseMaxExpiresAt.getTime(),
    ));
    if (nextExpiry <= runtime.leaseExpiresAt) throw new AiOrchestratorLeaseLostError('Lease non ulteriormente estendibile.');
    const updated = await tx.aiWorkflowJobRuntime.updateMany({
      where: {
        id: claims.runtimeId,
        state: 'LEASED',
        attemptSequence: claims.attemptSequence,
        fencingToken: claims.fencingToken,
        leaseTokenHash: claims.tokenHash,
        leaseExpiresAt: { gt: now },
      },
      data: { leaseExpiresAt: nextExpiry, updatedAt: now },
    });
    if (updated.count !== 1) throw new AiOrchestratorLeaseLostError();
    const attempt = await tx.aiWorkflowJobAttempt.updateMany({
      where: {
        runtimeId: claims.runtimeId,
        attemptSequence: claims.attemptSequence,
        fencingToken: claims.fencingToken,
        leaseTokenHash: claims.tokenHash,
        finishedAt: null,
      },
      data: { leaseExpiresAt: nextExpiry },
    });
    if (attempt.count !== 1) throw new AiOrchestratorLeaseLostError();
    return nextExpiry;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  claims.leaseExpiresAt = leaseExpiresAt;
  return leaseExpiresAt;
}

async function loadFencedRuntime(tx: RuntimeDb, claims: LeaseClaims, now: Date) {
  const runtime = await tx.aiWorkflowJobRuntime.findUnique({
    where: { id: claims.runtimeId },
    include: { job: true },
  });
  if (
    !runtime || runtime.jobId !== claims.jobId || runtime.state !== 'LEASED'
    || runtime.attemptSequence !== claims.attemptSequence || runtime.fencingToken !== claims.fencingToken
    || runtime.leaseOwnerId !== claims.workerInstanceId || runtime.leaseTokenHash !== claims.tokenHash
    || !runtime.leaseExpiresAt || runtime.leaseExpiresAt <= now
  ) throw new AiOrchestratorLeaseLostError();
  return runtime;
}

export async function completeAiWorkflowJob(
  lease: AiWorkflowJobLease,
  options: { resultHash: string },
) {
  assertWorkerEnvironmentEnabled();
  assertSha256(options.resultHash, 'Result hash');
  const claims = getLeaseClaims(lease);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.aiWorkflowJobRuntime.findUnique({ where: { id: claims.runtimeId } });
    if (existing?.state === 'SUCCEEDED' && existing.resultHash === options.resultHash) {
      return { replay: true as const, state: 'SUCCEEDED' as const };
    }
    await lockAndAssertRuntimeGates(tx);
    const now = await databaseNow(tx);
    const runtime = await loadFencedRuntime(tx, claims, now);
    if (!(await runtimeJobIsCurrent(tx, claims.jobId))) {
      await terminalizeSuperseded(tx, runtime, claims, now, 'PHASE_SUPERSEDED');
      return { replay: false as const, state: 'SUPERSEDED' as const };
    }
    const updated = await tx.aiWorkflowJobRuntime.updateMany({
      where: {
        id: claims.runtimeId,
        state: 'LEASED',
        attemptSequence: claims.attemptSequence,
        fencingToken: claims.fencingToken,
        leaseTokenHash: claims.tokenHash,
        leaseExpiresAt: { gt: now },
      },
      data: {
        state: 'SUCCEEDED',
        leaseOwnerId: null,
        leaseTokenHash: null,
        leaseClaimedAt: null,
        leaseExpiresAt: null,
        leaseMaxExpiresAt: null,
        terminalAt: now,
        terminalReasonCode: 'SUCCEEDED',
        resultHash: options.resultHash,
        lastFailureCode: null,
        updatedAt: now,
      },
    });
    if (updated.count !== 1) throw new AiOrchestratorLeaseLostError();
    const attempt = await tx.aiWorkflowJobAttempt.updateMany({
      where: {
        runtimeId: claims.runtimeId,
        attemptSequence: claims.attemptSequence,
        fencingToken: claims.fencingToken,
        leaseTokenHash: claims.tokenHash,
        finishedAt: null,
      },
      data: {
        finishedAt: now,
        outcome: 'SUCCEEDED',
        retryable: false,
        retryBudgetConsumed: false,
        resultHash: options.resultHash,
      },
    });
    if (attempt.count !== 1) throw new AiOrchestratorLeaseLostError();
    await appendRuntimeEvent(tx, {
      runtimeId: runtime.id,
      jobId: runtime.jobId,
      workflowInstanceId: runtime.workflowInstanceId,
      eventType: 'SUCCEEDED',
      attemptSequence: claims.attemptSequence,
      fencingToken: claims.fencingToken,
      reasonCode: 'SUCCEEDED',
      payload: { resultHash: options.resultHash, provider: 'mock', workflowTransitionApplied: false },
      occurredAt: now,
    });
    return { replay: false as const, state: 'SUCCEEDED' as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function terminalizeSuperseded(
  tx: RuntimeDb,
  runtime: Awaited<ReturnType<typeof loadFencedRuntime>>,
  claims: LeaseClaims,
  now: Date,
  reasonCode: 'PHASE_SUPERSEDED' | 'HUMAN_APPROVAL_REACHED' | 'JOB_BLOCKED',
) {
  await tx.aiWorkflowJobRuntime.update({
    where: { id: runtime.id },
    data: {
      state: 'SUPERSEDED',
      leaseOwnerId: null,
      leaseTokenHash: null,
      leaseClaimedAt: null,
      leaseExpiresAt: null,
      leaseMaxExpiresAt: null,
      terminalAt: now,
      terminalReasonCode: reasonCode,
      resultHash: null,
      lastFailureCode: reasonCode,
      updatedAt: now,
    },
  });
  const attempt = await tx.aiWorkflowJobAttempt.updateMany({
    where: {
      runtimeId: runtime.id,
      attemptSequence: claims.attemptSequence,
      fencingToken: claims.fencingToken,
      leaseTokenHash: claims.tokenHash,
      finishedAt: null,
    },
    data: {
      finishedAt: now,
      outcome: 'SUPERSEDED',
      failureCode: reasonCode,
      retryable: false,
      retryBudgetConsumed: false,
    },
  });
  if (attempt.count !== 1) throw new AiOrchestratorLeaseLostError();
  await appendRuntimeEvent(tx, {
    runtimeId: runtime.id,
    jobId: runtime.jobId,
    workflowInstanceId: runtime.workflowInstanceId,
    eventType: 'SUPERSEDED',
    attemptSequence: claims.attemptSequence,
    fencingToken: claims.fencingToken,
    reasonCode,
    payload: { phaseCode: runtime.job.phaseCode, correctionCycle: runtime.job.correctionCycle },
    occurredAt: now,
  });
}

function isRetryableFailureCode(code: AiOrchestratorFailureCode) {
  return (AI_ORCHESTRATOR_RETRYABLE_FAILURE_CODES as readonly string[]).includes(code);
}

function assertFailureCode(code: string): asserts code is AiOrchestratorFailureCode {
  if (
    !(AI_ORCHESTRATOR_RETRYABLE_FAILURE_CODES as readonly string[]).includes(code)
    && !(AI_ORCHESTRATOR_TERMINAL_FAILURE_CODES as readonly string[]).includes(code)
  ) throw new TypeError('Failure code runtime non riconosciuto.');
}

export async function failAiWorkflowJob(
  lease: AiWorkflowJobLease,
  options: { failureCode: AiOrchestratorFailureCode },
) {
  assertFailureCode(options.failureCode);
  const claims = getLeaseClaims(lease);
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const runtime = await loadFencedRuntime(tx, claims, now);
    const retryable = isRetryableFailureCode(options.failureCode);
    const retryFailureCount = runtime.retryFailureCount + (retryable ? 1 : 0);
    const shouldRetry = retryable
      && retryFailureCount < AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.maxRetryableFailures;
    const superseded = ['PHASE_SUPERSEDED', 'HUMAN_APPROVAL_REACHED', 'JOB_BLOCKED']
      .includes(options.failureCode);
    const nextAvailableAt = shouldRetry
      ? new Date(now.getTime() + calculateAiOrchestratorRetryDelayMs({
        jobId: runtime.jobId,
        fencingToken: runtime.fencingToken,
        retryFailureCount,
      }))
      : null;
    const nextState = shouldRetry ? 'RETRY_WAIT' : superseded ? 'SUPERSEDED' : 'FAILED_TERMINAL';
    await tx.aiWorkflowJobRuntime.update({
      where: { id: runtime.id },
      data: {
        state: nextState,
        effectiveAvailableAt: nextAvailableAt ?? runtime.effectiveAvailableAt,
        retryFailureCount,
        leaseOwnerId: null,
        leaseTokenHash: null,
        leaseClaimedAt: null,
        leaseExpiresAt: null,
        leaseMaxExpiresAt: null,
        terminalAt: shouldRetry ? null : now,
        terminalReasonCode: shouldRetry ? null : options.failureCode,
        resultHash: null,
        lastFailureCode: options.failureCode,
        updatedAt: now,
      },
    });
    const attempt = await tx.aiWorkflowJobAttempt.updateMany({
      where: {
        runtimeId: runtime.id,
        attemptSequence: claims.attemptSequence,
        fencingToken: claims.fencingToken,
        leaseTokenHash: claims.tokenHash,
        finishedAt: null,
      },
      data: {
        finishedAt: now,
        outcome: shouldRetry ? 'RETRY_SCHEDULED' : superseded ? 'SUPERSEDED' : 'FAILED_TERMINAL',
        failureCode: options.failureCode,
        retryable,
        retryBudgetConsumed: retryable,
        nextAvailableAt,
      },
    });
    if (attempt.count !== 1) throw new AiOrchestratorLeaseLostError();
    await appendRuntimeEvent(tx, {
      runtimeId: runtime.id,
      jobId: runtime.jobId,
      workflowInstanceId: runtime.workflowInstanceId,
      eventType: shouldRetry ? 'RETRY_SCHEDULED' : superseded ? 'SUPERSEDED' : 'FAILED_TERMINAL',
      attemptSequence: claims.attemptSequence,
      fencingToken: claims.fencingToken,
      reasonCode: options.failureCode,
      payload: {
        retryable,
        retryFailureCount,
        nextAvailableAt: nextAvailableAt?.toISOString() ?? null,
      },
      occurredAt: now,
    });
    return { state: nextState, retryFailureCount, nextAvailableAt };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function surrenderAiWorkflowJobLease(lease: AiWorkflowJobLease) {
  const claims = getLeaseClaims(lease);
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const runtime = await loadFencedRuntime(tx, claims, now);
    await tx.aiWorkflowJobRuntime.update({
      where: { id: runtime.id },
      data: {
        state: 'RETRY_WAIT',
        effectiveAvailableAt: now,
        leaseOwnerId: null,
        leaseTokenHash: null,
        leaseClaimedAt: null,
        leaseExpiresAt: null,
        leaseMaxExpiresAt: null,
        lastFailureCode: null,
        updatedAt: now,
      },
    });
    const attempt = await tx.aiWorkflowJobAttempt.updateMany({
      where: {
        runtimeId: runtime.id,
        attemptSequence: claims.attemptSequence,
        fencingToken: claims.fencingToken,
        leaseTokenHash: claims.tokenHash,
        finishedAt: null,
      },
      data: {
        finishedAt: now,
        outcome: 'SURRENDERED',
        retryable: true,
        retryBudgetConsumed: false,
      },
    });
    if (attempt.count !== 1) throw new AiOrchestratorLeaseLostError();
    await appendRuntimeEvent(tx, {
      runtimeId: runtime.id,
      jobId: runtime.jobId,
      workflowInstanceId: runtime.workflowInstanceId,
      eventType: 'SURRENDERED',
      attemptSequence: claims.attemptSequence,
      fencingToken: claims.fencingToken,
      reasonCode: 'WORKER_SURRENDERED',
      payload: { retryBudgetConsumed: false },
      occurredAt: now,
    });
    return { state: 'RETRY_WAIT' as const, availableAt: now };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function recoverExpiredAiWorkflowJobLeases(options: { batchSize?: number } = {}) {
  const batchSize = normalizeBatchSize(
    options.batchSize,
    AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.leaseRecoveryBatchSize,
  );
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const expired = await tx.$queryRaw<Array<{
      runtimeId: string;
      jobId: string;
      workflowInstanceId: string;
      attemptSequence: number;
      fencingToken: bigint;
      retryFailureCount: number;
      effectiveAvailableAt: Date;
    }>>(Prisma.sql`
      SELECT runtime."id" AS "runtimeId", runtime."jobId", runtime."workflowInstanceId",
        runtime."attemptSequence", runtime."fencingToken", runtime."retryFailureCount",
        runtime."effectiveAvailableAt"
      FROM "AiWorkflowJobRuntime" runtime
      WHERE runtime."state" = 'LEASED' AND runtime."leaseExpiresAt" <= ${now}
      ORDER BY runtime."leaseExpiresAt", runtime."id"
      LIMIT ${batchSize}
      FOR UPDATE OF runtime SKIP LOCKED
    `);
    let recovered = 0;
    for (const row of expired) {
      const current = await runtimeJobIsCurrent(tx, row.jobId);
      const retryFailureCount = row.retryFailureCount + (current ? 1 : 0);
      const shouldRetry = current
        && retryFailureCount < AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.maxRetryableFailures;
      const nextAvailableAt = shouldRetry
        ? new Date(now.getTime() + calculateAiOrchestratorRetryDelayMs({
          jobId: row.jobId,
          fencingToken: row.fencingToken,
          retryFailureCount,
        }))
        : null;
      const state = shouldRetry ? 'RETRY_WAIT' : current ? 'FAILED_TERMINAL' : 'SUPERSEDED';
      const reasonCode = current ? 'LEASE_EXPIRED' : 'PHASE_SUPERSEDED';
      await tx.aiWorkflowJobRuntime.update({
        where: { id: row.runtimeId },
        data: {
          state,
          effectiveAvailableAt: nextAvailableAt ?? row.effectiveAvailableAt,
          retryFailureCount,
          leaseOwnerId: null,
          leaseTokenHash: null,
          leaseClaimedAt: null,
          leaseExpiresAt: null,
          leaseMaxExpiresAt: null,
          terminalAt: shouldRetry ? null : now,
          terminalReasonCode: shouldRetry ? null : reasonCode,
          lastFailureCode: reasonCode,
          updatedAt: now,
        },
      });
      const attempt = await tx.aiWorkflowJobAttempt.updateMany({
        where: {
          runtimeId: row.runtimeId,
          attemptSequence: row.attemptSequence,
          fencingToken: row.fencingToken,
          finishedAt: null,
        },
        data: {
          finishedAt: now,
          outcome: shouldRetry ? 'RETRY_SCHEDULED' : current ? 'FAILED_TERMINAL' : 'SUPERSEDED',
          failureCode: reasonCode,
          retryable: current,
          retryBudgetConsumed: current,
          nextAvailableAt,
        },
      });
      if (attempt.count !== 1) {
        throw new AiOrchestratorLeaseLostError('Attempt scaduto non coerente con il runtime.');
      }
      await appendRuntimeEvent(tx, {
        runtimeId: row.runtimeId,
        jobId: row.jobId,
        workflowInstanceId: row.workflowInstanceId,
        eventType: 'LEASE_RECOVERED',
        attemptSequence: row.attemptSequence,
        fencingToken: row.fencingToken,
        reasonCode,
        payload: { state, retryFailureCount, nextAvailableAt: nextAvailableAt?.toISOString() ?? null },
        occurredAt: now,
      });
      recovered += 1;
    }
    return recovered;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
