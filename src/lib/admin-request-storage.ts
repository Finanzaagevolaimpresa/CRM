import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { adminRequestSubmission, adminRequestSubmissionDigest, adminRequestStatus } from './admin-request-contract';
import { requestDenied, requestStale, AdminRequestError } from './admin-request-admission';

type Tx = Prisma.TransactionClient;
export const requestStateSchema = z.object({ requestId: z.string().uuid(), authorId: z.string().min(1), sessionId: z.string().uuid(),
  revision: z.number().int().positive().max(2147483646), status: adminRequestStatus,
  submitted: adminRequestSubmission, submissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requesterReply: z.string().max(2000).nullable() }).strict();
export type RequestState = z.infer<typeof requestStateSchema>;
type RequestRow = { id: string; authorId: string; revision: number; state: Prisma.JsonValue; stateHash: string; createdAt: Date };
export type RequestEvent = { id: string; requestId: string; revision: number; commandId: string; actorId: string;
  sessionId: string; operation: string; commandHash: string; state: Prisma.JsonValue; stateHash: string; createdAt: Date };
function unavailable(): never { throw new AdminRequestError('UNAVAILABLE'); }
export function decodeRequest(row: RequestRow) {
  const state = requestStateSchema.parse(row.state);
  if (row.id !== state.requestId || row.authorId !== state.authorId || row.revision !== state.revision
    || canonicalSha256(state) !== row.stateHash || adminRequestSubmissionDigest({ userId: state.authorId,
      sessionId: state.sessionId }, state.submitted) !== state.submissionSha256) unavailable();
  return state;
}
export async function lockAdminRequest(tx: Tx, id: string) {
  z.string().uuid().parse(id);
  const [row] = await tx.$queryRaw<RequestRow[]>`SELECT id,"authorId",revision,state,"stateHash","createdAt"
    FROM "AdminRequest" WHERE id=${id}::uuid FOR UPDATE`;
  if (!row) requestDenied();
  const state = decodeRequest(row);
  const [event] = await tx.$queryRaw<RequestEvent[]>`SELECT * FROM "AdminRequestEvent" WHERE "requestId"=${id}::uuid AND revision=${state.revision}`;
  const audit = event ? await tx.auditLog.findUnique({ where: { id: event.id } }) : null;
  if (!event || canonicalSha256(event.state) !== row.stateHash || event.stateHash !== row.stateHash
    || !audit || audit.actorId !== event.actorId || audit.entityId !== event.id || audit.entityType !== 'AdminRequestEvent'
    || audit.event !== 'admin_request_changed' || canonicalSha256(audit.before) !== canonicalSha256({ revision: state.revision - 1 })
    || canonicalSha256(audit.after) !== canonicalSha256({ revision: state.revision, operation: event.operation, stateHash: row.stateHash })) unavailable();
  return { state, createdAt: row.createdAt };
}
export function requestCommandHash(actorId: string, sessionId: string, operation: string, command: unknown) {
  return canonicalSha256({ domain: 'FAI_ADMIN_REQUEST_COMMAND_V1', actorId, sessionId, operation, command });
}
export async function requestCommandReceipt(tx: Tx, commandId: string, actorId: string, sessionId: string, digest: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${commandId},0))`;
  const [event] = await tx.$queryRaw<RequestEvent[]>`SELECT * FROM "AdminRequestEvent" WHERE "commandId"=${commandId}::uuid`;
  if (!event) return null;
  if (event.actorId !== actorId || event.sessionId !== sessionId || event.commandHash !== digest) requestStale();
  // Canonical chain/audit are verified before returning the minimal receipt.
  await lockAdminRequest(tx, event.requestId);
  return { requestId: event.requestId, revision: event.revision, eventId: event.id, operation: event.operation };
}
export async function appendAdminRequest(tx: Tx, state: RequestState, actorId: string, sessionId: string,
  operation: 'SUBMIT' | 'AMEND' | 'WITHDRAW' | 'REQUEST_INFORMATION' | 'REJECT' | 'PREPARE_DRAFT', commandId: string, commandHash: string) {
  requestStateSchema.parse(state);
  const hash = canonicalSha256(state), payload = JSON.stringify(state), eventId = randomUUID(), s = state.submitted.subject;
  if (state.revision === 1) await tx.$executeRaw`INSERT INTO "AdminRequest"(id,"authorId","sessionId",kind,"leadId","clientId","projectId","practiceId",revision,state,"stateHash")
    VALUES(${state.requestId}::uuid,${state.authorId},${state.sessionId}::uuid,${s.kind},
      ${s.kind === 'Lead' ? s.targetId : null},${s.kind === 'Client' ? s.targetId : null},
      ${s.kind === 'Project' ? s.targetId : null},${s.kind === 'TechnicalPractice' ? s.targetId : null},1,${payload}::jsonb,${hash})`;
  else {
    const changed = await tx.$executeRaw`UPDATE "AdminRequest" SET revision=${state.revision},state=${payload}::jsonb,"stateHash"=${hash},"updatedAt"=clock_timestamp()
      WHERE id=${state.requestId}::uuid AND revision=${state.revision - 1}`;
    if (changed !== 1) requestStale();
  }
  await tx.$executeRaw`INSERT INTO "AdminRequestEvent"(id,"requestId",revision,"commandId","actorId","sessionId",operation,"commandHash",state,"stateHash")
    VALUES(${eventId}::uuid,${state.requestId}::uuid,${state.revision},${commandId}::uuid,${actorId},${sessionId}::uuid,${operation},${commandHash},${payload}::jsonb,${hash})`;
  await tx.auditLog.create({ data: { id: eventId, actorId, event: 'admin_request_changed', entityType: 'AdminRequestEvent', entityId: eventId,
    before: { revision: state.revision - 1 }, after: { revision: state.revision, operation, stateHash: hash } } });
  return { requestId: state.requestId, revision: state.revision, eventId, operation };
}

export type RequestDraftOrigin = { requestId: string; messageId: string; sourceHash: string; authorityRevision: number; createdById: string };
export async function requestDraftOrigin(tx: Tx, id: string) {
  const [row] = await tx.$queryRaw<RequestDraftOrigin[]>`SELECT "requestId","messageId","sourceHash","authorityRevision","createdById"
    FROM "AdminRequestDraft" WHERE "messageId"=${id}::uuid`;
  return row ?? null;
}
