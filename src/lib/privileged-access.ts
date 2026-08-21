import bcrypt from 'bcryptjs';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AuthSession } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import {
  isAllowedMutationOrigin,
  privilegedAccessMode,
} from './application-security-policy';
import {
  createPrivilegedStepUpToken,
  PRIVILEGED_STEP_UP_TTL_SECONDS,
  verifyPrivilegedStepUpToken,
} from './privileged-step-up-token';

const sessionCookieName = process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session';
export const privilegedStepUpCookieName = 'fai_crm_privileged_step_up';

export const privilegedMutationCodes = [
  'USER_CREATE',
  'USER_ACTIVATE',
  'USER_ROLE_UPDATE',
  'USER_DEACTIVATE',
  'USER_PERMISSION_OVERRIDE_UPDATE',
  'USER_PERMISSION_OVERRIDE_RESET',
  'AI_AGENT_CONFIG_UPDATE',
  'AI_CONTROL_SETTING_UPDATE',
  'AI_EXECUTION_APPROVE',
  'AI_EXECUTION_REJECT',
  'AI_EXECUTION_INFORMATION_REQUEST',
  'AI_EXECUTION_REVOKE',
  'AI_ORCHESTRATOR_GLOBAL_POLICY_UPDATE',
  'AI_ORCHESTRATOR_SCOPE_POLICY_UPDATE',
  'LEAD_DUPLICATE_RESOLVE',
] as const;

export type PrivilegedMutationCode = (typeof privilegedMutationCodes)[number];

async function auditStepUp(
  actorId: string,
  event: 'privileged_step_up_established' | 'blocked_privileged_step_up',
  after: { code: string; action?: PrivilegedMutationCode },
) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId,
        event,
        entityType: 'User',
        entityId: actorId,
        after,
      },
    });
  } catch {
    // Authentication and authorization remain fail-closed if secondary auditing fails.
  }
}

async function mutationOriginAllowed() {
  const requestHeaders = await headers();
  return isAllowedMutationOrigin({
    origin: requestHeaders.get('origin'),
    secFetchSite: requestHeaders.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL,
  });
}

async function activeStepUpForSession(session: AuthSession) {
  const store = await cookies();
  const sessionToken = store.get(sessionCookieName)?.value;
  const stepUpToken = store.get(privilegedStepUpCookieName)?.value;
  if (!sessionToken || !stepUpToken) return false;
  const key = await loadActivePrivilegedStepUpKey(prisma);
  return Boolean(key && verifyPrivilegedStepUpToken({
    token: stepUpToken,
    key,
    expectedUserId: session.userId,
    sessionToken,
  }));
}

export async function requirePrivilegedMutation(
  session: AuthSession,
  action: PrivilegedMutationCode,
) {
  let mode: 'disabled' | 'enforced';
  try {
    mode = privilegedAccessMode();
  } catch {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', { code: 'CONFIGURATION_INVALID', action });
    redirect('/settings/security?status=unavailable');
  }
  if (mode === 'disabled') return session;
  if (!await mutationOriginAllowed()) {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', { code: 'ORIGIN_DENIED', action });
    redirect('/settings/security?status=required');
  }
  if (!await activeStepUpForSession(session)) {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', { code: 'STEP_UP_REQUIRED', action });
    redirect('/settings/security?status=required');
  }
  return session;
}

export async function requireEnforcedPrivilegedMutation(
  session: AuthSession,
  action: PrivilegedMutationCode,
) {
  let mode: 'disabled' | 'enforced';
  try {
    mode = privilegedAccessMode();
  } catch {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', {
      code: 'CONFIGURATION_INVALID',
      action,
    });
    redirect('/settings/security?status=unavailable');
  }
  if (mode !== 'enforced') {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', {
      code: 'ENFORCEMENT_REQUIRED',
      action,
    });
    redirect('/settings/security?status=unavailable');
  }
  if (!await mutationOriginAllowed()) {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', {
      code: 'ORIGIN_DENIED',
      action,
    });
    redirect('/settings/security?status=required');
  }
  const store = await cookies();
  const sessionToken = store.get(sessionCookieName)?.value;
  const stepUpToken = store.get(privilegedStepUpCookieName)?.value;
  const key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', {
      code: 'KEY_UNAVAILABLE',
      action,
    });
    redirect('/settings/security?status=unavailable');
  }
  if (!sessionToken || !stepUpToken || !verifyPrivilegedStepUpToken({
    token: stepUpToken,
    key,
    expectedUserId: session.userId,
    sessionToken,
  })) {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', {
      code: 'STEP_UP_REQUIRED',
      action,
    });
    redirect('/settings/security?status=required');
  }
  return session;
}

export async function privilegedAccessReadiness(session: AuthSession) {
  let mode: 'disabled' | 'enforced' | 'invalid' = 'invalid';
  try { mode = privilegedAccessMode(); } catch { /* minimized readiness state */ }
  if (mode !== 'enforced') return { mode, keyReady: false, active: false } as const;
  const keyReady = Boolean(await loadActivePrivilegedStepUpKey(prisma));
  const active = keyReady && await activeStepUpForSession(session);
  return { mode, keyReady, active } as const;
}

export async function establishPrivilegedStepUp(session: AuthSession, password: string) {
  if (privilegedAccessMode() !== 'enforced') return 'DISABLED' as const;
  if (!await mutationOriginAllowed()) {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', { code: 'ORIGIN_DENIED' });
    return 'DENIED' as const;
  }
  const key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', { code: 'KEY_UNAVAILABLE' });
    return 'UNAVAILABLE' as const;
  }
  const store = await cookies();
  const sessionToken = store.get(sessionCookieName)?.value;
  if (!sessionToken || password.length < 1 || password.length > 1024) {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', { code: 'CREDENTIALS_INVALID' });
    return 'DENIED' as const;
  }
  const user = await prisma.user.findFirst({
    where: { id: session.userId, active: true, deletedAt: null },
    select: { passwordHash: true },
  });
  if (!user || !await bcrypt.compare(password, user.passwordHash)) {
    await auditStepUp(session.userId, 'blocked_privileged_step_up', { code: 'CREDENTIALS_INVALID' });
    return 'DENIED' as const;
  }
  const now = Math.floor(Date.now() / 1000);
  const token = createPrivilegedStepUpToken({
    key,
    userId: session.userId,
    sessionToken,
    nowSeconds: now,
  });
  store.set(privilegedStepUpCookieName, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date((now + PRIVILEGED_STEP_UP_TTL_SECONDS) * 1000),
    priority: 'high',
  });
  await auditStepUp(session.userId, 'privileged_step_up_established', {
    code: 'ESTABLISHED',
  });
  return 'ESTABLISHED' as const;
}

export async function clearPrivilegedStepUpCookie() {
  (await cookies()).set(privilegedStepUpCookieName, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(0),
    priority: 'high',
  });
}
