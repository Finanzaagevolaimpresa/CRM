import type { Prisma, PrismaClient } from '@prisma/client';
import { UserFacingActionError } from './action-errors';
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
  permit: ExternalAiPermit;
};

declare const externalAiPermitBrand: unique symbol;
export type ExternalAiPermit = { readonly [externalAiPermitBrand]: true };
const activeExternalAiPermits = new WeakMap<object, { model: string }>();

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

function issueExternalAiPermit(model: string): ExternalAiPermit {
  const permit = Object.freeze({}) as ExternalAiPermit;
  activeExternalAiPermits.set(permit, { model });
  return permit;
}

/** Runtime-only, single-use egress capability. A fabricated or reused object is rejected. */
export function consumeExternalAiPermit(
  permit: ExternalAiPermit | null | undefined,
  expectedModel: string,
) {
  if (!permit || typeof permit !== 'object') {
    throw new AiControlPlaneError(
      'invalid_runtime_permit',
      'Autorizzazione runtime per il provider AI esterno assente.',
    );
  }
  const claims = activeExternalAiPermits.get(permit);
  const normalizedModel = expectedModel.trim();
  if (!claims || !normalizedModel || claims.model !== normalizedModel) {
    throw new AiControlPlaneError(
      'invalid_runtime_permit',
      'Autorizzazione runtime per il provider AI esterno non valida.',
    );
  }
  activeExternalAiPermits.delete(permit);
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
  const now = options.now ?? new Date();
  if (options.permissionGranted !== true) {
    throw new AiControlPlaneError(
      'permission_required',
      'Il permesso ai.external.run è obbligatorio per usare provider AI esterni.',
    );
  }
  const policy = await getAiControlPolicy({ db, env: options.env });
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
    permit: issueExternalAiPermit(model),
  };
}
