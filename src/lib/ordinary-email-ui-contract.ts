import type { previewStoredOrdinaryEmail } from './ordinary-email-store-candidate';
export type OrdinaryEmailPreview = Awaited<ReturnType<typeof previewStoredOrdinaryEmail>>;
export type OrdinaryEmailPreviewResult = { status: 'READY'; preview: OrdinaryEmailPreview } | { status: 'UNAVAILABLE' };
export type OrdinaryEmailRefusalResult = { status: 'REJECTED'; revision: number } | { status: 'CHECK_CURRENT' };
export type OrdinaryEmailSendResult = { status: 'RECORDED'; outcome: 'ACCEPTED' | 'NOT_SENT' | 'UNCERTAIN' }
  | { status: 'CHECK_CURRENT' };

/** A stale page cannot present a fresh response as its previously shown draft.
 * This is a UI guard only; the server always verifies current state again. */
export function ordinaryPreviewMatches(preview: OrdinaryEmailPreview,
  shown: { messageId: string; revision: number; snapshotHash: string }, now: number) {
  return preview.messageId === shown.messageId && preview.revision === shown.revision && preview.snapshotHash === shown.snapshotHash
    && Number.isFinite(now) && new Date(preview.expiresAt).getTime() > now;
}
