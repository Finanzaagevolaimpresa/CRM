import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { readPrivateDocumentBounded } from './storage';
import { confirmAndTransmitStoredOrdinaryEmail } from './ordinary-email-service-candidate';
import { createOrdinaryTransportResolver, type OrdinaryTransportSource } from './ordinary-email-transport-binding';

/** Private composition using only the specifically qualified existing source.
 * No public action, default environment, binding writer, retry or activation.
 * An unavailable/stale source fails inside reservation and leaves no attempt. */
export async function confirmStoredOrdinaryEmailUsingExistingTransport(
  db: Pick<PrismaClient, '$transaction'>, claimed: AuthSession,
  input: { messageId: string; requestId: string; previewToken: string },
  credentials: { sessionToken: string; stepUpToken: string | undefined },
  runtime: { key: PrivilegedStepUpKey; readDocument?: typeof readPrivateDocumentBounded },
  source: OrdinaryTransportSource, control: { deadline: number; signal: AbortSignal },
) {
  const resolver = createOrdinaryTransportResolver(runtime.key, source);
  const assertControl = () => {
    if (!Number.isFinite(control.deadline) || control.deadline <= performance.now() || control.signal.aborted)
      throw new Error('ORDINARY_EMAIL_TRANSPORT_UNAVAILABLE');
  };
  assertControl();
  return confirmAndTransmitStoredOrdinaryEmail(db, claimed, input, credentials,
    { ...runtime, assertTransport: channel => { assertControl(); resolver.assertChannel(channel); } }, resolver, control);
}
