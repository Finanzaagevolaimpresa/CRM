import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';

export const DIRECT_TEST_FROM = 'comunicazioni@finanzaagevolaimpresa.it';
export const DIRECT_TEST_SUBJECT = 'FAI CRM — test tecnico di invio diretto';
export const DIRECT_TEST_BODY = 'Messaggio tecnico di collaudo dal CRM FAI. Nessun dato cliente o contenuto promozionale.';
export type DirectTestOutcome = 'ACCEPTED' | 'NOT_SENT' | 'UNCERTAIN';
export class DirectTestError extends Error {
  constructor(readonly code: 'DISABLED' | 'INVALID' | 'DENIED' | 'STALE' | 'SENDER_NOT_READY') { super(code); }
}
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,79}$/);
const configSchema = z.object({
  reference: identifier,
  recipient: z.string().email().max(254).regex(/^[\x21-\x7e]+$/),
  host: z.string().max(253).regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/),
  password: z.string().min(1).max(1024),
  approvalKey: z.string().regex(/^[a-f0-9]{64,128}$/),
}).strict();
export type DirectTestConfig = z.infer<typeof configSchema>;
// Server-only inputs: no provider host, credential, sender or recipient comes from a form.
export function readDirectTestConfig(env: Readonly<Record<string, string | undefined>> = process.env): DirectTestConfig | null {
  if (env.DIRECT_EMAIL_TEST_MODE !== 'enforced') return null;
  const parsed = configSchema.safeParse({ reference: env.DIRECT_EMAIL_TEST_REFERENCE,
    recipient: env.DIRECT_EMAIL_TEST_RECIPIENT, host: env.DIRECT_EMAIL_TEST_SMTP_HOST,
    password: env.DIRECT_EMAIL_TEST_SMTP_PASSWORD, approvalKey: env.DIRECT_EMAIL_TEST_APPROVAL_KEY });
  if (!parsed.success) return null;
  return parsed.data;
}
export function directTestDigest(config: DirectTestConfig, data: unknown) {
  return createHmac('sha256', Buffer.from(config.approvalKey, 'hex')).update(canonicalJson(data)).digest('hex');
}
export function directTestMessage(config: DirectTestConfig) {
  return Object.freeze({ from: DIRECT_TEST_FROM, replyTo: DIRECT_TEST_FROM, to: config.recipient,
    subject: DIRECT_TEST_SUBJECT, body: DIRECT_TEST_BODY });
}
const previewSchema = z.object({
  protocol: z.literal('FAI_DIRECT_EMAIL_TEST_V1'), reference: identifier,
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive(),
}).strict();
export type DirectTestPreview = z.infer<typeof previewSchema>;
export function signDirectTestPreview(config: DirectTestConfig, preview: DirectTestPreview) {
  const payload = Buffer.from(JSON.stringify(previewSchema.parse(preview))).toString('base64url');
  return `${payload}.${directTestDigest(config, payload)}`;
}
export function verifyDirectTestPreview(config: DirectTestConfig, token: string, now = Date.now()) {
  if (token.length > 2048) throw new DirectTestError('INVALID');
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac?.match(/^[a-f0-9]{64}$/) || extra !== undefined
    || !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(directTestDigest(config, payload), 'hex'))) throw new DirectTestError('INVALID');
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new DirectTestError('INVALID'); }
  const parsed = previewSchema.safeParse(raw);
  if (!parsed.success) throw new DirectTestError('INVALID');
  if (parsed.data.reference !== config.reference || parsed.data.expiresAt <= now
    || parsed.data.expiresAt > now + 5 * 60_000) throw new DirectTestError('STALE');
  return parsed.data;
}
