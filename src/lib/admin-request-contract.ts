import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import { admitsTechnicalAssignmentAction, type CurrentTechnicalAssignmentAdmission,
  type TechnicalAssignmentSelection } from './technical-assignment-contract';

// Pure admission contract used by the private queue. It grants no permission
// and carries no email approval or external delivery authority.
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const revision = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const subject = z.object({
  kind: z.enum(['Lead', 'Client', 'Project', 'TechnicalPractice']), targetId: id,
}).strict();
const prose = (maximum: number) => z.string().trim().min(3).max(maximum)
  .refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), 'Control bytes are not allowed');

export const adminRequestSubmission = z.object({
  commandId: z.string().uuid(), subject,
  expectedContextSha256: hash, expectedRecipientEpoch: revision, expectedAccessRevision: revision,
  kind: z.enum(['DOCUMENT', 'INTEGRATION']), title: prose(160), details: prose(3000),
}).strict();
export type AdminRequestSubmission = z.infer<typeof adminRequestSubmission>;

// Read from the canonical target, registry and live session inside the same
// transaction as the request/audit. Never populate this from submitted claims.
export type CurrentCommercialRequestAdmission = {
  role: string; userId: string; active: boolean; sessionLive: boolean;
  registryCurrent: boolean; recordWorkable: boolean; selectiveCeilingAllows: boolean;
  subject: { kind: 'Lead' | 'Client'; targetId: string };
  commercialOwnerId: string | null; contextSha256: string;
  recipientEpoch: number; accessRevision: number;
};
export type CurrentAdminRequestAdmission = {
  kind: 'COMMERCIAL_OWNER'; current: CurrentCommercialRequestAdmission;
} | {
  kind: 'TECHNICAL_ASSIGNMENT'; current: CurrentTechnicalAssignmentAdmission;
  selection: TechnicalAssignmentSelection;
};

export function admitsAdminRequestSubmission(
  admission: CurrentAdminRequestAdmission, input: unknown, now: Date,
): boolean {
  const parsed = adminRequestSubmission.safeParse(input);
  if (!parsed.success || !Number.isFinite(now.getTime())) return false;
  const command = parsed.data;
  if (admission.kind === 'COMMERCIAL_OWNER') {
    const current = admission.current;
    return current.role === 'commerciale' && current.active === true && current.sessionLive === true
      && current.registryCurrent === true && current.recordWorkable === true && current.selectiveCeilingAllows === true
      && id.safeParse(current.userId).success && current.commercialOwnerId === current.userId
      && ['Lead', 'Client'].includes(current.subject.kind)
      && current.subject.kind === command.subject.kind && current.subject.targetId === command.subject.targetId
      && hash.safeParse(current.contextSha256).success && current.contextSha256 === command.expectedContextSha256
      && revision.safeParse(current.recipientEpoch).success && current.recipientEpoch === command.expectedRecipientEpoch
      && revision.safeParse(current.accessRevision).success && current.accessRevision === command.expectedAccessRevision;
  }
  if (command.subject.kind !== 'Project' && command.subject.kind !== 'TechnicalPractice') return false;
  const { current, selection } = admission;
  return admitsTechnicalAssignmentAction(current, selection, {
    kind: command.subject.kind, targetId: command.subject.targetId, action: 'request_admin',
  }, now) && current.currentContextSha256 === command.expectedContextSha256
    && current.currentRecipientEpoch === command.expectedRecipientEpoch
    && current.currentRevision === command.expectedAccessRevision;
}

const retainedAuthor = z.object({ userId: id, sessionId: id }).strict();
// Idempotency binds the author/session and normalized request. It is not an
// approval, email signature or permission to notify any recipient.
export function adminRequestSubmissionDigest(author: z.infer<typeof retainedAuthor>, input: unknown) {
  return createHash('sha256').update('FAI_ADMIN_REQUEST_SUBMISSION_V1\n')
    .update(canonicalJson({ author: retainedAuthor.parse(author), request: adminRequestSubmission.parse(input) }))
    .digest('hex');
}

export const adminRequestStatus = z.enum(['OPEN', 'NEEDS_INFORMATION', 'DRAFT_PREPARED', 'REJECTED', 'WITHDRAWN']);
// No request state means "sent", "delivered" or "read". These facts require
// the separate communication attempt, provider result or explicit read receipt.
export const adminRequestStatusLabels: Record<z.infer<typeof adminRequestStatus>, string> = {
  OPEN: 'Da esaminare', NEEDS_INFORMATION: 'In attesa di integrazione interna',
  DRAFT_PREPARED: 'Bozza preparata, invio da decidere', REJECTED: 'Richiesta rifiutata', WITHDRAWN: 'Richiesta ritirata',
};
