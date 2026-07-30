export const AI_ORCHESTRATOR_MANUAL_AUTHORIZATION_CONTRACT_V1 = Object.freeze({
  schemaVersion: 1,
  activationEpoch: 'FOUNDATION_LOCKED_V1',
  operational: false,
  productionConsumer: 'NONE',
  requiresAuthorizationAt: Object.freeze(['ADMISSION', 'CLAIM', 'EXECUTION'] as const),
  requiredBinding: Object.freeze([
    'requestId',
    'authorizationGrantId',
    'inputFingerprint',
    'agentId',
    'agentConfigVersion',
    'provider',
    'model',
    'purposeCode',
    'expiresAt',
  ] as const),
  grantMode: 'IMMUTABLE_SINGLE_USE',
  canAcceptLease: false,
} as const);

export type AiOrchestratorManualAuthorizationBindingV1 = Readonly<{
  requestId: string;
  authorizationGrantId: string;
  inputFingerprint: string;
  agentId: string;
  agentConfigVersion: number;
  provider: string;
  model: string | null;
  purposeCode: string;
  expiresAt: Date;
}>;

/**
 * Foundation validator for any future Orchestrator admission path. PR85 does
 * not expose a consumer: the database consumption boundary remains the only
 * component allowed to turn a valid grant into an AiRun.
 */
export function assertAiOrchestratorManualAuthorizationBindingV1(
  binding: AiOrchestratorManualAuthorizationBindingV1 | null | undefined,
  now = new Date(),
) {
  if (
    !binding
    || !binding.requestId
    || !binding.authorizationGrantId
    || !/^[a-f0-9]{64}$/u.test(binding.inputFingerprint)
    || !binding.agentId
    || !Number.isSafeInteger(binding.agentConfigVersion)
    || binding.agentConfigVersion < 1
    || !binding.provider
    || !binding.purposeCode
    || !(binding.expiresAt instanceof Date)
    || Number.isNaN(binding.expiresAt.getTime())
    || binding.expiresAt <= now
  ) {
    throw new Error('AI_EXECUTION_AUTHORIZATION_REQUIRED');
  }
  return Object.freeze({ ...binding });
}
