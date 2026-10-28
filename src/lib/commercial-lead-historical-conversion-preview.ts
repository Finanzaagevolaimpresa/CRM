import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { historicalConversionInput, prepareHistoricalConversion, HistoricalContactError,
  type HistoricalContactReceipt, type HistoricalConversionInput } from './commercial-lead-historical-contact-contract';
import type { HistoricalContactPreviewAdmission } from './commercial-lead-historical-preview';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';

const protocol = 'N14_HISTORICAL_CONVERSION_PREVIEW_V1' as const;
const maxLifetime = 5 * 60_000;
const envelope = z.object({ payload: z.object({ protocol: z.literal(protocol), input: z.unknown(),
  contextDigest: z.string().regex(/^[a-f0-9]{64}$/u), keyVersion: z.number().int().positive(),
  issuedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe(),
}).strict(), proof: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type HistoricalConversionPreviewAdmission = HistoricalContactPreviewAdmission & Readonly<{
  contact: HistoricalContactReceipt; canCreateClient: boolean;
  clientProjection: { displayName: string; notes: string | null; leadUpdatedAt: string };
}>;
const stale = (): never => { throw new HistoricalContactError('STALE_CONTEXT'); };
function keyValid(key: PrivilegedStepUpKey) {
  if (!Number.isSafeInteger(key.version) || key.version < 1 || typeof key.secret !== 'string' || key.secret.length < 32) stale();
}
function prepare(raw: unknown, a: HistoricalConversionPreviewAdmission) {
  const input = historicalConversionInput(raw);
  for (const id of [a.sessionId, a.inboxItemId, a.cycleId]) z.string().uuid().parse(id);
  const basis = prepareHistoricalConversion(a.contact, { ...a.context, historicalContactExists: true,
    inboxItemId: a.inboxItemId, cycleId: a.cycleId, canCreateClient: a.canCreateClient });
  if (input.leadId !== a.context.leadId || input.expectedInboxVersion !== a.context.inboxVersion
    || input.expectedAssignmentId !== a.context.assignmentId || input.contactId !== a.contact.id) stale();
  const now = Date.parse(a.context.recordedAt);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(a.sessionExpiresAt) || a.sessionExpiresAt <= now) stale();
  const { recordedAt: _recordedAt, ...context } = a.context; void _recordedAt;
  const contextDigest = canonicalSha256({ sessionId: a.sessionId, sessionExpiresAt: a.sessionExpiresAt,
    inboxItemId: a.inboxItemId, cycleId: a.cycleId, context, contact: a.contact,
    canCreateClient: a.canCreateClient, clientProjection: a.clientProjection });
  return { input, basis, now, contextDigest };
}
function signature(key: PrivilegedStepUpKey, payload: unknown) {
  return createHmac('sha256', key.secret).update(`${protocol}:${key.version}:`).update(canonicalJson(payload)).digest('hex');
}
export function createHistoricalConversionPreview(key: PrivilegedStepUpKey, raw: unknown, a: HistoricalConversionPreviewAdmission) {
  keyValid(key); const p = prepare(raw, a);
  const payload = { protocol, input: p.input, contextDigest: p.contextDigest, keyVersion: key.version,
    issuedAt: p.now, expiresAt: Math.min(p.now + maxLifetime, a.sessionExpiresAt) };
  const token = Buffer.from(canonicalJson({ payload, proof: signature(key, payload) })).toString('base64url');
  if (token.length > 16_000) stale();
  return { token, input: p.input, leadLabel: a.clientProjection.displayName, notes: a.clientProjection.notes,
    occurredAt: p.basis.occurredAt, contactRecordedAt: a.contact.recordedAt,
    source: a.contact.input.source, evidenceReference: a.contact.input.evidenceReference,
    expiresAt: new Date(payload.expiresAt).toISOString() };
}
export function readHistoricalConversionPreview(key: PrivilegedStepUpKey, token: string,
  a: HistoricalConversionPreviewAdmission): HistoricalConversionInput | null {
  try {
    keyValid(key);
    if (typeof token !== 'string' || token.length > 16_000 || !/^[A-Za-z0-9_-]+$/u.test(token)) return null;
    const json = Buffer.from(token, 'base64url').toString('utf8');
    if (Buffer.from(json).toString('base64url') !== token) return null;
    const parsed = envelope.parse(JSON.parse(json)), value = parsed.payload;
    if (canonicalJson(parsed) !== json || value.keyVersion !== key.version || !value.input
      || typeof value.input !== 'object' || Array.isArray(value.input)) return null;
    const { protocol: inputProtocol, ...raw } = value.input as Record<string, unknown>;
    if (inputProtocol !== 'N14_HISTORICAL_CONVERSION_V1') return null;
    const p = prepare(raw, a);
    if (canonicalJson(p.input) !== canonicalJson(value.input) || p.contextDigest !== value.contextDigest
      || value.issuedAt > p.now || value.expiresAt <= p.now
      || value.expiresAt !== Math.min(value.issuedAt + maxLifetime, a.sessionExpiresAt)) return null;
    return timingSafeEqual(Buffer.from(parsed.proof, 'hex'), Buffer.from(signature(key, value), 'hex')) ? p.input : null;
  } catch { return null; }
}
