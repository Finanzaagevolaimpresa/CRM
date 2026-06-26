import type { RoleCode } from '@prisma/client';

export type Session = {
  userId: string;
  role: RoleCode;
};

const allowedRoles = [
  'admin',
  'direzione',
  'commerciale',
  'consulente',
  'revisore',
  'backoffice',
  'amministrazione',
] as const satisfies readonly RoleCode[];

const encoder = new TextEncoder();

export function isValidRole(role: string): role is RoleCode {
  return (allowedRoles as readonly string[]).includes(role);
}

function getAuthSecret() {
  return process.env.AUTH_SECRET;
}

function toBase64Url(bytes: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function hmac(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

export async function signSessionCookie(session: Session) {
  const secret = getAuthSecret();
  if (!secret) throw new Error('AUTH_SECRET is required to sign sessions');
  const payload = `${session.userId}:${session.role}`;
  const signature = await hmac(payload, secret);
  return `${payload}:${signature}`;
}

export async function verifySessionCookie(token: string | undefined): Promise<Session | null> {
  if (!token) return null;

  const secret = getAuthSecret();
  if (!secret) return null;

  const parts = token.split(':');
  if (parts.length !== 3) return null;

  const [userId, role, signature] = parts;
  if (!userId || !role || !signature || !isValidRole(role)) return null;

  const expected = await hmac(`${userId}:${role}`, secret);
  if (signature !== expected) return null;

  return { userId, role };
}
