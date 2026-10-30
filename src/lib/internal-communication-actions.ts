'use server';

import { cookies, headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { assertOrdinaryEmailRequestOrigin } from './ordinary-email-request-contract';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { PrivilegedAdmissionRequired, privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { previewInternalCommunication, confirmInternalCommunication, archiveInternalCommunication } from './internal-communications';

async function admission(confirm: boolean) {
  const session = await requireSession(), h = await headers();
  assertOrdinaryEmailRequestOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site') }, process.env);
  if (confirm) await requireEnforcedPrivilegedMutation(session, 'INTERNAL_COMMUNICATION_MANAGE', { inline: true });
  const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
  const sessionToken = store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value;
  if (!key || !sessionToken) throw new Error('DENIED');
  return { session, credentials: { key, sessionToken, stepUpToken: store.get(privilegedStepUpCookieName)?.value } };
}

export async function previewInternalCommunicationAction(raw: unknown) {
  try {
    const a = await admission(false);
    return { status: 'PREVIEW' as const, preview: await previewInternalCommunication(prisma, a.session, raw, a.credentials) };
  } catch (error) { unstable_rethrow(error); return { status: 'CHECK_CURRENT' as const }; }
}

export async function confirmInternalCommunicationAction(raw: unknown, evidenceHash: string) {
  try {
    const a = await admission(true);
    const result = await confirmInternalCommunication(prisma, a.session, raw, evidenceHash, a.credentials);
    revalidatePath('/communications');
    return { status: 'RECORDED' as const, id: result.id };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return { status: 'STEP_UP_REQUIRED' as const, message: error.formState.message };
    unstable_rethrow(error);
    // Includes a lost commit response. Reload the conversation before any retry.
    return { status: 'CHECK_CURRENT' as const };
  }
}

export async function archiveInternalCommunicationAction(raw: unknown) {
  try {
    const a = await admission(true);
    await archiveInternalCommunication(prisma, a.session, raw, a.credentials);
    revalidatePath('/communications');
    return { status: 'RECORDED' as const };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return { status: 'STEP_UP_REQUIRED' as const, message: error.formState.message };
    unstable_rethrow(error); return { status: 'CHECK_CURRENT' as const };
  }
}
