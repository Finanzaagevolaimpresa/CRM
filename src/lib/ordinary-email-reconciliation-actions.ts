'use server';
import { assertTechnicalServerAction } from '@/lib/technical-surface-guards';

import { cookies, headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedAccessMode, isAllowedMutationOrigin } from './application-security-policy';
import { internalSessionMode } from './session';
import { privilegedAccessReadiness, privilegedStepUpCookieName } from './privileged-access';
import { previewStoredOrdinaryRecovery, confirmStoredOrdinaryRecovery } from './ordinary-email-reconciliation';
import type { OrdinaryRecoveryResult } from './ordinary-email-reconciliation-contract';

async function native() {
  const session = await getSession(), h = await headers();
  if (!session || session.role !== 'admin'
    || internalSessionMode(process.env.INTERNAL_SESSION_MODE ?? '') !== 'registry'
    || privilegedAccessMode(process.env.PRIVILEGED_ACCESS_MODE ?? '') !== 'enforced'
    || !isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
      configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new Error('ORDINARY_RECOVERY_DENIED');
  const key = await loadActivePrivilegedStepUpKey(prisma), jar = await cookies();
  if (!key) throw new Error('ORDINARY_RECOVERY_DENIED');
  return { session, runtime: { key }, credentials: {
    sessionToken: jar.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: jar.get(privilegedStepUpCookieName)?.value } };
}
export async function previewOrdinaryRecoveryAction(_previous: OrdinaryRecoveryResult, form: FormData): Promise<OrdinaryRecoveryResult> {
  await assertTechnicalServerAction("ordinary-email-reconciliation-actions:previewOrdinaryRecoveryAction");
  try {
    const admitted = await native();
    return await previewStoredOrdinaryRecovery(prisma,admitted.session,
      { messageId: form.get('messageId'), attemptId: form.get('attemptId') },admitted.runtime);
  } catch (error) { unstable_rethrow(error); return { status: 'UNAVAILABLE' }; }
}
export async function confirmOrdinaryRecoveryAction(_previous: OrdinaryRecoveryResult, form: FormData): Promise<OrdinaryRecoveryResult> {
  await assertTechnicalServerAction("ordinary-email-reconciliation-actions:confirmOrdinaryRecoveryAction");
  try {
    const admitted = await native(), readiness = await privilegedAccessReadiness(admitted.session);
    if (!readiness.active) return readiness.mode === 'enforced' && readiness.keyReady
      ? { status: 'STEP_UP_REQUIRED' } : { status: 'UNAVAILABLE' };
    const result = await confirmStoredOrdinaryRecovery(prisma,admitted.session,
      { messageId: form.get('messageId'), attemptId: form.get('attemptId'), token: form.get('token'),
        reason: form.get('reason'), confirmed: form.get('confirmed') === 'on' },admitted.credentials,admitted.runtime);
    revalidatePath('/communications');
    return result;
  } catch (error) {
    unstable_rethrow(error);
    // A lost response is resolved by reading the same attempt; never resubmit or send.
    return { status: 'CHECK_CURRENT' };
  }
}
