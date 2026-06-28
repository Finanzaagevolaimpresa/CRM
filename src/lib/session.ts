export type SessionCookie = {
  userId: string;
  expiresAt: number;
};

const encoder = new TextEncoder();
const SESSION_TTL_SECONDS = 60 * 60 * 8;

function getAuthSecret() {
  const secret = process.env.AUTH_SECRET;
  if (process.env.NODE_ENV !== 'development' && !secret) throw new Error('AUTH_SECRET is required outside development');
  return secret;
}
function toBase64Url(bytes: ArrayBuffer) { const binary = String.fromCharCode(...new Uint8Array(bytes)); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
async function hmac(payload: string, secret: string) { const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))); }

export async function signSessionCookie(session: SessionCookie & { expiresAt?: number }) {
  const secret = getAuthSecret();
  if (!secret) throw new Error('AUTH_SECRET is required to sign sessions');
  const expiresAt = session.expiresAt ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${session.userId}:${expiresAt}`;
  const signature = await hmac(payload, secret);
  return `${payload}:${signature}`;
}

export async function verifySessionCookie(token: string | undefined): Promise<SessionCookie | null> {
  if (!token) return null;
  let secret: string | undefined;
  try { secret = getAuthSecret(); } catch (error) { if (process.env.NODE_ENV !== 'development') throw error; return null; }
  if (!secret) return null;
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  const [userId, expiresAtRaw, signature] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!userId || !Number.isInteger(expiresAt) || !signature) return null;
  if (expiresAt <= Math.floor(Date.now() / 1000)) return null;
  const expected = await hmac(`${userId}:${expiresAt}`, secret);
  if (signature !== expected) return null;
  return { userId, expiresAt };
}
