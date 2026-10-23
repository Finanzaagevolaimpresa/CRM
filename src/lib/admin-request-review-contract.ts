import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import { adminRequestStatus } from './admin-request-contract';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const revision = z.number().int().nonnegative().safe().max(Number.MAX_SAFE_INTEGER - 1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reply = z.string().trim().min(3).max(2000)
  .refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value));

export const adminRequestReviewCommand = z.object({
  commandId: z.string().uuid(), requestId: z.string().uuid(),
  expectedRevision: revision, expectedSubmissionSha256: hash,
  action: z.enum(['REQUEST_INFORMATION', 'REJECT']), requesterReply: reply,
}).strict();

const requestState = z.object({
  requestId: z.string().uuid(), authorUserId: identifier, revision,
  status: adminRequestStatus, submissionSha256: hash,
  // Determined from the canonical draft-origin relation under the same locks.
  // A draft must never be abandoned while an approval/send remains usable.
  hasLinkedDraft: z.boolean(),
});

export type CurrentAdminRequestReviewAdmission = {
  userId: string; role: string; active: boolean; sessionLive: boolean;
  registryCurrent: boolean; personalEmailAuthority: boolean; contextCurrent: boolean;
};

/** Pure transition plan. The writer obtains every admission fact
 * from current locked records and commit revision, event, receipt and audit in
 * one transaction. This return value is not a receipt or an email approval. */
export function planAdminRequestReview(
  current: CurrentAdminRequestReviewAdmission, rawState: unknown, rawCommand: unknown,
) {
  const parsed = adminRequestReviewCommand.safeParse(rawCommand);
  const stored = requestState.safeParse(rawState);
  if (!parsed.success || !stored.success || !identifier.safeParse(current.userId).success
    || current.role !== 'admin' || current.active !== true || current.sessionLive !== true
    || current.registryCurrent !== true || current.personalEmailAuthority !== true
    || current.contextCurrent !== true) return null;
  const command = parsed.data, state = stored.data;
  if (command.requestId !== state.requestId || command.expectedRevision !== state.revision
    || command.expectedSubmissionSha256 !== state.submissionSha256 || state.hasLinkedDraft
    || !['OPEN', 'NEEDS_INFORMATION'].includes(state.status)) return null;
  const status = command.action === 'REQUEST_INFORMATION' ? 'NEEDS_INFORMATION' as const : 'REJECTED' as const;
  const commandSha256 = createHash('sha256').update('FAI_ADMIN_REQUEST_REVIEW_V1\n')
    .update(canonicalJson({ actorUserId: current.userId, command })).digest('hex');
  return {
    requestId: state.requestId, expectedRevision: state.revision, nextRevision: state.revision + 1,
    status, requesterReply: command.requesterReply,
    // Text is stored only in the explicit reply, not repeated into the audit.
    audit: { actorUserId: current.userId, requestId: state.requestId, commandId: command.commandId,
      commandSha256, previousStatus: state.status, nextStatus: status },
  };
}
