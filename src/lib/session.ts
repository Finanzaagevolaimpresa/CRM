import type { RoleCode } from '@prisma/client';

export type Session = {
  userId: string;
  role: RoleCode;
  expiresAt: number;
};

const allowedRoles = ['admin', 'direzione', 'commerciale', 'consulente', 'revisore', 'backoffice', 'amministrazione', 'collaboratore_limitato'] as const satisfies readonly RoleCode[];
const encoder = new TextEncoder();
const SESSION_TTL_SECONDS = 60 * 60 * 8;

export function isValidRole(role: string): role is RoleCode { return (allowedRoles as readonly string[]).includes(role); }

function getAuthSecret() {
  const secret = process.env.AUTH_SECRET;
  if (process.env.NODE_ENV !== 'development' && !secret) throw new Error('AUTH_SECRET is required outside development');
  return secret;
}
function toBase64Url(bytes: ArrayBuffer) { const binary = String.fromCharCode(...new Uint8Array(bytes)); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
async function hmac(payload: string, secret: string) { const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))); }

export async function signSessionCookie(session: Omit<Session, 'expiresAt'> & { expiresAt?: number }) {
  const secret = getAuthSecret();
  if (!secret) throw new Error('AUTH_SECRET is required to sign sessions');
  const expiresAt = session.expiresAt ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${session.userId}:${session.role}:${expiresAt}`;
  const signature = await hmac(payload, secret);
  return `${payload}:${signature}`;
}

export async function verifySessionCookie(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  let secret: string | undefined;
  try { secret = getAuthSecret(); } catch (error) { if (process.env.NODE_ENV !== 'development') throw error; return null; }
  if (!secret) return null;
  const parts = token.split(':');
  if (parts.length !== 4) return null;
  const [userId, role, expiresAtRaw, signature] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!userId || !role || !Number.isInteger(expiresAt) || !signature || !isValidRole(role)) return null;
  if (expiresAt <= Math.floor(Date.now() / 1000)) return null;
  const expected = await hmac(`${userId}:${role}:${expiresAt}`, secret);
  if (signature !== expected) return null;
  return { userId, role, expiresAt };
}
