import type { PrismaClient } from '@prisma/client';
import {
  BusinessEventBackboneError,
  claimBusinessQueueEvent,
  recoverExpiredBusinessQueueLeases,
  type BusinessQueueLease,
} from './business-event-backbone';
import {
  assertLeadIdentityKeyConsensus,
  LeadIdentityError,
  readLeadIdentityKeyFile,
} from './lead-identity';
import {
  LeadProjectionError,
  projectClaimedLeadInboxEvent,
} from './lead-projection';

export const LEAD_INTAKE_CONSUMER_MANIFEST = Object.freeze({
  code: 'VNX01_LEAD_INTAKE_CONSUMER' as const,
  version: 1,
  dormantByDefault: true,
  gateEnvironment: 'VNX01_LEAD_INTAKE_CONSUMER_ENABLED' as const,
  enabledValue: '1' as const,
  queueKind: 'INBOX' as const,
  runMode: 'BOUNDED_ONE_SHOT' as const,
  maximumBatchSize: 100,
  maximumRecoveryBatchSize: 100,
  shutdownBehavior: 'FINISH_CURRENT_THEN_STOP' as const,
  n14Activation: 'UNCHANGED' as const,
  logFields: Object.freeze([
    'event',
    'status',
    'failureCode',
    'batchSize',
    'recoveryBatchSize',
    'recovered',
    'retried',
    'deadLettered',
    'claimed',
    'projectedNew',
    'reviewRequired',
    'failed',
  ] as const),
});

export const LEAD_INTAKE_CONSUMER_CONFIGURATION_ERROR_CODES = Object.freeze([
  'VNX01_GATE_INVALID',
  'VNX01_CONFIG_INCOMPLETE',
  'VNX01_CONFIG_INVALID',
  'VNX01_WEBSITE_LEAD_MODE_UNSAFE',
] as const);

export type LeadIntakeConsumerConfigurationErrorCode =
  typeof LEAD_INTAKE_CONSUMER_CONFIGURATION_ERROR_CODES[number];

export class LeadIntakeConsumerConfigurationError extends Error {
  constructor(readonly code: LeadIntakeConsumerConfigurationErrorCode) {
    super(code);
    this.name = 'LeadIntakeConsumerConfigurationError';
  }
}

export type LeadIntakeConsumerConfig =
  | Readonly<{ enabled: false; status: 'GATE_CLOSED' }>
  | Readonly<{
    enabled: true;
    status: 'READY_FOR_PREFLIGHT';
    leaseOwnerId: string;
    batchSize: number;
    recoveryBatchSize: number;
    keyFilePath: string;
  }>;

export type LeadIntakeConsumerSummary = Readonly<{
  status: 'DISABLED' | 'COMPLETED' | 'STOPPED';
  recovered: number;
  retried: number;
  deadLettered: number;
  claimed: number;
  projectedNew: number;
  reviewRequired: number;
  failed: number;
}>;

export type LeadIntakeConsumerLogRecord =
  | Readonly<{ event: 'VNX01_CONSUMER_DISABLED'; status: 'DISABLED' }>
  | Readonly<{
    event: 'VNX01_CONSUMER_READY';
    status: 'READY';
    batchSize: number;
    recoveryBatchSize: number;
  }>
  | Readonly<{
    event: 'VNX01_EVENT_FAILED';
    failureCode: string;
  }>
  | Readonly<{
    event: 'VNX01_CONSUMER_COMPLETED';
    status: 'COMPLETED' | 'STOPPED';
    recovered: number;
    retried: number;
    deadLettered: number;
    claimed: number;
    projectedNew: number;
    reviewRequired: number;
    failed: number;
  }>
  | Readonly<{
    event: 'VNX01_CONSUMER_REJECTED';
    status: 'REJECTED';
    failureCode: string;
  }>;

export type LeadIntakeConsumerLogger = (record: LeadIntakeConsumerLogRecord) => void;

type ProjectionResult = Awaited<ReturnType<typeof projectClaimedLeadInboxEvent>>;

export type LeadIntakeConsumerOperations = Readonly<{
  assertReady: (config: Extract<LeadIntakeConsumerConfig, { enabled: true }>) => Promise<void>;
  recover: (maximumRows: number) => Promise<Readonly<{
    recovered: number;
    retried: number;
    deadLettered: number;
  }>>;
  claim: (leaseOwnerId: string) => Promise<BusinessQueueLease | null>;
  project: (
    lease: BusinessQueueLease,
    config: Extract<LeadIntakeConsumerConfig, { enabled: true }>,
  ) => Promise<ProjectionResult>;
}>;

type ConsumerEnvironment = Readonly<Record<string, string | undefined>>;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]{0,2}$/;

function configFail(code: LeadIntakeConsumerConfigurationErrorCode): never {
  throw new LeadIntakeConsumerConfigurationError(code);
}

function requiredExactValue(environment: ConsumerEnvironment, name: string) {
  const value = environment[name];
  if (!value) configFail('VNX01_CONFIG_INCOMPLETE');
  if (value !== value.trim()) configFail('VNX01_CONFIG_INVALID');
  return value;
}

function boundedInteger(value: string, maximum: number) {
  if (!POSITIVE_INTEGER_PATTERN.test(value)) configFail('VNX01_CONFIG_INVALID');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    configFail('VNX01_CONFIG_INVALID');
  }
  return parsed;
}

export function readLeadIntakeConsumerConfig(
  environment: ConsumerEnvironment = process.env,
): LeadIntakeConsumerConfig {
  const gate = environment[LEAD_INTAKE_CONSUMER_MANIFEST.gateEnvironment];
  if (gate === undefined || gate === '' || gate === '0') {
    return Object.freeze({ enabled: false, status: 'GATE_CLOSED' as const });
  }
  if (gate !== LEAD_INTAKE_CONSUMER_MANIFEST.enabledValue) {
    return configFail('VNX01_GATE_INVALID');
  }
  if (environment.WEBSITE_LEAD_MODE !== 'disabled') {
    return configFail('VNX01_WEBSITE_LEAD_MODE_UNSAFE');
  }
  const leaseOwnerId = requiredExactValue(
    environment,
    'VNX01_LEAD_INTAKE_LEASE_OWNER_ID',
  ).toLowerCase();
  if (!UUID_V4_PATTERN.test(leaseOwnerId)) configFail('VNX01_CONFIG_INVALID');
  const batchSize = boundedInteger(
    requiredExactValue(environment, 'VNX01_LEAD_INTAKE_BATCH_SIZE'),
    LEAD_INTAKE_CONSUMER_MANIFEST.maximumBatchSize,
  );
  const recoveryBatchSize = boundedInteger(
    requiredExactValue(environment, 'VNX01_LEAD_INTAKE_RECOVERY_BATCH_SIZE'),
    LEAD_INTAKE_CONSUMER_MANIFEST.maximumRecoveryBatchSize,
  );
  const keyFilePath = requiredExactValue(environment, 'LEAD_IDENTITY_KEY_FILE');
  return Object.freeze({
    enabled: true,
    status: 'READY_FOR_PREFLIGHT' as const,
    leaseOwnerId,
    batchSize,
    recoveryBatchSize,
    keyFilePath,
  });
}

export function safeLeadIntakeConsumerFailureCode(error: unknown) {
  if (error instanceof LeadIntakeConsumerConfigurationError
    || error instanceof LeadIdentityError
    || error instanceof LeadProjectionError
    || error instanceof BusinessEventBackboneError) {
    return error.code;
  }
  return 'VNX01_INTERNAL_FAILURE';
}

export function writeLeadIntakeConsumerLog(
  record: LeadIntakeConsumerLogRecord,
  stream: Pick<NodeJS.WriteStream, 'write'> = process.stdout,
) {
  stream.write(`${JSON.stringify(record)}\n`);
}

export function createPrismaLeadIntakeConsumerOperations(
  prisma: PrismaClient,
  options: Readonly<{ allowedSecretRoot?: string }> = {},
): LeadIntakeConsumerOperations {
  return Object.freeze({
    async assertReady(config) {
      const key = await readLeadIdentityKeyFile(config.keyFilePath, {
        allowedRoot: options.allowedSecretRoot,
      });
      await prisma.$transaction(async (tx) => {
        await assertLeadIdentityKeyConsensus(tx, key);
      });
    },
    recover(maximumRows) {
      return recoverExpiredBusinessQueueLeases(prisma, {
        queueKind: LEAD_INTAKE_CONSUMER_MANIFEST.queueKind,
        maximumRows,
      });
    },
    claim(leaseOwnerId) {
      return claimBusinessQueueEvent(prisma, {
        queueKind: LEAD_INTAKE_CONSUMER_MANIFEST.queueKind,
        leaseOwnerId,
      });
    },
    project(lease, config) {
      return projectClaimedLeadInboxEvent(prisma, lease, {
        keyFilePath: config.keyFilePath,
        allowedSecretRoot: options.allowedSecretRoot,
      });
    },
  });
}

function emptySummary<T extends LeadIntakeConsumerSummary['status']>(status: T) {
  return Object.freeze({
    status,
    recovered: 0,
    retried: 0,
    deadLettered: 0,
    claimed: 0,
    projectedNew: 0,
    reviewRequired: 0,
    failed: 0,
  });
}

export async function runLeadIntakeConsumer(
  operations: LeadIntakeConsumerOperations,
  options: Readonly<{
    environment?: ConsumerEnvironment;
    signal?: AbortSignal;
    logger?: LeadIntakeConsumerLogger;
  }> = {},
): Promise<LeadIntakeConsumerSummary> {
  const logger = options.logger ?? writeLeadIntakeConsumerLog;
  const config = readLeadIntakeConsumerConfig(options.environment);
  if (!config.enabled) {
    const summary = emptySummary('DISABLED');
    logger(Object.freeze({ event: 'VNX01_CONSUMER_DISABLED', status: summary.status }));
    return summary;
  }
  if (options.signal?.aborted) {
    const summary = emptySummary('STOPPED');
    logger(Object.freeze({ event: 'VNX01_CONSUMER_COMPLETED', ...summary }));
    return summary;
  }
  await operations.assertReady(config);
  logger(Object.freeze({
    event: 'VNX01_CONSUMER_READY',
    status: 'READY',
    batchSize: config.batchSize,
    recoveryBatchSize: config.recoveryBatchSize,
  }));
  if (options.signal?.aborted) {
    const summary = emptySummary('STOPPED');
    logger(Object.freeze({ event: 'VNX01_CONSUMER_COMPLETED', ...summary }));
    return summary;
  }
  const recovery = await operations.recover(config.recoveryBatchSize);
  let claimed = 0;
  let projectedNew = 0;
  let reviewRequired = 0;
  let failed = 0;
  for (let index = 0; index < config.batchSize; index += 1) {
    if (options.signal?.aborted) break;
    const lease = await operations.claim(config.leaseOwnerId);
    if (!lease) break;
    claimed += 1;
    try {
      const projected = await operations.project(lease, config);
      if (projected.result.state === 'PROJECTED_NEW') projectedNew += 1;
      else if (projected.result.state === 'REVIEW_REQUIRED') reviewRequired += 1;
    } catch (error) {
      failed += 1;
      logger(Object.freeze({
        event: 'VNX01_EVENT_FAILED',
        failureCode: safeLeadIntakeConsumerFailureCode(error),
      }));
    }
  }
  const status = options.signal?.aborted ? 'STOPPED' : 'COMPLETED';
  const summary = Object.freeze({
    status,
    recovered: recovery.recovered,
    retried: recovery.retried,
    deadLettered: recovery.deadLettered,
    claimed,
    projectedNew,
    reviewRequired,
    failed,
  });
  logger(Object.freeze({ event: 'VNX01_CONSUMER_COMPLETED', ...summary }));
  return summary;
}
