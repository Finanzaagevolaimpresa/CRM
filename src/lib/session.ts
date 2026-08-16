export type SessionCookie = {
  userId: string;
  expiresAt: number;
  sessionId?: string;
};
export type InternalSessionMode = 'legacy' | 'registry';
const encoder = new TextEncoder();
export const SESSION_TTL_SECONDS = 60 * 60 * 8;
const REGISTRY_COOKIE_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;

export class InternalSessionConfigurationError extends Error {
  constructor() { super('Internal session mode is not configured canonically'); }
}
export function internalSessionMode(value = process.env.INTERNAL_SESSION_MODE): InternalSessionMode {
  if (value === 'legacy' || value === 'registry') return value;
  throw new InternalSessionConfigurationError();
}
function getAuthSecret() {
  const secret = process.env.AUTH_SECRET;
  if (process.env.NODE_ENV !== 'development' && !secret) throw new Error('AUTH_SECRET is required outside development');
  return secret;
}
function toBase64Url(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function fromBase64Url(value: string) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  try { return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)); } catch { return null; }
}
async function hmac(payload: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}
export async function signSessionCookie(session: SessionCookie & { expiresAt?: number }) {
  const secret = getAuthSecret();
  if (!secret) throw new Error('AUTH_SECRET is required to sign sessions');
  const expiresAt = session.expiresAt ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${session.userId}:${expiresAt}`;
  return `${payload}:${await hmac(payload, secret)}`;
}
export async function verifySessionCookie(token: string | undefined): Promise<SessionCookie | null> {
  if (!token) return null;
  let secret: string | undefined;
  try { secret = getAuthSecret(); } catch (error) { if (process.env.NODE_ENV !== 'development') throw error; return null; }
  if (!secret) return null;
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  const [userId, raw, signature] = parts; const expiresAt = Number(raw);
  if (!userId || !Number.isInteger(expiresAt) || !signature || expiresAt <= Math.floor(Date.now() / 1000)) return null;
  if (signature !== await hmac(`${userId}:${expiresAt}`, secret)) return null;
  return { userId, expiresAt };
}
export function parseRegistrySessionToken(cookie: string | undefined) {
  if (!cookie || !REGISTRY_COOKIE_PATTERN.test(cookie)) return null;
  const bytes = fromBase64Url(cookie.slice(3));
  return bytes?.length === 32 ? bytes : null;
}
export function createRegistrySessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { token: `v1.${toBase64Url(bytes)}`, bytes };
}
export async function digestRegistrySessionToken(bytes: Uint8Array) {
  if (bytes.length !== 32) throw new Error('Registry session token must contain exactly 32 bytes');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer));
}
export function isCanonicalRegistrySessionCookie(cookie: string | undefined) {
  return parseRegistrySessionToken(cookie) !== null;
}
