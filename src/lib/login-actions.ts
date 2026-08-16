'use server';

import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from './prisma';
import { createRegistryLoginSession, logoutInternalSession } from './internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken, internalSessionMode, signSessionCookie } from './session';

const cookieName = process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session';
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const demoAdminEmail = 'admin@fai.local';
const demoAdminPassword = 'ChangeMe123!';

function sessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(expiresAt * 1000),
  };
}

async function createLoginSession(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user || !user.active) return false;

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) return false;

  if (internalSessionMode() === 'registry') {
    const { token, bytes } = createRegistrySessionToken();
    const tokenDigest = await digestRegistrySessionToken(bytes);
    const session = await createRegistryLoginSession(prisma, {
      userId: user.id,
      tokenDigest,
    });
    if (!session) return false;
    (await cookies()).set(cookieName, token, sessionCookieOptions(Math.floor(session.expiresAt.getTime() / 1000)));
    return true;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signSessionCookie({ userId: user.id, expiresAt });
  (await cookies()).set(cookieName, token, sessionCookieOptions(expiresAt));
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await prisma.auditLog.create({ data: { actorId: user.id, event: 'login', entityType: 'User', entityId: user.id } });
  return true;
}

export async function loginAction(formData: FormData) {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  let ok = false;
  try { ok = Boolean(email && password && await createLoginSession(email, password)); } catch { ok = false; }
  if (!ok) {
    redirect('/login?error=invalid');
  }

  redirect('/dashboard');
}

export async function demoAdminLoginAction() {
  if (process.env.APP_ENV !== 'development') {
    redirect('/login');
  }

  let ok = false;
  try { ok = await createLoginSession(demoAdminEmail, demoAdminPassword); } catch { ok = false; }
  if (!ok) {
    redirect('/login?error=demo-unavailable');
  }

  redirect('/dashboard');
}

export async function logoutAction() {
  const token = (await cookies()).get(cookieName)?.value;
  let mode: 'legacy' | 'registry';
  try { mode = internalSessionMode(); } catch { redirect('/login?error=logout-unavailable'); }
  if (mode === 'registry') {
    try { await prisma.$transaction((tx) => logoutInternalSession(tx, token)); }
    catch { redirect('/login?error=logout-unavailable'); }
    (await cookies()).delete(cookieName);
    redirect('/login');
  }
  const { verifySessionCookie } = await import('./session');
  const session = await verifySessionCookie(token);
  if (session) await prisma.auditLog.create({ data: { actorId: session.userId, event: 'logout', entityType: 'User', entityId: session.userId } });
  (await cookies()).delete(cookieName);
  redirect('/login');
}
