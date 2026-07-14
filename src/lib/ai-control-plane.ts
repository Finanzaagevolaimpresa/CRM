import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { UserFacingActionError } from './action-errors';
import {
  AI_RUN_RELIABILITY_VERSION,
  assertSha256,
  canonicalSha256,
  getAiRunLeaseBinding,
  sha256,
  type AiRunLease,
} from './ai-run-reliability';
import { prisma } from './prisma';

export const AI_CONTROL_SETTING_ID = 'global' as const;
export const DEFAULT_MAX_EXTERNAL_RUNS_PER_USER_PER_HOUR = 10;

/**
 * Stable, auditable categories describing the minimum data sent to an
 * external AI provider. Persist these codes, not free-form labels.
 */
export const AI_EXTERNAL_DATA_CATEGORIES = [
  'agent_configuration',
  'client_profile',
  'company_profile',
  'financial_data',
  'project_data',
  'service_context',
  'document_metadata',
  'checklist_status',
  'task_metadata',
  'operator_instructions',
] as const;

export type ExternalAiDataCategory = (typeof AI_EXTERNAL_DATA_CATEGORIES)[number];

export type AiControlPolicy = {
  environmentEnabled: boolean;
  databaseEnabled: boolean;
  effectiveExternalProvidersEnabled: boolean;
  allowedModels: readonly string[];
  maxExternalRunsPerUserPerHour: number;
  updatedById: string | null;
  updatedAt: Date | null;
};

export type ExternalAiAuthorization = AiControlPolicy & {
  dataCategories: readonly ExternalAiDataCategory[];
  externalRunsInCurrentWindow: number;
  rateWindowStartedAt: Date;
};

declare const externalAiPermitBrand: unique symbol;
export type ExternalAiPermit = { readonly [externalAiPermitBrand]: true };
declare const externalAiPermitSeedBrand: unique symbol;
export type ExternalAiPermitSeed = { readonly [externalAiPermitSeedBrand]: true };

type ExternalAiPermitSeedClaims = { secret: string; permitHash: string };
type ExternalAiPermitClaims = {
  runId: string;
  userId: string;
  requestKey: string;
  requestFingerprint: string;
  agentId: string;
  agentConfigVersion: number;
  model: string;
  dataCategories: readonly ExternalAiDataCategory[];
  externalPayloadHash: string;
  leaseTokenHash: string;
  leaseExpiresAt: Date;
  permitSecret: string;
  permitHash: string;
};

const pendingExternalAiPermits = new WeakMap<object, ExternalAiPermitSeedClaims>();
const activeExternalAiPermits = new WeakMap<object, ExternalAiPermitClaims>();

/** Pass the active transaction client to keep policy/rate checks and AiRun
 * creation in one Serializable transaction. */
export type AiControlPlaneDb =
  | Pick<PrismaClient, 'aiControlSetting' | 'aiRun'>
  | Pick<Prisma.TransactionClient, 'aiControlSetting' | 'aiRun'>;

export class AiControlPlaneError extends UserFacingActionError {
  constructor(
    public readonly code:
      | 'external_providers_disabled'
      | 'permission_required'
      | 'model_allowlist_empty'
      | 'model_not_allowed'
      | 'confirmation_required'
      | 'invalid_data_category'
      | 'data_categories_required'
      | 'rate_limit_exceeded'
      | 'invalid_rate_limit'
      | 'invalid_runtime_permit',
    message: string,
  ) {
    super(message);
    this.name = 'AiControlPlaneError';
  }
}

export function prepareExternalAiPermit(): {
  seed: ExternalAiPermitSeed;
  egressPermitHash: string;
} {
  const secret = randomBytes(32).toString('base64url');
  const permitHash = sha256(secret);
  const seed = Object.freeze({}) as ExternalAiPermitSeed;
  pendingExternalAiPermits.set(seed, { secret, permitHash });
  return { seed, egressPermitHash: permitHash };
}

function invalidRuntimePermit(message = 'Autorizzazione runtime per il provider AI esterno non valida.'): never {
  throw new AiControlPlaneError('invalid_runtime_permit', message);
}

function jsonStringArray(value: Prisma.JsonValue | null): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[]
    : null;
}

/** Emit the opaque permit only after the matching AiRun reservation exists. */
export async function issueExternalAiPermit(options: {
  seed: ExternalAiPermitSeed;
  lease: AiRunLease;
  runId: string;
  userId: string;
  requestKey: string;
  requestFingerprint: string;
  agentId: string;
  agentConfigVersion: number;
  model: string;
  dataCategories: readonly string[];
  externalPayloadHash: string;
  db?: AiControlPlaneDb;
}): Promise<ExternalAiPermit> {
  if (!options.seed || typeof options.seed !== 'object') invalidRuntimePermit();
  const pending = pendingExternalAiPermits.get(options.seed);
  pendingExternalAiPermits.delete(options.seed);
  if (!pending) invalidRuntimePermit();

  const db = options.db ?? prisma;
  const model = options.model.trim();
  const requestFingerprint = assertSha256(options.requestFingerprint, 'Fingerprint richiesta');
  const externalPayloadHash = assertSha256(options.externalPayloadHash, 'Hash payload esterno');
  const dataCategories = normalizeExternalDataCategories(options.dataCategories);
  const lease = getAiRunLeaseBinding(options.lease);
  if (
    !model
    || options.runId !== lease.runId
    || !Number.isInteger(options.agentConfigVersion)
    || options.agentConfigVersion < 1
  ) invalidRuntimePermit();

  const reserved = await db.aiRun.findFirst({
    where: {
      id: options.runId,
      reliabilityVersion: AI_RUN_RELIABILITY_VERSION,
      status: 'running',
      createdById: options.userId,
      requestKey: options.requestKey,
      requestFingerprint,
      agentId: options.agentId,
      agentConfigVersion: options.agentConfigVersion,
      provider: 'openai',
      model,
      leaseTokenHash: lease.leaseTokenHash,
      leaseExpiresAt: lease.leaseExpiresAt,
      egressPermitHash: pending.permitHash,
      egressStartedAt: null,
      externalPayloadHash,
      externalConfirmedAt: { not: null },
    },
    select: { externalDataCategories: true },
  });
  const persistedCategories = reserved ? jsonStringArray(reserved.externalDataCategories) : null;
  if (!persistedCategories || canonicalSha256(persistedCategories) !== canonicalSha256(dataCategories)) {
    invalidRuntimePermit();
  }

  const permit = Object.freeze({}) as ExternalAiPermit;
  activeExternalAiPermits.set(permit, {
    runId: options.runId,
    userId: options.userId,
    requestKey: options.requestKey,
    requestFingerprint,
    agentId: options.agentId,
    agentConfigVersion: options.agentConfigVersion,
    model,
    dataCategories,
    externalPayloadHash,
    leaseTokenHash: lease.leaseTokenHash,
    leaseExpiresAt: lease.leaseExpiresAt,
    permitSecret: pending.secret,
    permitHash: pending.permitHash,
  });
  return permit;
}

async function consumeExternalAiPermitWithDb(
  claims: ExternalAiPermitClaims,
  expectedPayloadHash: string,
  now: Date,
  db: AiControlPlaneDb,
  env: NodeJS.ProcessEnv,
) {
  await assertExternalEgressStillAllowed(claims, db, env);
  if (claims.leaseExpiresAt.getTime() <= now.getTime()) invalidRuntimePermit('Autorizzazione runtime AI scaduta.');
  const updated = await db.aiRun.updateMany({
    where: {
      id: claims.runId,
      reliabilityVersion: AI_RUN_RELIABILITY_VERSION,
      status: 'running',
      createdById: claims.userId,
      requestKey: claims.requestKey,
      requestFingerprint: claims.requestFingerprint,
      agentId: claims.agentId,
      agentConfigVersion: claims.agentConfigVersion,
      provider: 'openai',
      model: claims.model,
      leaseTokenHash: claims.leaseTokenHash,
      leaseExpiresAt: { gt: now },
      egressPermitHash: claims.permitHash,
      egressStartedAt: null,
      externalPayloadHash: expectedPayloadHash,
      externalDataCategories: { equals: [...claims.dataCategories] },
    },
    data: { egressPermitHash: null, egressStartedAt: now },
  });
  if (updated.count !== 1) invalidRuntimePermit();
}

async function assertExternalEgressStillAllowed(
  claims: ExternalAiPermitClaims,
  db: AiControlPlaneDb,
  env: NodeJS.ProcessEnv,
) {
  const policy = await getAiControlPolicy({ db, env });
  if (!policy.effectiveExternalProvidersEnabled || !policy.allowedModels.includes(claims.model)) {
    throw new AiControlPlaneError(
      'external_providers_disabled',
      'Il provider AI esterno è stato disabilitato prima dell’uscita dei dati.',
    );
  }
}

async function lockAndAssertExternalEgressStillAllowed(
  claims: ExternalAiPermitClaims,
  db: Prisma.TransactionClient,
  env: NodeJS.ProcessEnv,
) {
  const settings = await db.$queryRaw<Array<{ externalProvidersEnabled: boolean }>>(Prisma.sql`
    SELECT "externalProvidersEnabled"
    FROM "AiControlSetting"
    WHERE "id" = ${AI_CONTROL_SETTING_ID}
    FOR SHARE
  `);
  if (
    !isExternalProviderEnvironmentEnabled(env)
    || settings.length !== 1
    || settings[0].externalProvidersEnabled !== true
    || !isExternalModelAllowed(claims.model, env)
  ) {
    throw new AiControlPlaneError(
      'external_providers_disabled',
      'Il provider AI esterno è stato disabilitato prima dell’uscita dei dati.',
    );
  }
}

async function consumeExternalAiPermitWithTransaction(
  claims: ExternalAiPermitClaims,
  expectedPayloadHash: string,
  db: Prisma.TransactionClient,
  env: NodeJS.ProcessEnv,
) {
  await lockAndAssertExternalEgressStillAllowed(claims, db, env);
  const categoriesJson = JSON.stringify([...claims.dataCategories]);
  const updated = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "AiRun"
    SET
      "egressPermitHash" = NULL,
      "egressStartedAt" = clock_timestamp() AT TIME ZONE 'UTC'
    WHERE
      "id" = ${claims.runId}
      AND "reliabilityVersion" = ${AI_RUN_RELIABILITY_VERSION}
      AND "status" = 'running'
      AND "createdById" = ${claims.userId}
      AND "requestKey" = ${claims.requestKey}
      AND "requestFingerprint" = ${claims.requestFingerprint}
      AND "agentId" = ${claims.agentId}
      AND "agentConfigVersion" = ${claims.agentConfigVersion}
      AND "provider" = 'openai'
      AND "model" = ${claims.model}
      AND "leaseTokenHash" = ${claims.leaseTokenHash}
      AND "leaseExpiresAt" = ${claims.leaseExpiresAt}
      AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      AND "egressPermitHash" = ${claims.permitHash}
      AND "egressStartedAt" IS NULL
      AND "externalPayloadHash" = ${expectedPayloadHash}
      AND "externalDataCategories" = CAST(${categoriesJson} AS jsonb)
    RETURNING "id"
  `);
  if (updated.length !== 1) invalidRuntimePermit();
}

/** DB-bound, one-shot egress capability. The CAS is the final awaited step before fetch. */
export async function consumeExternalAiPermit(
  permit: ExternalAiPermit | null | undefined,
  expectedModel: string,
  exactOutboundBody: unknown,
  options: { db?: AiControlPlaneDb; env?: NodeJS.ProcessEnv; now?: Date } = {},
) {
  if (!permit || typeof permit !== 'object') {
    invalidRuntimePermit('Autorizzazione runtime per il provider AI esterno assente.');
  }
  const claims = activeExternalAiPermits.get(permit);
  // Delete synchronously before the first await so two concurrent consumers
  // cannot both reach the database with the same in-memory capability.
  activeExternalAiPermits.delete(permit);
  const model = expectedModel.trim();
  const expectedPayloadHash = canonicalSha256(exactOutboundBody);
  if (!claims || !model || claims.model !== model || claims.externalPayloadHash !== expectedPayloadHash) {
    invalidRuntimePermit();
  }
  if (sha256(claims.permitSecret) !== claims.permitHash) invalidRuntimePermit();

  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  if (options.db) {
    if (env.NODE_ENV !== 'test') invalidRuntimePermit();
    await consumeExternalAiPermitWithDb(claims, expectedPayloadHash, now, options.db, env);
    return;
  }
  await prisma.$transaction(
    (tx) => consumeExternalAiPermitWithTransaction(claims, expectedPayloadHash, tx, env),
    { isolationLevel: 'Serializable' },
  );
}

export function isExternalProviderEnvironmentEnabled(
  env: NodeJS.ProcessEnv = process.env,
) {
  return env.AI_EXTERNAL_PROVIDERS_ENABLED === 'true';
}

export function getAllowedExternalModels(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const unique = new Set(
    (env.AI_ALLOWED_MODELS ?? '')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),
  );
  return [...unique];
}

export function isExternalModelAllowed(
  model: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const normalized = model?.trim();
  if (!normalized) return false;
  const allowedModels = getAllowedExternalModels(env);
  return allowedModels.length > 0 && allowedModels.includes(normalized);
}

export function normalizeExternalDataCategories(
  values: readonly string[],
): readonly ExternalAiDataCategory[] {
  const known = new Set<string>(AI_EXTERNAL_DATA_CATEGORIES);
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];

  if (!normalized.length) {
    throw new AiControlPlaneError(
      'data_categories_required',
      'Indicare le categorie minime di dati trasmesse al provider AI esterno.',
    );
  }

  const unknown = normalized.find((value) => !known.has(value));
  if (unknown) {
    throw new AiControlPlaneError(
      'invalid_data_category',
      `Categoria dati esterna non ammessa: ${unknown}.`,
    );
  }

  return normalized as ExternalAiDataCategory[];
}

export async function getAiControlPolicy(options: {
  db?: AiControlPlaneDb;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<AiControlPolicy> {
  const db = options.db ?? prisma;
  const env = options.env ?? process.env;
  const setting = await db.aiControlSetting.findUnique({
    where: { id: AI_CONTROL_SETTING_ID },
    select: {
      externalProvidersEnabled: true,
      maxExternalRunsPerUserPerHour: true,
      updatedById: true,
      updatedAt: true,
    },
  });
  const environmentEnabled = isExternalProviderEnvironmentEnabled(env);
  const databaseEnabled = setting?.externalProvidersEnabled === true;
  const configuredRate = setting?.maxExternalRunsPerUserPerHour
    ?? DEFAULT_MAX_EXTERNAL_RUNS_PER_USER_PER_HOUR;
  const rateIsValid = Number.isInteger(configuredRate)
    && configuredRate >= 1
    && configuredRate <= 1000;

  return {
    environmentEnabled,
    databaseEnabled,
    effectiveExternalProvidersEnabled:
      environmentEnabled && databaseEnabled && rateIsValid,
    allowedModels: getAllowedExternalModels(env),
    maxExternalRunsPerUserPerHour: configuredRate,
    updatedById: setting?.updatedById ?? null,
    updatedAt: setting?.updatedAt ?? null,
  };
}

async function databaseUtcNow(db: AiControlPlaneDb) {
  if (!(('$queryRaw' as keyof typeof db) in db)) {
    throw new AiControlPlaneError('invalid_runtime_permit', 'Orologio database AI non disponibile.');
  }
  const rows = await (db as Prisma.TransactionClient).$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new AiControlPlaneError('invalid_runtime_permit', 'Orologio database AI non disponibile.');
  }
  return now;
}

export async function assertExternalAiRunAllowed(options: {
  userId: string;
  permissionGranted: boolean;
  model: string;
  dataCategories: readonly string[];
  confirmedAt: Date | null | undefined;
  now?: Date;
  db?: AiControlPlaneDb;
  env?: NodeJS.ProcessEnv;
}): Promise<ExternalAiAuthorization> {
  const db = options.db ?? prisma;
  const env = options.env ?? process.env;
  if (options.now && env.NODE_ENV !== 'test') {
    throw new AiControlPlaneError('invalid_runtime_permit', 'Override orologio AI non consentito.');
  }
  const now = options.now ?? await databaseUtcNow(db);
  if (options.permissionGranted !== true) {
    throw new AiControlPlaneError(
      'permission_required',
      'Il permesso ai.external.run è obbligatorio per usare provider AI esterni.',
    );
  }
  const policy = await getAiControlPolicy({ db, env });
  if (
    !Number.isInteger(policy.maxExternalRunsPerUserPerHour)
    || policy.maxExternalRunsPerUserPerHour < 1
    || policy.maxExternalRunsPerUserPerHour > 1000
  ) {
    throw new AiControlPlaneError(
      'invalid_rate_limit',
      'Limite orario dei provider AI esterni non valido: esecuzione bloccata.',
    );
  }
  if (!policy.environmentEnabled || !policy.databaseEnabled) {
    throw new AiControlPlaneError(
      'external_providers_disabled',
      'I provider AI esterni non sono abilitati sia nell’ambiente sia nel pannello di controllo.',
    );
  }
  if (!policy.allowedModels.length) {
    throw new AiControlPlaneError(
      'model_allowlist_empty',
      'Nessun modello AI esterno è autorizzato dalla configurazione server.',
    );
  }
  const model = options.model.trim();
  if (!model || !policy.allowedModels.includes(model)) {
    throw new AiControlPlaneError(
      'model_not_allowed',
      'Il modello AI richiesto non è presente nella allowlist server.',
    );
  }
  if (
    !(options.confirmedAt instanceof Date)
    || Number.isNaN(options.confirmedAt.getTime())
    || options.confirmedAt.getTime() > now.getTime()
  ) {
    throw new AiControlPlaneError(
      'confirmation_required',
      'È richiesta una conferma esplicita prima di trasmettere dati al provider AI esterno.',
    );
  }

  const dataCategories = normalizeExternalDataCategories(options.dataCategories);
  const rateWindowStartedAt = new Date(now.getTime() - 60 * 60 * 1000);
  const externalRunsInCurrentWindow = await db.aiRun.count({
    where: {
      createdById: options.userId,
      externalConfirmedAt: { not: null },
      createdAt: { gte: rateWindowStartedAt },
    },
  });
  if (externalRunsInCurrentWindow >= policy.maxExternalRunsPerUserPerHour) {
    throw new AiControlPlaneError(
      'rate_limit_exceeded',
      'Limite orario personale per le esecuzioni AI esterne raggiunto.',
    );
  }

  return {
    ...policy,
    dataCategories,
    externalRunsInCurrentWindow,
    rateWindowStartedAt,
  };
}
