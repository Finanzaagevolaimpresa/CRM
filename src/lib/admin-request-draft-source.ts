import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CommunicationPrincipal } from './communication-principal';
import { canonicalSha256 } from './canonical-json';
import { recordUpdateEmailAuthority } from './record-update-email-authority';
import { admitAdminRequestOrigin, exactRequestOrigin, requestDenied, requestStale } from './admin-request-admission';
import { lockAdminRequest, requestDraftOrigin, appendAdminRequest, requestCommandHash } from './admin-request-storage';

type Tx = Prisma.TransactionClient;
export const adminRequestDraftSource = z.object({ requestId: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Called inside the existing message transaction at save, read, preview,
 * approval and send. No authority is inherited from the requester or a role. */
export async function admitAdminRequestDraft(tx: Tx, current: CommunicationPrincipal, requestId: string) {
  const authority = await recordUpdateEmailAuthority(tx, current);
  if (!authority) requestDenied();
  const request = await lockAdminRequest(tx, requestId), state = request.state;
  if (!['OPEN', 'NEEDS_INFORMATION', 'DRAFT_PREPARED'].includes(state.status)) requestDenied();
  const origin = await admitAdminRequestOrigin(tx, state.authorId, state.submitted.subject);
  exactRequestOrigin(origin, state.submitted);
  const linked = await requestDraftOrigin(tx, requestId);
  if ((state.status === 'DRAFT_PREPARED') !== !!linked) requestDenied();
  const revision = linked ? state.revision : state.revision + 1;
  const sourceHash = canonicalSha256({ domain: 'FAI_ADMIN_REQUEST_DRAFT_V1', requestId, revision,
    submissionSha256: state.submissionSha256, requesterReply: state.requesterReply,
    context: origin.communicationContext, authorityUserId: authority.userId, authorityRevision: authority.revision,
    mailboxId: authority.mailboxId });
  if (linked && (linked.sourceHash !== sourceHash || linked.authorityRevision !== authority.revision
    || linked.createdById !== current.userId)) requestStale();
  return { ...request, origin, authority, sourceHash, linked, accessUntil: origin.accessUntil };
}

/** GET consultation does not create this relation. The first explicit draft save
 * creates the message/version, relation, request event and audit atomically. */
export async function linkAdminRequestDraft(tx: Tx, current: CommunicationPrincipal & { sessionId?: string },
  admitted: Awaited<ReturnType<typeof admitAdminRequestDraft>>, messageId: string) {
  if (!current.sessionId || messageId !== admitted.state.requestId) requestDenied();
  if (admitted.linked) return;
  const state = { ...admitted.state, revision: admitted.state.revision + 1, status: 'DRAFT_PREPARED' as const };
  const commandId = messageId;
  // The submission command already uses this UUID; the draft uses a separately
  // namespaced random command retained in its event, never an external send key.
  const event = await appendAdminRequest(tx, state, current.userId, current.sessionId, 'PREPARE_DRAFT', randomUUID(),
    requestCommandHash(current.userId, current.sessionId, 'PREPARE_DRAFT', { commandId, sourceHash: admitted.sourceHash }));
  await tx.$executeRaw`INSERT INTO "AdminRequestDraft"("requestId","messageId","sourceHash","authorityRevision","createdById","eventId")
    VALUES(${messageId}::uuid,${messageId}::uuid,${admitted.sourceHash},${admitted.authority.revision},${current.userId},${event.eventId}::uuid)`;
}
