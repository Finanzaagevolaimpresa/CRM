import { createHash } from 'node:crypto';
import { redactTechnicalText } from './data-classification';

export const HISTORICAL_CONTACT_PROTOCOL = 'N14_HISTORICAL_CONTACT_V1' as const;
export const historicalContactSources = ['EMAIL', 'PHONE', 'MEETING', 'EXISTING_DOCUMENT'] as const;
export type HistoricalContactSource = typeof historicalContactSources[number];

export class HistoricalContactError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'NOT_AUTHORIZED' | 'STALE_CONTEXT' | 'NOT_HISTORICAL' | 'ALREADY_RECORDED') {
    super(code);
    this.name = 'HistoricalContactError';
  }
}
const deny = (code: HistoricalContactError['code']): never => { throw new HistoricalContactError(code); };

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) return deny('INVALID_INPUT');
  return value;
}

function utcInstant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return deny('INVALID_INPUT');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return deny('INVALID_INPUT');
  return value;
}

export function historicalContactInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return deny('INVALID_INPUT');
  const v = value as Record<string, unknown>;
  const fields = ['commandId', 'leadId', 'expectedInboxVersion', 'expectedAssignmentId', 'occurredAt', 'source', 'evidenceReference', 'attested'];
  if (Object.keys(v).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(v, key))) return deny('INVALID_INPUT');
  if (typeof v.commandId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v.commandId)) return deny('INVALID_INPUT');
  if (!Number.isSafeInteger(v.expectedInboxVersion) || Number(v.expectedInboxVersion) < 1
    || Number(v.expectedInboxVersion) > 2_147_483_646 || v.attested !== true) return deny('INVALID_INPUT');
  if (!historicalContactSources.includes(v.source as HistoricalContactSource)) return deny('INVALID_INPUT');
  if (typeof v.evidenceReference !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(v.evidenceReference)) return deny('INVALID_INPUT');
  const evidenceReference = v.evidenceReference.normalize('NFC').trim();
  if (evidenceReference.length < 3 || evidenceReference.length > 500) return deny('INVALID_INPUT');
  return Object.freeze({
    protocol: HISTORICAL_CONTACT_PROTOCOL,
    commandId: v.commandId,
    leadId: identifier(v.leadId),
    expectedInboxVersion: Number(v.expectedInboxVersion),
    expectedAssignmentId: identifier(v.expectedAssignmentId),
    occurredAt: utcInstant(v.occurredAt),
    source: v.source as HistoricalContactSource,
    evidenceReference,
    attested: true as const,
  });
}

export type HistoricalContactInput = ReturnType<typeof historicalContactInput>;

// The persistence service builds this context from locked, authoritative rows.
// This pure contract does not replace the transactional authorization checks.
export type HistoricalContactContext = Readonly<{
  leadId: string;
  actorId: string;
  actorRole: string;
  sessionLive: boolean;
  canWriteLead: boolean;
  selectiveAccessOnly: boolean;
  currentOwnerId: string | null;
  assignmentId: string | null;
  acceptedAssignmentId: string | null;
  acceptedById: string | null;
  origin: string;
  state: string;
  inboxVersion: number;
  deleted: boolean;
  converted: boolean;
  cycleSequence: number;
  firstResponseAt: string | null;
  historicalContactExists: boolean;
  initializedAt: string;
  recordedAt: string;
}>;

export function prepareHistoricalContact(input: HistoricalContactInput, context: HistoricalContactContext) {
  // Re-parse even typed input: JavaScript callers cannot bypass normalization with a cast.
  const { protocol: suppliedProtocol, ...raw } = input;
  if (suppliedProtocol !== HISTORICAL_CONTACT_PROTOCOL) return deny('INVALID_INPUT');
  const value = historicalContactInput(raw);
  const initializedAt = utcInstant(context.initializedAt);
  const recordedAt = utcInstant(context.recordedAt);
  if (!context.sessionLive || !context.canWriteLead || context.selectiveAccessOnly || context.actorRole !== 'commerciale'
    || !context.actorId || context.currentOwnerId !== context.actorId) return deny('NOT_AUTHORIZED');
  if (context.deleted || context.converted || context.origin !== 'MANUAL_CRM' || context.state !== 'OPEN'
    || context.cycleSequence !== 1 || value.leadId !== context.leadId
    || context.inboxVersion !== value.expectedInboxVersion || context.assignmentId !== value.expectedAssignmentId
    || context.acceptedAssignmentId !== context.assignmentId || context.acceptedById !== context.actorId) return deny('STALE_CONTEXT');
  if (context.firstResponseAt !== null || context.historicalContactExists) return deny('ALREADY_RECORDED');
  if (Date.parse(value.occurredAt) >= Date.parse(initializedAt) || Date.parse(initializedAt) > Date.parse(recordedAt)) return deny('NOT_HISTORICAL');
  const payload = {
    protocol: HISTORICAL_CONTACT_PROTOCOL, leadId: value.leadId, actorId: context.actorId,
    assignmentId: value.expectedAssignmentId, inboxVersion: value.expectedInboxVersion,
    occurredAt: value.occurredAt, source: value.source, evidenceReference: value.evidenceReference,
  };
  return Object.freeze({
    ...value, actorId: context.actorId, recordedAt,
    payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    slaEffect: 'NO_REWRITE' as const,
  });
}

export type PreparedHistoricalContact = ReturnType<typeof prepareHistoricalContact>;

export type HistoricalContactReceipt = Readonly<{
  id: string;
  input: HistoricalContactInput;
  actorId: string;
  recordedAt: string;
  inboxItemId: string;
  cycleId: string;
  inboxVersionAfter: number;
  payloadHash: string;
}>;

/** A persistence caller must supply the live, locked context and the immutable
 * receipt from the database. A browser-supplied receipt is never evidence. */
export function prepareHistoricalConversion(receipt: HistoricalContactReceipt, context: HistoricalContactContext & {
  inboxItemId: string;
  cycleId: string;
  canCreateClient: boolean;
}) {
  if (!context.canCreateClient) return deny('NOT_AUTHORIZED');
  if (receipt.actorId !== context.actorId || receipt.inboxItemId !== context.inboxItemId
    || receipt.cycleId !== context.cycleId || !context.historicalContactExists
    || receipt.inboxVersionAfter !== receipt.input.expectedInboxVersion + 1
    || context.inboxVersion < receipt.inboxVersionAfter) return deny('STALE_CONTEXT');
  identifier(receipt.id);
  const receiptTime = utcInstant(receipt.recordedAt), now = utcInstant(context.recordedAt);
  if (Date.parse(receiptTime) > Date.parse(now)) return deny('STALE_CONTEXT');
  // Recreate the recorded payload, but keep today's identity, ownership,
  // acceptance, lifecycle and session checks. A reassignment invalidates it.
  const recorded = prepareHistoricalContact(receipt.input, { ...context,
    inboxVersion: receipt.input.expectedInboxVersion, recordedAt: receiptTime,
    historicalContactExists: false,
  });
  if (!/^[0-9a-f]{64}$/u.test(receipt.payloadHash) || recorded.payloadHash !== receipt.payloadHash) return deny('STALE_CONTEXT');
  return Object.freeze({
    receiptId: receipt.id,
    basis: 'HISTORICAL_CONTACT_BEFORE_CRM' as const,
    firstResponseAt: null,
    recordedAt: recorded.recordedAt,
    occurredAt: recorded.occurredAt,
  });
}

export function historicalContactAudit(recordId: string, prepared: PreparedHistoricalContact) {
  return Object.freeze({
    // The shared privacy sanitizer may redact a numeric UUID fragment. Compare
    // the minimized representation; the journal keeps its exact audit FK and tx.
    type: HISTORICAL_CONTACT_PROTOCOL, recordId: redactTechnicalText(identifier(recordId)),
    beforeVersion: prepared.expectedInboxVersion,
    afterVersion: prepared.expectedInboxVersion + 1,
    outcome: 'NO_REWRITE' as const,
  });
}

export const HISTORICAL_CONVERSION_PROTOCOL = 'N14_HISTORICAL_CONVERSION_V1' as const;
export const HISTORICAL_CONVERSION_OUTCOME = 'HISTORICAL_CONTACT_BEFORE_CRM' as const;
export const historicalClientTypes = ['persona_fisica', 'ditta_individuale', 'societa', 'professionista',
  'soggetto_da_costituire', 'associazione', 'altro'] as const;

export function historicalConversionInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return deny('INVALID_INPUT');
  const v = value as Record<string, unknown>;
  const fields = ['commandId', 'leadId', 'expectedInboxVersion', 'expectedAssignmentId', 'contactId', 'clientType'];
  if (Object.keys(v).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(v, key))) return deny('INVALID_INPUT');
  for (const field of ['commandId', 'contactId']) {
    if (typeof v[field] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v[field])) return deny('INVALID_INPUT');
  }
  if (!Number.isSafeInteger(v.expectedInboxVersion) || Number(v.expectedInboxVersion) < 2
    || Number(v.expectedInboxVersion) > 2_147_483_646
    || !historicalClientTypes.includes(v.clientType as typeof historicalClientTypes[number])) return deny('INVALID_INPUT');
  return Object.freeze({
    protocol: HISTORICAL_CONVERSION_PROTOCOL, commandId: v.commandId as string,
    leadId: identifier(v.leadId), expectedInboxVersion: Number(v.expectedInboxVersion),
    expectedAssignmentId: identifier(v.expectedAssignmentId), contactId: v.contactId as string,
    clientType: v.clientType as typeof historicalClientTypes[number],
  });
}
export type HistoricalConversionInput = ReturnType<typeof historicalConversionInput>;

export function historicalConversionHash(input: HistoricalConversionInput, actorId: string, contactHash: string) {
  if (!/^[0-9a-f]{64}$/u.test(contactHash)) return deny('INVALID_INPUT');
  const { protocol, ...raw } = input;
  if (protocol !== HISTORICAL_CONVERSION_PROTOCOL) return deny('INVALID_INPUT');
  const normalized = historicalConversionInput(raw);
  return createHash('sha256').update(JSON.stringify({ input: normalized, actorId: identifier(actorId), contactHash })).digest('hex');
}

export function historicalConversionAudit(input: HistoricalConversionInput) {
  return { type: HISTORICAL_CONVERSION_PROTOCOL, recordId: redactTechnicalText(input.commandId),
    beforeVersion: input.expectedInboxVersion, afterVersion: input.expectedInboxVersion + 1,
    outcome: HISTORICAL_CONVERSION_OUTCOME };
}
