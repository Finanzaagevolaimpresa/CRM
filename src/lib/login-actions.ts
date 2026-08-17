'use server';

import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from './prisma';
import { createRegistryLoginSession, logoutInternalSession } from './internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken, internalSessionMode, signSessionCookie } from './session';
import {
  clearLoginThrottle,
  loginAttemptAllowed,
  loginThrottleRuntime,
  recordLoginFailure,
} from './login-throttle';
import { clearPrivilegedStepUpCookie } from './privileged-access';

const cookieName = process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session';
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const demoAdminEmail = 'admin@fai.local';
const demoAdminPassword = 'ChangeMe123!';
const dummyPasswordHash = '$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';

function sessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(expiresAt * 1000),
    priority: 'high' as const,
  };
}

async function createLoginSession(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail.length < 3 || normalizedEmail.length > 254 || password.length < 1 || password.length > 1024) return false;
  const throttle = loginThrottleRuntime(normalizedEmail);
  if (!throttle) return false;
  if (throttle.mode === 'enforced' && !await loginAttemptAllowed(prisma, throttle.keyDigest)) return false;

  const user = await prisma.user.findFirst({
    where: { email: normalizedEmail, deletedAt: null },
    select: { id: true, active: true, passwordHash: true },
  });
  const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? dummyPasswordHash);
  if (!user || !user.active || !passwordMatches) {
    if (throttle.mode === 'enforced') {
      await recordLoginFailure(prisma, throttle.keyDigest, throttle.configuration);
    }
    return false;
  }

  if (throttle.mode === 'enforced') await clearLoginThrottle(prisma, throttle.keyDigest);

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
    await clearPrivilegedStepUpCookie();
    redirect('/login');
  }
  const { verifySessionCookie } = await import('./session');
  const session = await verifySessionCookie(token);
  if (session) await prisma.auditLog.create({ data: { actorId: session.userId, event: 'logout', entityType: 'User', entityId: session.userId } });
  (await cookies()).delete(cookieName);
  await clearPrivilegedStepUpCookie();
  redirect('/login');
}
