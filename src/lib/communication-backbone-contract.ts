import { canonicalJson, sha256 } from './canonical-json';
import { assertClassifiedFields } from './data-classification';

export const COMMUNICATION_INTENT_SCHEMA_VERSION = 'fai.communication-intent.v1' as const;
export const COMMUNICATION_INTENT_TYPE = 'COMMUNICATION_INTENT' as const;
export const COMMUNICATION_INTENT_VERSION = 1 as const;
export const COMMUNICATION_INTENT_CANONICALIZATION_VERSION = 1 as const;
export const MAX_COMMUNICATION_INTENT_BYTES = 8 * 1024;

export const COMMUNICATION_MESSAGE_CLASSES = Object.freeze([
  'TRANSACTIONAL',
  'SERVICE',
  'SECURITY',
] as const);

export const COMMUNICATION_RECIPIENT_ENTITY_TYPES = Object.freeze([
  'LEAD',
  'CLIENT',
  'PERSON',
  'COMPANY',
  'USER',
] as const);

export const COMMUNICATION_INTENT_STATES = Object.freeze(['RECORDED', 'HELD'] as const);

export const COMMUNICATION_GATE_CODES = Object.freeze([
  'CAPABILITY',
  'WORKER',
  'DISPATCH',
  'EGRESS',
  'CHANNEL',
  'PROVIDER',
  'TENANT',
] as const);

export const COMMUNICATION_GATE_STATES = Object.freeze([
  'ENABLED',
  'DISABLED',
  'MISSING',
  'ERROR',
] as const);

export const COMMUNICATION_GATE_REASON_CODES = Object.freeze([
  'N15_GATE_ERROR',
  'N15_GATE_MISSING',
  'N15_GATE_DISABLED',
  'N15_PHASE1A_DORMANT',
] as const);

export const COMMUNICATION_INTENT_CONTRACT_ERRORS = Object.freeze([
  'COMMUNICATION_INTENT_ENVELOPE_INVALID',
  'COMMUNICATION_INTENT_SCHEMA_UNSUPPORTED',
  'COMMUNICATION_INTENT_TYPE_UNSUPPORTED',
  'COMMUNICATION_INTENT_VERSION_UNSUPPORTED',
  'COMMUNICATION_INTENT_FIELD_UNKNOWN',
  'COMMUNICATION_INTENT_FIELD_INVALID',
  'COMMUNICATION_INTENT_CLASS_UNSUPPORTED',
  'COMMUNICATION_INTENT_RECIPIENT_INVALID',
  'COMMUNICATION_INTENT_TEMPLATE_INVALID',
  'COMMUNICATION_INTENT_POLICY_INVALID',
  'COMMUNICATION_INTENT_HASH_INVALID',
  'COMMUNICATION_INTENT_TOO_LARGE',
  'COMMUNICATION_INTENT_GATE_SNAPSHOT_INVALID',
  'COMMUNICATION_INTENT_STATE_TRANSITION_INVALID',
  'COMMUNICATION_INTENT_AUDIT_INVALID',
  'COMMUNICATION_INTENT_IDEMPOTENCY_CONFLICT',
  'COMMUNICATION_INTENT_INTERNAL_FAILURE',
] as const);

export type CommunicationMessageClass = typeof COMMUNICATION_MESSAGE_CLASSES[number];
export type CommunicationRecipientEntityType = typeof COMMUNICATION_RECIPIENT_ENTITY_TYPES[number];
export type CommunicationIntentState = typeof COMMUNICATION_INTENT_STATES[number];
export type CommunicationGateCode = typeof COMMUNICATION_GATE_CODES[number];
export type CommunicationGateState = typeof COMMUNICATION_GATE_STATES[number];
export type CommunicationGateReasonCode = typeof COMMUNICATION_GATE_REASON_CODES[number];
export type CommunicationIntentContractErrorCode = typeof COMMUNICATION_INTENT_CONTRACT_ERRORS[number];

export class CommunicationIntentContractError extends Error {
  constructor(readonly code: CommunicationIntentContractErrorCode) {
    super(code);
    this.name = 'CommunicationIntentContractError';
  }
}

export interface CommunicationIntentSourceInputV1 {
  readonly producerCode: string;
  readonly callerIdempotencyKey: string;
}

export interface CommunicationIntentSourceV1 {
  readonly producerCode: string;
}

export interface CommunicationRecipientReferenceV1 {
  readonly authorityCode: 'CRM';
  readonly entityType: CommunicationRecipientEntityType;
  readonly entityId: string;
}

export interface CommunicationTemplateReferenceV1 {
  readonly templateCode: string;
  readonly templateVersion: string;
  readonly templateHash: string;
}

export interface CommunicationMessageReferenceV1 {
  readonly messageClass: CommunicationMessageClass;
  readonly reasonCode: string;
  readonly templateReference: CommunicationTemplateReferenceV1;
}

export interface CommunicationPolicySnapshotV1 {
  readonly policyReferenceCode: 'N15_PHASE1A_UNASSIGNED';
  readonly policyVersion: 'UNASSIGNED';
  readonly decision: 'NOT_EVALUATED';
  readonly reasonCode: 'N15_POLICY_UNASSIGNED';
}

export interface CommunicationIntentIdempotencyV1 {
  readonly canonicalizationVersion: typeof COMMUNICATION_INTENT_CANONICALIZATION_VERSION;
  readonly keyDigest: string;
  readonly semanticHash: string;
  readonly envelopeHash: string;
}

export interface CommunicationIntentV1 {
  readonly schemaVersion: typeof COMMUNICATION_INTENT_SCHEMA_VERSION;
  readonly intentType: typeof COMMUNICATION_INTENT_TYPE;
  readonly intentVersion: typeof COMMUNICATION_INTENT_VERSION;
  readonly intentId: string;
  readonly businessCorrelationId: string;
  readonly occurredAt: string;
  readonly source: CommunicationIntentSourceV1;
  readonly recipient: CommunicationRecipientReferenceV1;
  readonly message: CommunicationMessageReferenceV1;
  readonly policySnapshot: CommunicationPolicySnapshotV1;
  readonly state: 'RECORDED';
  readonly idempotency: CommunicationIntentIdempotencyV1;
}

export interface CommunicationIntentInputV1 {
  readonly intentId: string;
  readonly businessCorrelationId: string;
  readonly occurredAt: string;
  readonly source: CommunicationIntentSourceInputV1;
  readonly recipient: CommunicationRecipientReferenceV1;
  readonly message: CommunicationMessageReferenceV1;
}

export type CommunicationGateValuesV1 = Readonly<Record<CommunicationGateCode, CommunicationGateState>>;

export interface CommunicationGateSnapshotV1 {
  readonly schemaVersion: 'fai.communication-gate-snapshot.v1';
  readonly snapshotVersion: 1;
  readonly evaluationModel: 'HIERARCHICAL_ALL_OF';
  readonly gates: CommunicationGateValuesV1;
  readonly allOfSatisfied: boolean;
  readonly decision: 'HELD';
  readonly reasonCode: CommunicationGateReasonCode;
}

export interface CommunicationHeldDecisionV1 {
  readonly schemaVersion: 'fai.communication-held-decision.v1';
  readonly decisionType: 'COMMUNICATION_INTENT_HELD';
  readonly decisionVersion: 1;
  readonly intentId: string;
  readonly businessCorrelationId: string;
  readonly intentSemanticHash: string;
  readonly intentEnvelopeHash: string;
  readonly evaluatedAt: string;
  readonly fromState: 'RECORDED';
  readonly toState: 'HELD';
  readonly policySnapshot: CommunicationPolicySnapshotV1;
  readonly gateSnapshot: CommunicationGateSnapshotV1;
  readonly reasonCode: CommunicationGateReasonCode;
  readonly decisionHash: string;
}

export interface CommunicationAuditRecordV1 {
  readonly schemaVersion: 'fai.communication-audit-record.v1';
  readonly recordType: 'COMMUNICATION_INTENT_HELD';
  readonly recordVersion: 1;
  readonly intentReferenceHash: string;
  readonly correlationReferenceHash: string;
  readonly sourceReferenceHash: string;
  readonly recipientReferenceHash: string;
  readonly templateReferenceHash: string;
  readonly communicationClassCode: CommunicationMessageClass;
  readonly intentReasonReferenceHash: string;
  readonly policyReferenceCode: 'N15_PHASE1A_UNASSIGNED';
  readonly policyReasonCode: 'N15_POLICY_UNASSIGNED';
  readonly gateSnapshotHash: string;
  readonly gateReasonCode: CommunicationGateReasonCode;
  readonly fromState: 'RECORDED';
  readonly toState: 'HELD';
  readonly idempotencyKeyHash: string;
  readonly semanticHash: string;
  readonly envelopeHash: string;
  readonly decisionHash: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

export const COMMUNICATION_INTENT_MANIFEST = deepFreeze({
  schemaVersion: COMMUNICATION_INTENT_SCHEMA_VERSION,
  mode: 'CONTRACT_ONLY',
  direction: 'OUTBOUND',
  dormant: true,
  activation: 'NONE',
  persistence: 'NONE',
  n11Adapter: 'NONE',
  transport: 'NONE',
  providers: Object.freeze([] as string[]),
  runtimeProducers: Object.freeze([] as string[]),
  runtimeConsumers: Object.freeze([] as string[]),
  recipientAuthority: 'CRM_REFERENCE_ONLY',
  recipientResolution: 'NONE',
  recipientEndpointSnapshot: 'NONE',
  body: 'NONE',
  marketingAllowed: false,
  workerAllowed: false,
  dispatchAllowed: false,
  networkEgressAllowed: false,
  gateEvaluation: 'HIERARCHICAL_ALL_OF',
  phase1AlwaysHeld: true,
  dataMode: 'SYNTHETIC_OR_REFERENCE_ONLY',
  messageClasses: COMMUNICATION_MESSAGE_CLASSES,
} as const);

export const COMMUNICATION_POLICY_SNAPSHOT_V1 = deepFreeze({
  policyReferenceCode: 'N15_PHASE1A_UNASSIGNED',
  policyVersion: 'UNASSIGNED',
  decision: 'NOT_EVALUATED',
  reasonCode: 'N15_POLICY_UNASSIGNED',
} as const satisfies CommunicationPolicySnapshotV1);

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CUID_V1_PATTERN = /^c[a-z0-9]{24}$/;
const CONTRACT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,119}$/;
const CONTRACT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const CALLER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RFC3339_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_TEXT_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

function fail(code: CommunicationIntentContractErrorCode): never {
  throw new CommunicationIntentContractError(code);
}

function readPlainRecord(value: unknown, invalidCode: CommunicationIntentContractErrorCode) {
  if (value === null || typeof value !== 'object') fail(invalidCode);
  let array: boolean;
  let prototype: object | null;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return fail(invalidCode);
  }
  if (array) fail(invalidCode);
  if (prototype !== Object.prototype && prototype !== null) fail(invalidCode);
  return value as Record<string, unknown>;
}

function readRequiredDataField(
  value: Record<string, unknown>,
  key: string,
  invalidCode: CommunicationIntentContractErrorCode,
) {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return fail(invalidCode);
  }
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    fail(invalidCode);
  }
  return descriptor.value;
}

function readExactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  invalidCode: CommunicationIntentContractErrorCode,
  unknownCode: CommunicationIntentContractErrorCode = 'COMMUNICATION_INTENT_FIELD_UNKNOWN',
) {
  const record = readPlainRecord(value, invalidCode);
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(record);
  } catch {
    return fail(invalidCode);
  }
  const allowedKeys = new Set(allowed);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      fail(unknownCode);
    }
    output[key] = readRequiredDataField(record, key, invalidCode);
  }
  for (const key of required) {
    if (!Object.hasOwn(output, key)) fail(invalidCode);
  }
  return output;
}

function normalizedText(
  value: unknown,
  maximum: number,
  invalidCode: CommunicationIntentContractErrorCode,
) {
  if (typeof value !== 'string') fail(invalidCode);
  let normalized: string;
  try {
    normalized = value.normalize('NFC').trim();
  } catch {
    return fail(invalidCode);
  }
  if (normalized.length === 0
    || normalized.length > maximum
    || FORBIDDEN_TEXT_PATTERN.test(normalized)) {
    fail(invalidCode);
  }
  return normalized;
}

function normalizedContractCode(
  value: unknown,
  invalidCode: CommunicationIntentContractErrorCode = 'COMMUNICATION_INTENT_FIELD_INVALID',
) {
  const normalized = normalizedText(value, 120, invalidCode);
  if (!CONTRACT_CODE_PATTERN.test(normalized)) fail(invalidCode);
  return normalized;
}

function normalizedContractVersion(
  value: unknown,
  invalidCode: CommunicationIntentContractErrorCode = 'COMMUNICATION_INTENT_FIELD_INVALID',
) {
  const normalized = normalizedText(value, 80, invalidCode);
  if (!CONTRACT_VERSION_PATTERN.test(normalized)) fail(invalidCode);
  return normalized;
}

function normalizedUuid(value: unknown) {
  const normalized = normalizedText(value, 36, 'COMMUNICATION_INTENT_FIELD_INVALID').toLowerCase();
  if (!UUID_V4_PATTERN.test(normalized)) fail('COMMUNICATION_INTENT_FIELD_INVALID');
  return normalized;
}

function normalizedCrmEntityId(value: unknown) {
  const normalized = normalizedText(value, 36, 'COMMUNICATION_INTENT_RECIPIENT_INVALID').toLowerCase();
  if (!UUID_V4_PATTERN.test(normalized) && !CUID_V1_PATTERN.test(normalized)) {
    fail('COMMUNICATION_INTENT_RECIPIENT_INVALID');
  }
  return normalized;
}

function normalizedTimestamp(value: unknown) {
  const normalized = normalizedText(value, 29, 'COMMUNICATION_INTENT_FIELD_INVALID');
  const calendar = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(normalized);
  if (!RFC3339_MILLISECOND_PATTERN.test(normalized) || !calendar) {
    fail('COMMUNICATION_INTENT_FIELD_INVALID');
  }
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = calendar;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay = month >= 1 && month <= 12
    ? [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    : 0;
  if (day < 1 || day > maximumDay
    || Number(rawHour) > 23
    || Number(rawMinute) > 59
    || Number(rawSecond) > 59) {
    fail('COMMUNICATION_INTENT_FIELD_INVALID');
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) fail('COMMUNICATION_INTENT_FIELD_INVALID');
  try {
    const canonical = new Date(timestamp).toISOString();
    if (!RFC3339_MILLISECOND_PATTERN.test(canonical)) {
      fail('COMMUNICATION_INTENT_FIELD_INVALID');
    }
    return canonical;
  } catch {
    return fail('COMMUNICATION_INTENT_FIELD_INVALID');
  }
}

function normalizedSha256(
  value: unknown,
  invalidCode: CommunicationIntentContractErrorCode = 'COMMUNICATION_INTENT_HASH_INVALID',
) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(invalidCode);
  return value;
}

function hashDomain(domain: string, value: unknown) {
  return sha256(`${domain}\n${canonicalJson(value)}`);
}

function normalizeSourceInput(value: unknown) {
  const source = readExactRecord(
    value,
    ['producerCode', 'callerIdempotencyKey'],
    ['producerCode', 'callerIdempotencyKey'],
    'COMMUNICATION_INTENT_FIELD_INVALID',
  );
  const callerIdempotencyKey = normalizedText(
    source.callerIdempotencyKey,
    128,
    'COMMUNICATION_INTENT_FIELD_INVALID',
  );
  if (!CALLER_KEY_PATTERN.test(callerIdempotencyKey)) {
    fail('COMMUNICATION_INTENT_FIELD_INVALID');
  }
  return {
    producerCode: normalizedContractCode(source.producerCode),
    callerIdempotencyKey,
  };
}

function normalizeSource(value: unknown): CommunicationIntentSourceV1 {
  const source = readExactRecord(
    value,
    ['producerCode'],
    ['producerCode'],
    'COMMUNICATION_INTENT_FIELD_INVALID',
  );
  return { producerCode: normalizedContractCode(source.producerCode) };
}

function normalizeRecipient(value: unknown): CommunicationRecipientReferenceV1 {
  const recipient = readExactRecord(
    value,
    ['authorityCode', 'entityType', 'entityId'],
    ['authorityCode', 'entityType', 'entityId'],
    'COMMUNICATION_INTENT_RECIPIENT_INVALID',
  );
  if (recipient.authorityCode !== 'CRM'
    || typeof recipient.entityType !== 'string'
    || !(COMMUNICATION_RECIPIENT_ENTITY_TYPES as readonly string[]).includes(recipient.entityType)) {
    fail('COMMUNICATION_INTENT_RECIPIENT_INVALID');
  }
  return {
    authorityCode: 'CRM',
    entityType: recipient.entityType as CommunicationRecipientEntityType,
    entityId: normalizedCrmEntityId(recipient.entityId),
  };
}

function normalizeTemplateReference(value: unknown): CommunicationTemplateReferenceV1 {
  const template = readExactRecord(
    value,
    ['templateCode', 'templateVersion', 'templateHash'],
    ['templateCode', 'templateVersion', 'templateHash'],
    'COMMUNICATION_INTENT_TEMPLATE_INVALID',
  );
  return {
    templateCode: normalizedContractCode(
      template.templateCode,
      'COMMUNICATION_INTENT_TEMPLATE_INVALID',
    ),
    templateVersion: normalizedContractVersion(
      template.templateVersion,
      'COMMUNICATION_INTENT_TEMPLATE_INVALID',
    ),
    templateHash: normalizedSha256(
      template.templateHash,
      'COMMUNICATION_INTENT_TEMPLATE_INVALID',
    ),
  };
}

function normalizeMessage(value: unknown): CommunicationMessageReferenceV1 {
  const message = readExactRecord(
    value,
    ['messageClass', 'reasonCode', 'templateReference'],
    ['messageClass', 'reasonCode', 'templateReference'],
    'COMMUNICATION_INTENT_FIELD_INVALID',
  );
  if (typeof message.messageClass !== 'string'
    || !(COMMUNICATION_MESSAGE_CLASSES as readonly string[]).includes(message.messageClass)) {
    fail('COMMUNICATION_INTENT_CLASS_UNSUPPORTED');
  }
  return {
    messageClass: message.messageClass as CommunicationMessageClass,
    reasonCode: normalizedContractCode(message.reasonCode),
    templateReference: normalizeTemplateReference(message.templateReference),
  };
}

function normalizePolicySnapshot(value: unknown): CommunicationPolicySnapshotV1 {
  const policy = readExactRecord(
    value,
    ['policyReferenceCode', 'policyVersion', 'decision', 'reasonCode'],
    ['policyReferenceCode', 'policyVersion', 'decision', 'reasonCode'],
    'COMMUNICATION_INTENT_POLICY_INVALID',
  );
  if (policy.policyReferenceCode !== COMMUNICATION_POLICY_SNAPSHOT_V1.policyReferenceCode
    || policy.policyVersion !== COMMUNICATION_POLICY_SNAPSHOT_V1.policyVersion
    || policy.decision !== COMMUNICATION_POLICY_SNAPSHOT_V1.decision
    || policy.reasonCode !== COMMUNICATION_POLICY_SNAPSHOT_V1.reasonCode) {
    fail('COMMUNICATION_INTENT_POLICY_INVALID');
  }
  return COMMUNICATION_POLICY_SNAPSHOT_V1;
}

type CommunicationIntentCoreV1 = Omit<CommunicationIntentV1, 'idempotency'>;

function communicationIntentSemanticMaterial(core: CommunicationIntentCoreV1) {
  return {
    businessCorrelationId: core.businessCorrelationId,
    source: core.source,
    recipient: core.recipient,
    message: core.message,
    policySnapshot: core.policySnapshot,
  };
}

function communicationIntentKeyDigest(producerCode: string, callerIdempotencyKey: string) {
  return hashDomain('fai.communication-intent.idempotency-key.v1', {
    producerCode,
    callerIdempotencyKey,
  });
}

function communicationIntentSemanticHash(core: CommunicationIntentCoreV1) {
  return hashDomain(
    'fai.communication-intent.semantic.v1',
    communicationIntentSemanticMaterial(core),
  );
}

function communicationIntentEnvelopeHash(
  core: CommunicationIntentCoreV1,
  keyDigest: string,
  semanticHash: string,
) {
  return hashDomain('fai.communication-intent.envelope.v1', {
    ...core,
    idempotency: {
      canonicalizationVersion: COMMUNICATION_INTENT_CANONICALIZATION_VERSION,
      keyDigest,
      semanticHash,
    },
  });
}

function assertBoundedIntent(value: CommunicationIntentV1) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail('COMMUNICATION_INTENT_ENVELOPE_INVALID');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_COMMUNICATION_INTENT_BYTES) {
    fail('COMMUNICATION_INTENT_TOO_LARGE');
  }
}

function finalizeIntent(
  core: CommunicationIntentCoreV1,
  keyDigest: string,
  suppliedSemanticHash?: string,
  suppliedEnvelopeHash?: string,
) {
  const semanticHash = communicationIntentSemanticHash(core);
  const envelopeHash = communicationIntentEnvelopeHash(core, keyDigest, semanticHash);
  if ((suppliedSemanticHash !== undefined && suppliedSemanticHash !== semanticHash)
    || (suppliedEnvelopeHash !== undefined && suppliedEnvelopeHash !== envelopeHash)) {
    fail('COMMUNICATION_INTENT_HASH_INVALID');
  }
  const intent: CommunicationIntentV1 = {
    ...core,
    idempotency: {
      canonicalizationVersion: COMMUNICATION_INTENT_CANONICALIZATION_VERSION,
      keyDigest,
      semanticHash,
      envelopeHash,
    },
  };
  try {
    assertClassifiedFields('communication_intent_v1', intent);
  } catch {
    return fail('COMMUNICATION_INTENT_FIELD_UNKNOWN');
  }
  assertBoundedIntent(intent);
  return deepFreeze(intent);
}

function normalizeIntentCore(value: Record<string, unknown>): CommunicationIntentCoreV1 {
  if (value.state !== 'RECORDED') fail('COMMUNICATION_INTENT_STATE_TRANSITION_INVALID');
  return {
    schemaVersion: COMMUNICATION_INTENT_SCHEMA_VERSION,
    intentType: COMMUNICATION_INTENT_TYPE,
    intentVersion: COMMUNICATION_INTENT_VERSION,
    intentId: normalizedUuid(value.intentId),
    businessCorrelationId: normalizedUuid(value.businessCorrelationId),
    occurredAt: normalizedTimestamp(value.occurredAt),
    source: normalizeSource(value.source),
    recipient: normalizeRecipient(value.recipient),
    message: normalizeMessage(value.message),
    policySnapshot: normalizePolicySnapshot(value.policySnapshot),
    state: 'RECORDED',
  };
}

function assertIntentDiscriminators(value: Record<string, unknown>) {
  const schemaVersion = readRequiredDataField(
    value,
    'schemaVersion',
    'COMMUNICATION_INTENT_ENVELOPE_INVALID',
  );
  if (schemaVersion !== COMMUNICATION_INTENT_SCHEMA_VERSION) {
    fail('COMMUNICATION_INTENT_SCHEMA_UNSUPPORTED');
  }
  const intentType = readRequiredDataField(
    value,
    'intentType',
    'COMMUNICATION_INTENT_ENVELOPE_INVALID',
  );
  if (intentType !== COMMUNICATION_INTENT_TYPE) {
    fail('COMMUNICATION_INTENT_TYPE_UNSUPPORTED');
  }
  const intentVersion = readRequiredDataField(
    value,
    'intentVersion',
    'COMMUNICATION_INTENT_ENVELOPE_INVALID',
  );
  if (intentVersion !== COMMUNICATION_INTENT_VERSION) {
    fail('COMMUNICATION_INTENT_VERSION_UNSUPPORTED');
  }
}

export function createCommunicationIntentV1(value: unknown): CommunicationIntentV1 {
  const input = readExactRecord(
    value,
    ['intentId', 'businessCorrelationId', 'occurredAt', 'source', 'recipient', 'message'],
    ['intentId', 'businessCorrelationId', 'occurredAt', 'source', 'recipient', 'message'],
    'COMMUNICATION_INTENT_ENVELOPE_INVALID',
  );
  const sourceInput = normalizeSourceInput(input.source);
  const core: CommunicationIntentCoreV1 = {
    schemaVersion: COMMUNICATION_INTENT_SCHEMA_VERSION,
    intentType: COMMUNICATION_INTENT_TYPE,
    intentVersion: COMMUNICATION_INTENT_VERSION,
    intentId: normalizedUuid(input.intentId),
    businessCorrelationId: normalizedUuid(input.businessCorrelationId),
    occurredAt: normalizedTimestamp(input.occurredAt),
    source: { producerCode: sourceInput.producerCode },
    recipient: normalizeRecipient(input.recipient),
    message: normalizeMessage(input.message),
    policySnapshot: COMMUNICATION_POLICY_SNAPSHOT_V1,
    state: 'RECORDED',
  };
  return finalizeIntent(
    core,
    communicationIntentKeyDigest(sourceInput.producerCode, sourceInput.callerIdempotencyKey),
  );
}

export function parseCommunicationIntentV1(value: unknown): CommunicationIntentV1 {
  const candidate = readPlainRecord(value, 'COMMUNICATION_INTENT_ENVELOPE_INVALID');
  assertIntentDiscriminators(candidate);
  const envelope = readExactRecord(
    candidate,
    [
      'schemaVersion', 'intentType', 'intentVersion', 'intentId', 'businessCorrelationId',
      'occurredAt', 'source', 'recipient', 'message', 'policySnapshot', 'state', 'idempotency',
    ],
    [
      'schemaVersion', 'intentType', 'intentVersion', 'intentId', 'businessCorrelationId',
      'occurredAt', 'source', 'recipient', 'message', 'policySnapshot', 'state', 'idempotency',
    ],
    'COMMUNICATION_INTENT_ENVELOPE_INVALID',
  );
  assertIntentDiscriminators(envelope);
  const idempotency = readExactRecord(
    envelope.idempotency,
    ['canonicalizationVersion', 'keyDigest', 'semanticHash', 'envelopeHash'],
    ['canonicalizationVersion', 'keyDigest', 'semanticHash', 'envelopeHash'],
    'COMMUNICATION_INTENT_HASH_INVALID',
  );
  if (idempotency.canonicalizationVersion !== COMMUNICATION_INTENT_CANONICALIZATION_VERSION) {
    fail('COMMUNICATION_INTENT_HASH_INVALID');
  }
  const keyDigest = normalizedSha256(idempotency.keyDigest);
  const semanticHash = normalizedSha256(idempotency.semanticHash);
  const envelopeHash = normalizedSha256(idempotency.envelopeHash);
  return finalizeIntent(
    normalizeIntentCore(envelope),
    keyDigest,
    semanticHash,
    envelopeHash,
  );
}

export type CommunicationIntentIdempotencyComparison = 'NEW' | 'REPLAY' | 'CONFLICT';

export function compareCommunicationIntentIdempotencyV1(
  stored: unknown,
  candidate: CommunicationIntentV1,
): CommunicationIntentIdempotencyComparison {
  const normalizedCandidate = parseCommunicationIntentV1(candidate);
  if (stored === null) return 'NEW';
  const normalizedStored = readExactRecord(
    stored,
    ['keyDigest', 'semanticHash'],
    ['keyDigest', 'semanticHash'],
    'COMMUNICATION_INTENT_HASH_INVALID',
    'COMMUNICATION_INTENT_HASH_INVALID',
  );
  const storedKeyDigest = normalizedSha256(normalizedStored.keyDigest);
  const storedSemanticHash = normalizedSha256(normalizedStored.semanticHash);
  if (storedKeyDigest !== normalizedCandidate.idempotency.keyDigest) return 'NEW';
  return storedSemanticHash === normalizedCandidate.idempotency.semanticHash
    ? 'REPLAY'
    : 'CONFLICT';
}

function allGateValues(state: CommunicationGateState): CommunicationGateValuesV1 {
  return {
    CAPABILITY: state,
    WORKER: state,
    DISPATCH: state,
    EGRESS: state,
    CHANNEL: state,
    PROVIDER: state,
    TENANT: state,
  };
}

function gateReasonCode(gates: CommunicationGateValuesV1): CommunicationGateReasonCode {
  const values = COMMUNICATION_GATE_CODES.map((code) => gates[code]);
  if (values.includes('ERROR')) return 'N15_GATE_ERROR';
  if (values.includes('MISSING')) return 'N15_GATE_MISSING';
  if (values.includes('DISABLED')) return 'N15_GATE_DISABLED';
  return 'N15_PHASE1A_DORMANT';
}

function buildGateSnapshot(gates: CommunicationGateValuesV1): CommunicationGateSnapshotV1 {
  const allOfSatisfied = COMMUNICATION_GATE_CODES.every((code) => gates[code] === 'ENABLED');
  return deepFreeze({
    schemaVersion: 'fai.communication-gate-snapshot.v1',
    snapshotVersion: 1,
    evaluationModel: 'HIERARCHICAL_ALL_OF',
    gates: { ...gates },
    allOfSatisfied,
    decision: 'HELD',
    reasonCode: gateReasonCode(gates),
  });
}

function safelyReadGateObservations(value: unknown): CommunicationGateValuesV1 {
  if (value === undefined || value === null) return allGateValues('MISSING');
  if (typeof value !== 'object') return allGateValues('ERROR');
  let array: boolean;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return allGateValues('ERROR');
  }
  if (array) return allGateValues('ERROR');
  if (prototype !== Object.prototype && prototype !== null) return allGateValues('ERROR');
  if (keys.some((key) => typeof key !== 'string'
    || !(COMMUNICATION_GATE_CODES as readonly string[]).includes(key))) {
    return allGateValues('ERROR');
  }
  const keySet = new Set(keys as string[]);
  const record = value as Record<string, unknown>;
  const gates = {} as Record<CommunicationGateCode, CommunicationGateState>;
  for (const code of COMMUNICATION_GATE_CODES) {
    if (!keySet.has(code)) {
      gates[code] = 'MISSING';
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(record, code);
    } catch {
      gates[code] = 'ERROR';
      continue;
    }
    if (!descriptor) {
      gates[code] = 'ERROR';
      continue;
    }
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string'
      || !(COMMUNICATION_GATE_STATES as readonly string[]).includes(descriptor.value)) {
      gates[code] = 'ERROR';
      continue;
    }
    gates[code] = descriptor.value as CommunicationGateState;
  }
  return gates;
}

export function evaluateCommunicationGatesV1(observations?: unknown): CommunicationGateSnapshotV1 {
  return buildGateSnapshot(safelyReadGateObservations(observations));
}

export function createDisabledCommunicationGateSnapshotV1(): CommunicationGateSnapshotV1 {
  return buildGateSnapshot(allGateValues('DISABLED'));
}

export function parseCommunicationGateSnapshotV1(value: unknown): CommunicationGateSnapshotV1 {
  const snapshot = readExactRecord(
    value,
    ['schemaVersion', 'snapshotVersion', 'evaluationModel', 'gates', 'allOfSatisfied', 'decision', 'reasonCode'],
    ['schemaVersion', 'snapshotVersion', 'evaluationModel', 'gates', 'allOfSatisfied', 'decision', 'reasonCode'],
    'COMMUNICATION_INTENT_GATE_SNAPSHOT_INVALID',
  );
  if (snapshot.schemaVersion !== 'fai.communication-gate-snapshot.v1'
    || snapshot.snapshotVersion !== 1
    || snapshot.evaluationModel !== 'HIERARCHICAL_ALL_OF'
    || snapshot.decision !== 'HELD') {
    fail('COMMUNICATION_INTENT_GATE_SNAPSHOT_INVALID');
  }
  const gateRecord = readExactRecord(
    snapshot.gates,
    COMMUNICATION_GATE_CODES,
    COMMUNICATION_GATE_CODES,
    'COMMUNICATION_INTENT_GATE_SNAPSHOT_INVALID',
  );
  const gates = {} as Record<CommunicationGateCode, CommunicationGateState>;
  for (const code of COMMUNICATION_GATE_CODES) {
    const state = gateRecord[code];
    if (typeof state !== 'string'
      || !(COMMUNICATION_GATE_STATES as readonly string[]).includes(state)) {
      fail('COMMUNICATION_INTENT_GATE_SNAPSHOT_INVALID');
    }
    gates[code] = state as CommunicationGateState;
  }
  const normalized = buildGateSnapshot(gates);
  if (snapshot.allOfSatisfied !== normalized.allOfSatisfied
    || snapshot.reasonCode !== normalized.reasonCode) {
    fail('COMMUNICATION_INTENT_GATE_SNAPSHOT_INVALID');
  }
  return normalized;
}

export function isCommunicationIntentStateTransitionAllowedV1(
  from: unknown,
  to: unknown,
) {
  return from === 'RECORDED' && to === 'HELD';
}

function communicationDecisionHash(
  value: Omit<CommunicationHeldDecisionV1, 'decisionHash'>,
) {
  return hashDomain('fai.communication-held-decision.v1', value);
}

export function createCommunicationHeldDecisionV1(
  intentValue: unknown,
  gateSnapshotValue: unknown,
  evaluatedAtValue: unknown,
): CommunicationHeldDecisionV1 {
  const intent = parseCommunicationIntentV1(intentValue);
  const gateSnapshot = parseCommunicationGateSnapshotV1(gateSnapshotValue);
  if (!isCommunicationIntentStateTransitionAllowedV1(intent.state, 'HELD')) {
    fail('COMMUNICATION_INTENT_STATE_TRANSITION_INVALID');
  }
  const evaluatedAt = normalizedTimestamp(evaluatedAtValue);
  if (Date.parse(evaluatedAt) < Date.parse(intent.occurredAt)) {
    fail('COMMUNICATION_INTENT_STATE_TRANSITION_INVALID');
  }
  const core = {
    schemaVersion: 'fai.communication-held-decision.v1',
    decisionType: 'COMMUNICATION_INTENT_HELD',
    decisionVersion: 1,
    intentId: intent.intentId,
    businessCorrelationId: intent.businessCorrelationId,
    intentSemanticHash: intent.idempotency.semanticHash,
    intentEnvelopeHash: intent.idempotency.envelopeHash,
    evaluatedAt,
    fromState: 'RECORDED',
    toState: 'HELD',
    policySnapshot: intent.policySnapshot,
    gateSnapshot,
    reasonCode: gateSnapshot.reasonCode,
  } as const;
  const decision: CommunicationHeldDecisionV1 = {
    ...core,
    decisionHash: communicationDecisionHash(core),
  };
  try {
    assertClassifiedFields('communication_held_decision_v1', decision);
  } catch {
    return fail('COMMUNICATION_INTENT_FIELD_UNKNOWN');
  }
  return deepFreeze(decision);
}

export function parseCommunicationHeldDecisionV1(value: unknown): CommunicationHeldDecisionV1 {
  const decision = readExactRecord(
    value,
    [
      'schemaVersion', 'decisionType', 'decisionVersion', 'intentId', 'businessCorrelationId',
      'intentSemanticHash', 'intentEnvelopeHash', 'evaluatedAt', 'fromState', 'toState',
      'policySnapshot', 'gateSnapshot', 'reasonCode', 'decisionHash',
    ],
    [
      'schemaVersion', 'decisionType', 'decisionVersion', 'intentId', 'businessCorrelationId',
      'intentSemanticHash', 'intentEnvelopeHash', 'evaluatedAt', 'fromState', 'toState',
      'policySnapshot', 'gateSnapshot', 'reasonCode', 'decisionHash',
    ],
    'COMMUNICATION_INTENT_ENVELOPE_INVALID',
  );
  if (decision.schemaVersion !== 'fai.communication-held-decision.v1'
    || decision.decisionType !== 'COMMUNICATION_INTENT_HELD'
    || decision.decisionVersion !== 1
    || !isCommunicationIntentStateTransitionAllowedV1(decision.fromState, decision.toState)) {
    fail('COMMUNICATION_INTENT_STATE_TRANSITION_INVALID');
  }
  const gateSnapshot = parseCommunicationGateSnapshotV1(decision.gateSnapshot);
  if (typeof decision.reasonCode !== 'string'
    || !(COMMUNICATION_GATE_REASON_CODES as readonly string[]).includes(decision.reasonCode)) {
    fail('COMMUNICATION_INTENT_GATE_SNAPSHOT_INVALID');
  }
  const core = {
    schemaVersion: 'fai.communication-held-decision.v1',
    decisionType: 'COMMUNICATION_INTENT_HELD',
    decisionVersion: 1,
    intentId: normalizedUuid(decision.intentId),
    businessCorrelationId: normalizedUuid(decision.businessCorrelationId),
    intentSemanticHash: normalizedSha256(decision.intentSemanticHash),
    intentEnvelopeHash: normalizedSha256(decision.intentEnvelopeHash),
    evaluatedAt: normalizedTimestamp(decision.evaluatedAt),
    fromState: 'RECORDED',
    toState: 'HELD',
    policySnapshot: normalizePolicySnapshot(decision.policySnapshot),
    gateSnapshot,
    reasonCode: decision.reasonCode as CommunicationGateReasonCode,
  } as const;
  if (core.reasonCode !== core.gateSnapshot.reasonCode) {
    fail('COMMUNICATION_INTENT_GATE_SNAPSHOT_INVALID');
  }
  const decisionHash = normalizedSha256(decision.decisionHash);
  if (communicationDecisionHash(core) !== decisionHash) {
    fail('COMMUNICATION_INTENT_HASH_INVALID');
  }
  return deepFreeze({ ...core, decisionHash });
}

function auditReferenceHash(kind: string, value: unknown) {
  return hashDomain(`fai.communication-audit-reference.${kind}.v1`, value);
}

export function createCommunicationAuditRecordV1(
  intentValue: unknown,
  decisionValue: unknown,
): CommunicationAuditRecordV1 {
  const intent = parseCommunicationIntentV1(intentValue);
  const decision = parseCommunicationHeldDecisionV1(decisionValue);
  if (intent.intentId !== decision.intentId
    || intent.businessCorrelationId !== decision.businessCorrelationId
    || intent.idempotency.semanticHash !== decision.intentSemanticHash
    || intent.idempotency.envelopeHash !== decision.intentEnvelopeHash
    || Date.parse(decision.evaluatedAt) < Date.parse(intent.occurredAt)
    || canonicalJson(intent.policySnapshot) !== canonicalJson(decision.policySnapshot)) {
    fail('COMMUNICATION_INTENT_AUDIT_INVALID');
  }
  const audit: CommunicationAuditRecordV1 = {
    schemaVersion: 'fai.communication-audit-record.v1',
    recordType: 'COMMUNICATION_INTENT_HELD',
    recordVersion: 1,
    intentReferenceHash: auditReferenceHash('intent', intent.intentId),
    correlationReferenceHash: auditReferenceHash('correlation', intent.businessCorrelationId),
    sourceReferenceHash: auditReferenceHash('source', intent.source),
    recipientReferenceHash: auditReferenceHash('recipient', intent.recipient),
    templateReferenceHash: auditReferenceHash('template', intent.message.templateReference),
    communicationClassCode: intent.message.messageClass,
    intentReasonReferenceHash: auditReferenceHash('intent-reason', intent.message.reasonCode),
    policyReferenceCode: intent.policySnapshot.policyReferenceCode,
    policyReasonCode: intent.policySnapshot.reasonCode,
    gateSnapshotHash: auditReferenceHash('gate-snapshot', decision.gateSnapshot),
    gateReasonCode: decision.reasonCode,
    fromState: decision.fromState,
    toState: decision.toState,
    idempotencyKeyHash: intent.idempotency.keyDigest,
    semanticHash: intent.idempotency.semanticHash,
    envelopeHash: intent.idempotency.envelopeHash,
    decisionHash: decision.decisionHash,
  };
  try {
    assertClassifiedFields('communication_audit_record_v1', audit);
  } catch {
    return fail('COMMUNICATION_INTENT_AUDIT_INVALID');
  }
  return deepFreeze(audit);
}
