import { z } from 'zod';
import { adminRequestSubmission, adminRequestStatus, adminRequestStatusLabels,
  admitsAdminRequestSubmission, type CurrentAdminRequestAdmission } from './admin-request-contract';

// The storage layer will assemble this envelope only after a current locked
// read. Parsing strips private administrative columns; returning the row itself
// or a communication snapshot is never a requester projection.
const requesterEnvelope = z.object({
  requestId: z.string().uuid(), authorUserId: z.string().min(1).max(128),
  submitted: adminRequestSubmission, revision: z.number().int().nonnegative().safe(),
  status: adminRequestStatus, createdAt: z.string().datetime({ offset: true }),
  // An explicit response addressed to the requester, not an email body or a
  // private Admin note. Its authoring and audit will be a separate command.
  requesterReply: z.string().trim().min(1).max(2000).nullable(),
});

export function projectAdminRequestToAuthor(
  raw: unknown, admission: CurrentAdminRequestAdmission, now: Date,
) {
  const row = requesterEnvelope.safeParse(raw);
  if (!row.success || row.data.authorUserId !== admission.current.userId
    || !admitsAdminRequestSubmission(admission, row.data.submitted, now)) return null;
  const { requestId, submitted, revision, status, createdAt, requesterReply } = row.data;
  return {
    requestId, subject: submitted.subject, kind: submitted.kind, title: submitted.title,
    details: submitted.details, revision, status, statusLabel: adminRequestStatusLabels[status],
    createdAt, requesterReply,
  };
}
