import type { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { withSerializableTransaction } from './serializable';
import { updateActor } from './record-updates';
import { recordUpdateEmailAuthority } from './record-update-email-authority';
import { adminRequestSubmission, adminRequestSubmissionDigest } from './admin-request-contract';
import { adminRequestReviewCommand, planAdminRequestReview } from './admin-request-review-contract';
import { admitAdminRequestOrigin, exactRequestOrigin, requestSubject, requestDenied, requestStale, AdminRequestError } from './admin-request-admission';
import { AdminRequestContextUnavailable } from './admin-request-commercial-loader';
import { appendAdminRequest, lockAdminRequest, requestCommandReceipt, requestCommandHash, requestDraftOrigin, type RequestEvent } from './admin-request-storage';
import { admitAdminRequestDraft } from './admin-request-draft-source';

type Tx = Prisma.TransactionClient;
async function session(tx: Tx, claimed: AuthSession) {
  const auth = await updateActor(tx, claimed);
  if (!auth.registry.live || !['admin', 'commerciale', 'consulente', 'backoffice'].includes(auth.actor.role)) requestDenied();
  const authority = auth.actor.role === 'admin' ? await recordUpdateEmailAuthority(tx, auth.actor) : null;
  if (auth.actor.role === 'admin' && !authority) requestDenied();
  return { ...auth, authority, isAdmin: !!authority };
}
async function admittedRequest(tx: Tx, auth: Awaited<ReturnType<typeof session>>, id: string) {
  const row = await lockAdminRequest(tx, id);
  if (!auth.isAdmin && row.state.authorId !== auth.actor.id) requestDenied();
  const origin = await admitAdminRequestOrigin(tx, row.state.authorId, row.state.submitted.subject);
  exactRequestOrigin(origin, row.state.submitted);
  return { ...row, origin };
}
async function finish(tx: Tx, auth: Awaited<ReturnType<typeof session>>, until = Infinity) {
  const now = await auth.finish();
  if (now.getTime() >= until) requestDenied();
}
export async function readAdminRequestEntry(db: PrismaClient, claimed: AuthSession, rawSubject: unknown) {
  return withSerializableTransaction(db, async tx => {
    const auth = await session(tx, claimed);
    if (auth.isAdmin) requestDenied();
    const origin = await admitAdminRequestOrigin(tx, auth.actor.id, requestSubject.parse(rawSubject));
    await finish(tx, auth, origin.accessUntil);
    return { subject: origin.subject, expectedContextSha256: origin.contextSha256,
      expectedRecipientEpoch: origin.recipientEpoch, expectedAccessRevision: origin.accessRevision };
  });
}
export async function submitAdminRequest(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = adminRequestSubmission.parse(raw);
  return withSerializableTransaction(db, async tx => {
    const auth = await session(tx, claimed);
    if (auth.isAdmin) requestDenied();
    const origin = await admitAdminRequestOrigin(tx, auth.actor.id, input.subject);
    exactRequestOrigin(origin, input);
    const digest = requestCommandHash(auth.actor.id, auth.registry.id, 'SUBMIT', input);
    const old = await requestCommandReceipt(tx, input.commandId, auth.actor.id, auth.registry.id, digest);
    if (old) { await finish(tx, auth, origin.accessUntil); return old; }
    const receipt = await appendAdminRequest(tx, { requestId: input.commandId, authorId: auth.actor.id, sessionId: auth.registry.id,
      revision: 1, status: 'OPEN', submitted: input, submissionSha256: adminRequestSubmissionDigest({ userId: auth.actor.id,
        sessionId: auth.registry.id }, input), requesterReply: null }, auth.actor.id, auth.registry.id, 'SUBMIT', input.commandId, digest);
    await finish(tx, auth, origin.accessUntil);
    return receipt;
  });
}
const authorCommand = z.object({ requestId: z.string().uuid(), commandId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  expectedSubmissionSha256: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['AMEND', 'WITHDRAW']),
  title: adminRequestSubmission.shape.title.optional(), details: adminRequestSubmission.shape.details.optional() }).strict();
export async function changeAdminRequest(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const parsed = adminRequestReviewCommand.safeParse(raw), input = parsed.success ? parsed.data : authorCommand.parse(raw);
  return withSerializableTransaction(db, async tx => {
    const auth = await session(tx, claimed);
    const row = await admittedRequest(tx, auth, input.requestId), state = row.state;
    const digest = requestCommandHash(auth.actor.id, auth.registry.id, input.action, input);
    const old = await requestCommandReceipt(tx, input.commandId, auth.actor.id, auth.registry.id, digest);
    if (old) { await finish(tx, auth, row.origin.accessUntil); return old; }
    const linked = await requestDraftOrigin(tx, input.requestId);
    if (state.revision !== input.expectedRevision || state.submissionSha256 !== input.expectedSubmissionSha256
      || linked || !['OPEN', 'NEEDS_INFORMATION'].includes(state.status)) requestStale();
    let next = { ...state, revision: state.revision + 1 };
    if (parsed.success) {
      const plan = planAdminRequestReview({ userId: auth.actor.id, role: auth.actor.role, active: auth.actor.active,
        sessionLive: true, registryCurrent: true, personalEmailAuthority: auth.isAdmin, contextCurrent: true },
      { ...state, authorUserId: state.authorId, hasLinkedDraft: false }, input);
      if (!plan) requestDenied();
      next = { ...next, status: plan.status, requesterReply: plan.requesterReply };
    } else {
      const command = authorCommand.parse(input);
      if (auth.isAdmin || auth.actor.id !== state.authorId) requestDenied();
      if (command.action === 'WITHDRAW') next.status = 'WITHDRAWN';
      else {
        if (!command.title || !command.details) requestStale();
        next.submitted = { ...state.submitted, title: command.title, details: command.details };
        next.submissionSha256 = adminRequestSubmissionDigest({ userId: state.authorId, sessionId: state.sessionId }, next.submitted);
        next.status = 'OPEN';
      }
    }
    const receipt = await appendAdminRequest(tx, next, auth.actor.id, auth.registry.id, input.action, input.commandId, digest);
    await finish(tx, auth, row.origin.accessUntil);
    return receipt;
  });
}
export async function readAdminRequest(db: PrismaClient, claimed: AuthSession, id: string) {
  return withSerializableTransaction(db, async tx => {
    const auth = await session(tx, claimed), row = await admittedRequest(tx, auth, id);
    const events = await tx.$queryRaw<RequestEvent[]>`SELECT * FROM "AdminRequestEvent" WHERE "requestId"=${id}::uuid ORDER BY revision`;
    const draft = auth.isAdmin ? await requestDraftOrigin(tx, id) : null;
    await finish(tx, auth, row.origin.accessUntil);
    return { ...row.state, createdAt: row.createdAt, isAdmin: auth.isAdmin,
      history: events.map(e => ({ revision: e.revision, operation: e.operation, createdAt: e.createdAt })),
      draftHref: draft ? `/communications?kind=${row.origin.communicationContext.kind}&practice=${encodeURIComponent(row.origin.communicationContext.id)}&request=${id}` : null };
  });
}
export function isRequestUnavailable(error: unknown) {
  return error instanceof AdminRequestContextUnavailable || error instanceof AdminRequestError && ['DENIED', 'STALE'].includes(error.code);
}
export async function readAdminRequestQueue(db: PrismaClient, claimed: AuthSession, page = 1, query = '') {
  const skip = (z.number().int().min(1).max(200).parse(page) - 1) * 30;
  const term = z.string().trim().max(160).parse(query).toLocaleLowerCase('it-IT');
  return withSerializableTransaction(db, async tx => {
    const auth = await session(tx, claimed);
    // No global counts or unadmitted search snippets. The scan is bounded;
    // filtering occurs only after fresh authorization of each origin.
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "AdminRequest"
      WHERE (${auth.isAdmin} OR "authorId"=${auth.actor.id})
      AND (${term}='' OR position(${term} in lower(state->'submitted'->>'title'))>0)
      ORDER BY "createdAt" DESC,id OFFSET ${skip} LIMIT 31`;
    const items = []; let until = Infinity;
    for (const candidate of candidates) {
      try {
        const row = await admittedRequest(tx, auth, candidate.id), s = row.state;
        if (term && !s.submitted.title.toLocaleLowerCase('it-IT').includes(term)) continue;
        items.push({ id: s.requestId, title: s.submitted.title, kind: s.submitted.kind, status: s.status, createdAt: row.createdAt });
        until = Math.min(until, row.origin.accessUntil);
      } catch (error) { if (!isRequestUnavailable(error)) throw error; }
    }
    await finish(tx, auth, until);
    return { isAdmin: auth.isAdmin, items: items.slice(0, 30), hasNext: items.length > 30 };
  });
}
export async function readAdminRequestDraftPrefill(db: PrismaClient, claimed: AuthSession, id: string) {
  return withSerializableTransaction(db, async tx => {
    const auth = await session(tx, claimed);
    if (!auth.isAdmin) requestDenied();
    const admitted = await admitAdminRequestDraft(tx, auth.actor, id);
    await finish(tx, auth, admitted.accessUntil);
    return { requestId: id, sourceHash: admitted.sourceHash, context: admitted.origin.communicationContext,
      mailboxId: admitted.authority.mailboxId, saved: !!admitted.linked,
      requestTitle: admitted.state.submitted.title, requestDetails: admitted.state.submitted.details };
  });
}
/** Minimal outcome lookup after a lost response; no re-execution or access
 * renewal. A foreign session, revoked origin or changed user cannot obtain it. */
export async function readAdminRequestOutcome(db: PrismaClient, claimed: AuthSession, commandId: string) {
  z.string().uuid().parse(commandId);
  return withSerializableTransaction(db, async tx => {
    const auth = await session(tx, claimed);
    const [event] = await tx.$queryRaw<RequestEvent[]>`SELECT * FROM "AdminRequestEvent" WHERE "commandId"=${commandId}::uuid`;
    if (!event) { await finish(tx, auth); return { status: 'NOT_FOUND' as const }; }
    if (event.actorId !== auth.actor.id || event.sessionId !== auth.registry.id) requestDenied();
    const row = await admittedRequest(tx, auth, event.requestId);
    await finish(tx, auth, row.origin.accessUntil);
    return { status: 'RECORDED' as const, requestId: event.requestId, revision: event.revision, operation: event.operation };
  });
}
