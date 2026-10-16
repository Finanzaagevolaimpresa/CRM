import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { readPrivateDocumentBounded } from './storage';
import { transmitOrdinaryEmailCandidate, type OrdinaryAttemptLease, type OrdinarySmtpDependencies } from './ordinary-email-smtp-candidate';
import { reserveStoredOrdinaryEmail, loadStoredOrdinaryEmailMaterial, takeStoredOrdinaryEmailAttempt,
  checkStoredOrdinaryEmailLease, withStoredOrdinaryEmailAuthorization, recordStoredOrdinaryEmailOutcome } from './ordinary-email-store-candidate';

/** Server-only composition candidate. No route, environment lookup, default
 * network connector or retry. The integrating action must obtain identity,
 * cookies and the active key from native server controls, never from a form.
 * A committed decision precedes a unique claim; the claim precedes any socket.
 * Leases and credentials never leave this function. */
export async function confirmAndTransmitStoredOrdinaryEmail(
  db: Pick<PrismaClient, '$transaction'>, claimed: AuthSession,
  input: { messageId: string; requestId: string; previewToken: string },
  credentials: { sessionToken: string; stepUpToken: string | undefined },
  runtime: { key: PrivilegedStepUpKey; readDocument?: typeof readPrivateDocumentBounded },
  transport: Pick<OrdinarySmtpDependencies, 'readQualifiedTransport' | 'connectTls'>,
  control: { deadline: number; signal: AbortSignal },
) {
  const reserved = await reserveStoredOrdinaryEmail(db, claimed, input, credentials, runtime);
  let lease: OrdinaryAttemptLease | undefined;
  try {
    const material = await loadStoredOrdinaryEmailMaterial(db, claimed, reserved.attemptId, runtime);
    const result = await transmitOrdinaryEmailCandidate(material, reserved.attemptId, control, {
      ...transport,
      takeCommittedAttempt: async request => {
        lease = await takeStoredOrdinaryEmailAttempt(db, claimed, request, runtime);
        return lease;
      },
      assertCurrent: issued => checkStoredOrdinaryEmailLease(db, claimed, issued, runtime),
      withCurrentAuthorization: (issued, operation) => withStoredOrdinaryEmailAuthorization(db, claimed, issued, runtime, operation),
    });
    if (!lease) throw new Error('ORDINARY_EMAIL_COMMIT_NOT_CONFIRMED');
    await recordStoredOrdinaryEmailOutcome(db, lease, result);
    return { attemptId: reserved.attemptId, status: 'RECORDED' as const, outcome: result.outcome };
  } catch {
    // An uncertain commit/receipt is not an invitation to resend. Existing
    // durable reservations/claims keep the message blocked for reconciliation.
    return { attemptId: reserved.attemptId, status: 'RECONCILIATION_REQUIRED' as const };
  }
}
