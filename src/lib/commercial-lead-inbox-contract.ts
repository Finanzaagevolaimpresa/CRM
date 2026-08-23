export const COMMERCIAL_LEAD_INBOX_SCHEMA_VERSION = 'n14-v1' as const;

export const COMMERCIAL_LEAD_INBOX_MANIFEST = Object.freeze({
  schemaVersion: COMMERCIAL_LEAD_INBOX_SCHEMA_VERSION,
  modeEnvironment: 'COMMERCIAL_LEAD_INBOX_MODE',
  defaultMode: 'disabled',
  dormant: true,
  activation: 'NONE',
  runtimeConsumers: Object.freeze([] as string[]),
  slaClock: 'DATABASE',
  slaCalendar: 'CONTINUOUS_24X7',
  slaTimezone: 'UTC',
  retentionPolicyVersion: 'N21_UNASSIGNED',
} as const);

export const COMMERCIAL_LEAD_ORIGIN_KINDS = Object.freeze([
  'MANUAL_CRM',
  'WEBSITE_LEGACY_N01',
  'BUSINESS_PROJECTION_N13',
  'LEGACY_UNVERIFIED',
] as const);

export const COMMERCIAL_LEAD_INBOX_STATES = Object.freeze(['OPEN', 'CLOSED'] as const);
export const COMMERCIAL_LEAD_POLICY_STATES = Object.freeze(['STAGED', 'ACTIVE', 'RETIRED'] as const);
export const COMMERCIAL_LEAD_SLA_OUTCOMES = Object.freeze([
  'MET',
  'BREACHED',
  'CLOSED_WITHOUT_RESPONSE',
] as const);
export const COMMERCIAL_LEAD_ACTIVITY_TYPES = Object.freeze([
  'INITIALIZED',
  'CLAIMED',
  'ASSIGNED',
  'UNASSIGNED',
  'FIRST_RESPONSE_RECORDED',
  'CLOSED',
  'REOPENED',
] as const);
export const COMMERCIAL_LEAD_ACTOR_KINDS = Object.freeze(['USER', 'SYSTEM'] as const);
export const COMMERCIAL_LEAD_REASON_CODES = Object.freeze([
  'MANUAL_INTAKE',
  'PROJECTED_NEW',
  'LEGACY_ENROLLMENT',
  'SELF_CLAIM',
  'MANAGER_ASSIGNMENT',
  'MANAGER_UNASSIGNMENT',
  'CUSTOMER_CONTACTED',
  'QUALIFIED_OUT',
  'CONVERTED',
  'LOST',
  'ARCHIVED',
  'REOPENED_FOR_REWORK',
] as const);

export type CommercialLeadInboxMode = 'disabled' | 'enforced';
export type CommercialLeadOriginKind = typeof COMMERCIAL_LEAD_ORIGIN_KINDS[number];
export type CommercialLeadInboxState = typeof COMMERCIAL_LEAD_INBOX_STATES[number];
export type CommercialLeadActivityType = typeof COMMERCIAL_LEAD_ACTIVITY_TYPES[number];
export type CommercialLeadReasonCode = typeof COMMERCIAL_LEAD_REASON_CODES[number];

export const COMMERCIAL_LEAD_INBOX_ERROR_CODES = Object.freeze([
  'N14_DISABLED',
  'N14_ACTIVE_POLICY_UNAVAILABLE',
  'N14_LEAD_NOT_FOUND',
  'N14_ITEM_NOT_FOUND',
  'N14_ITEM_ALREADY_EXISTS',
  'N14_ITEM_NOT_OPEN',
  'N14_ITEM_NOT_CLOSED',
  'N14_PERMISSION_DENIED',
  'N14_SESSION_REVALIDATION_FAILED',
  'N14_TARGET_USER_INVALID',
  'N14_VERSION_CONFLICT',
  'N14_FIRST_RESPONSE_ALREADY_RECORDED',
  'N14_FIRST_RESPONSE_REQUIRED',
  'N14_LEAD_ALREADY_CONVERTED',
  'N14_ATTRIBUTION_INVALID',
  'N14_REASON_INVALID',
] as const);

export type CommercialLeadInboxErrorCode = typeof COMMERCIAL_LEAD_INBOX_ERROR_CODES[number];

export class CommercialLeadInboxError extends Error {
  constructor(readonly code: CommercialLeadInboxErrorCode) {
    super(code);
    this.name = 'CommercialLeadInboxError';
  }
}

export function commercialLeadInboxMode(
  value = process.env.COMMERCIAL_LEAD_INBOX_MODE,
): CommercialLeadInboxMode {
  return value === 'enforced' ? 'enforced' : 'disabled';
}

export function commercialLeadInboxEnabled(value?: string) {
  return commercialLeadInboxMode(value) === 'enforced';
}

export function isCommercialLeadOriginKind(value: unknown): value is CommercialLeadOriginKind {
  return typeof value === 'string'
    && (COMMERCIAL_LEAD_ORIGIN_KINDS as readonly string[]).includes(value);
}

export function isCommercialLeadReasonCode(value: unknown): value is CommercialLeadReasonCode {
  return typeof value === 'string'
    && (COMMERCIAL_LEAD_REASON_CODES as readonly string[]).includes(value);
}

export function isCommercialLeadResponseTargetSeconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 31_536_000;
}
