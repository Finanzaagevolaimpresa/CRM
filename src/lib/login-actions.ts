'use server';

import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from './prisma';
import { signSessionCookie } from './session';

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
  if (!user) return false;

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) return false;

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signSessionCookie({ userId: user.id, role: user.role, expiresAt });
  (await cookies()).set(cookieName, token, sessionCookieOptions(expiresAt));
  return true;
}

export async function loginAction(formData: FormData) {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  if (!email || !password || !(await createLoginSession(email, password))) {
    redirect('/login?error=invalid');
  }

  redirect('/dashboard');
}

export async function demoAdminLoginAction() {
  if (process.env.APP_ENV !== 'development') {
    redirect('/login');
  }

  if (!(await createLoginSession(demoAdminEmail, demoAdminPassword))) {
    redirect('/login?error=demo-unavailable');
  }

  redirect('/dashboard');
}

export async function logoutAction() {
  (await cookies()).delete(cookieName);
  redirect('/login');
}
