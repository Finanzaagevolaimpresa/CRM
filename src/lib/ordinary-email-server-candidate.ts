import { connect } from 'node:tls';
import { cookies, headers } from 'next/headers';
import { requirePermission, type AuthSession } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { previewStoredOrdinaryEmail, rejectStoredOrdinaryEmail } from './ordinary-email-store-candidate';
import { confirmStoredOrdinaryEmailUsingExistingTransport } from './ordinary-email-runtime-candidate';
import { assertOrdinaryEmailRequestOrigin, ordinaryEmailPreviewInput, ordinaryEmailConfirmationInput, ordinaryEmailRejectionInput } from './ordinary-email-request-contract';
import { internalSessionMode } from './session';
import { privilegedAccessMode } from './application-security-policy';
import { readOrdinaryEmailUiAuthority } from './ordinary-email-ui-authority';
import { createOrdinaryTransportResolver } from './ordinary-email-transport-binding';

/** Native server adapter. No binding or channel is activated here.
 * Actions pass only strict input;
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

export async function ordinaryEmailUiAuthorityFromRequest(session: AuthSession) {
  if (internalSessionMode(process.env.INTERNAL_SESSION_MODE ?? '') !== 'registry'
    || privilegedAccessMode(process.env.PRIVILEGED_ACCESS_MODE ?? '') !== 'enforced') return null;
  const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
  const sessionToken = store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value;
  if (!key || !sessionToken) return null;
  return readOrdinaryEmailUiAuthority(prisma, session, key,
    { sessionToken, stepUpToken: store.get(privilegedStepUpCookieName)?.value });
}

export async function previewOrdinaryEmailFromRequest(raw: unknown) {
  const input = ordinaryEmailPreviewInput.parse(raw), admitted = await nativeRequest();
  const resolver = createOrdinaryTransportResolver(admitted.runtime.key, { readEnvironment: () => process.env, connectTls: connect });
  return previewStoredOrdinaryEmail(prisma, admitted.session, input.messageId, { ...admitted.runtime,
    transportAvailable: channel => {
      try { resolver.assertChannel(channel); return true; } catch { return false; }
    } });
}

export async function confirmOrdinaryEmailFromRequest(raw: unknown) {
  const input = ordinaryEmailConfirmationInput.parse(raw), admitted = await nativeRequest('ORDINARY_EMAIL_CONFIRM_SEND');
  return confirmStoredOrdinaryEmailUsingExistingTransport(prisma, admitted.session,
    { messageId: input.messageId, requestId: input.requestId, previewToken: input.previewToken },
    admitted.credentials, admitted.runtime, { readEnvironment: () => process.env, connectTls: connect },
    { deadline: performance.now() + 14_000, signal: AbortSignal.timeout(15_000) });
}

export async function rejectOrdinaryEmailFromRequest(raw: unknown) {
  const input = ordinaryEmailRejectionInput.parse(raw), admitted = await nativeRequest('ORDINARY_EMAIL_REJECT');
  return rejectStoredOrdinaryEmail(prisma, admitted.session, input, admitted.credentials, admitted.runtime);
}
