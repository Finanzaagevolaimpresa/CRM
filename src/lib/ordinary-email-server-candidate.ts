import { cookies, headers } from 'next/headers';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { previewStoredOrdinaryEmail, rejectStoredOrdinaryEmail } from './ordinary-email-store-candidate';
import { confirmAndTransmitStoredOrdinaryEmail } from './ordinary-email-service-candidate';
import type { OrdinarySmtpDependencies } from './ordinary-email-smtp-candidate';
import { assertOrdinaryEmailRequestOrigin, ordinaryEmailPreviewInput, ordinaryEmailConfirmationInput, ordinaryEmailRejectionInput } from './ordinary-email-request-contract';

/** Private Next server adapter. No action/route registration, default connector
 * or provider activation. A future action passes only the strict input below;
 * server identity/credentials never come from its form or previous UI state. */
async function nativeRequest(action?: 'ORDINARY_EMAIL_CONFIRM_SEND' | 'ORDINARY_EMAIL_REJECT') {
  const session = await requirePermission('practice_communications.read');
  const h = await headers();
  assertOrdinaryEmailRequestOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site') }, process.env);
  if (action) await requireEnforcedPrivilegedMutation(session, action);
  const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
  const sessionToken = store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value;
  if (!key || !sessionToken) throw new Error('ORDINARY_EMAIL_REQUEST_DENIED');
  return { session, runtime: { key }, credentials: { sessionToken, stepUpToken: store.get(privilegedStepUpCookieName)?.value } };
}

export async function previewOrdinaryEmailFromRequest(raw: unknown) {
  const input = ordinaryEmailPreviewInput.parse(raw), admitted = await nativeRequest();
  return previewStoredOrdinaryEmail(prisma, admitted.session, input.messageId, admitted.runtime);
}

export async function confirmOrdinaryEmailFromRequest(raw: unknown,
  transport: Pick<OrdinarySmtpDependencies, 'readQualifiedTransport' | 'connectTls'>,
  control: { deadline: number; signal: AbortSignal }) {
  const input = ordinaryEmailConfirmationInput.parse(raw), admitted = await nativeRequest('ORDINARY_EMAIL_CONFIRM_SEND');
  return confirmAndTransmitStoredOrdinaryEmail(prisma, admitted.session,
    { messageId: input.messageId, requestId: input.requestId, previewToken: input.previewToken },
    admitted.credentials, admitted.runtime, transport, control);
}

export async function rejectOrdinaryEmailFromRequest(raw: unknown) {
  const input = ordinaryEmailRejectionInput.parse(raw), admitted = await nativeRequest('ORDINARY_EMAIL_REJECT');
  return rejectStoredOrdinaryEmail(prisma, admitted.session, input, admitted.credentials, admitted.runtime);
}
