import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { historicalContactInput, HistoricalContactError, prepareHistoricalContact,
  type HistoricalContactContext, type HistoricalContactInput } from './commercial-lead-historical-contact-contract';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';

const protocol = 'N14_HISTORICAL_CONTACT_PREVIEW_V1' as const;
const maxLifetimeMs = 5 * 60_000;
const maxTokenLength = 16_000;
const envelope = z.object({ payload: z.object({
  protocol: z.literal(protocol), input: z.unknown(), contextDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  keyVersion: z.number().int().positive(), issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().positive().safe(),
}).strict(), proof: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

/** Built only from the locked live session and N14 context, never form data.
 * Using the existing registered key does not confer Admin or send authority. */
export type HistoricalContactPreviewAdmission = Readonly<{
  sessionId: string; sessionExpiresAt: number; inboxItemId: string; cycleId: string;
  context: HistoricalContactContext;
}>;
function stale(): never { throw new HistoricalContactError('STALE_CONTEXT'); }
function validKey(key: PrivilegedStepUpKey) {
  if (!Number.isSafeInteger(key.version) || key.version < 1 || typeof key.secret !== 'string'
    || key.secret.length < 32) stale();
}
function prepare(raw: unknown, admission: HistoricalContactPreviewAdmission) {
  z.string().uuid().parse(admission.sessionId);
  z.string().uuid().parse(admission.inboxItemId);
  z.string().uuid().parse(admission.cycleId);
  const input = historicalContactInput(raw);
  const prepared = prepareHistoricalContact(input, admission.context);
  const now = Date.parse(prepared.recordedAt);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(admission.sessionExpiresAt)
    || admission.sessionExpiresAt <= now) stale();
  // Only the database observation time changes between preview and confirm.
  // Every authorization, scope, version and lifecycle fact remains bound.
  const { recordedAt: _recordedAt, ...context } = admission.context;
  void _recordedAt;
  const contextDigest = canonicalSha256({ sessionId: admission.sessionId, sessionExpiresAt: admission.sessionExpiresAt,
    inboxItemId: admission.inboxItemId, cycleId: admission.cycleId, context });
  return { input, prepared, now, contextDigest };
}
function signature(key: PrivilegedStepUpKey, payload: unknown) {
  return createHmac('sha256', key.secret).update(`${protocol}:${key.version}:`).update(canonicalJson(payload)).digest('hex');
}
function rawInput(value: HistoricalContactInput) {
  const { protocol: inputProtocol, ...raw } = value;
  if (inputProtocol !== 'N14_HISTORICAL_CONTACT_V1') stale();
  return raw;
}

/** Stateless read-only preview. A signed preview is not a durable receipt. */
export function createHistoricalContactPreview(key: PrivilegedStepUpKey, raw: unknown, admission: HistoricalContactPreviewAdmission) {
  validKey(key);
  const p = prepare(raw, admission);
  const payload = { protocol, input: p.input, contextDigest: p.contextDigest, keyVersion: key.version,
    issuedAt: p.now, expiresAt: Math.min(p.now + maxLifetimeMs, admission.sessionExpiresAt) };
  const token = Buffer.from(canonicalJson({ payload, proof: signature(key, payload) })).toString('base64url');
  if (token.length > maxTokenLength) stale();
  return { token, input: p.input, initializedAt: admission.context.initializedAt,
    previewedAt: p.prepared.recordedAt, expiresAt: new Date(payload.expiresAt).toISOString(), slaEffect: p.prepared.slaEffect };
}

/** Re-run current authorization before calling; return only the exact signed
 * input. Session/key rotation, reassignment, changed content/version and expiry
 * invalidate the preview. An absent receipt still requires reconciliation. */
export function readHistoricalContactPreview(key: PrivilegedStepUpKey, token: string,
  admission: HistoricalContactPreviewAdmission): HistoricalContactInput | null {
  try {
    validKey(key);
    if (typeof token !== 'string' || token.length > maxTokenLength || !/^[A-Za-z0-9_-]+$/u.test(token)) return null;
    const json = Buffer.from(token, 'base64url').toString('utf8');
    if (Buffer.from(json).toString('base64url') !== token) return null;
    const parsed = envelope.parse(JSON.parse(json)), value = parsed.payload;
    if (canonicalJson(parsed) !== json || value.keyVersion !== key.version) return null;
    const p = prepare(rawInput(value.input as HistoricalContactInput), admission);
    if (canonicalJson(p.input) !== canonicalJson(value.input) || value.contextDigest !== p.contextDigest
      || value.issuedAt > p.now || value.expiresAt <= p.now
      || value.expiresAt !== Math.min(value.issuedAt + maxLifetimeMs, admission.sessionExpiresAt)) return null;
    return timingSafeEqual(Buffer.from(parsed.proof, 'hex'), Buffer.from(signature(key, value), 'hex')) ? p.input : null;
  } catch { return null; }
}
