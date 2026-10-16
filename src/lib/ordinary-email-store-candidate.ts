import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { loadOrdinaryMessageCandidateContext } from './approved-communications';
import { checkPersistedOrdinaryDecision, confirmOrdinaryDecision, previewOrdinaryDecision } from './ordinary-email-decision';
import type { OrdinaryChannel } from './ordinary-email-candidate';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { OrdinaryAttemptLease, OrdinaryAttemptRequest, OrdinarySmtpResult } from './ordinary-email-smtp-candidate';
import type { readPrivateDocumentBounded } from './storage';

/** Isolated PostgreSQL candidate. Tables are deliberately outside the migration
 * chain; no route, connector, environment reader, worker or automatic retry.
 * An integrating service must load its active native key and serialize current
 * authorization with the bounded DATA write, not just perform an earlier read. */
type Db = Pick<PrismaClient, '$transaction'>;
type Tx = Prisma.TransactionClient;
type Runtime = { key: PrivilegedStepUpKey; readDocument?: typeof readPrivateDocumentBounded };
type Credentials = { sessionToken: string; stepUpToken: string | undefined };
const uuid = z.string().uuid();
function deny(): never { throw new Error('ORDINARY_EMAIL_STORE_DENIED'); }
async function clock(tx: Tx) { return (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now; }

async function load(tx: Tx, claimed: AuthSession, messageId: string, runtime: Runtime) {
  const loaded = await loadOrdinaryMessageCandidateContext(tx, claimed, messageId, runtime);
  const authorities = await tx.$queryRaw<Array<{ userId: string; mailboxId: string; revision: number; enabled: boolean }>>`
    SELECT "userId","mailboxId","revision","enabled" FROM "OrdinaryEmailAuthority" WHERE "id"='ordinary-email' FOR SHARE`;
  const channels = await tx.$queryRaw<Array<{ mailboxRevision: number; revision: number; qualificationReference: string; enabled: boolean }>>`
    SELECT "mailboxRevision","revision","qualificationReference","enabled" FROM "OrdinaryEmailChannel"
    WHERE "mailboxId"=${loaded.box.id}::uuid FOR SHARE`;
  const binding = authorities[0], qualification = channels[0];
  if (!binding || !qualification?.enabled || qualification.mailboxRevision !== loaded.box.revision
    || loaded.box.kind !== 'MAILBOX' || loaded.box.canonicalMailboxId
    || loaded.box.address !== 'comunicazioni@finanzaagevolaimpresa.it' || loaded.box.providerReference !== 'register_it'
    || loaded.box.configurationReference !== 'M4_COMUNICAZIONI_REGISTER_IT') deny();
  const channel: OrdinaryChannel = { purpose: 'ORDINARY_SMTP', mailboxId: loaded.box.id, mailboxRevision: loaded.box.revision,
    address: loaded.box.address, providerReference: loaded.box.providerReference, configurationReference: loaded.box.configurationReference,
    channelRevision: qualification.revision, qualificationReference: qualification.qualificationReference };
  return { ...loaded, material: { snapshot: loaded.snapshot, channel, materials: loaded.materials },
    current: { actor: loaded.actor, contextHash: loaded.contextHash, contextExpiresAt: loaded.contextExpiresAt,
      authority: { ...binding, id: 'ordinary-email' as const, purpose: 'ORDINARY_EMAIL' as const } } };
}
async function audit(tx: Tx, actorId: string, messageId: string, action: string, decisionId: string, attemptId: string,
  evidenceHash: string, status: string) {
  await tx.auditLog.create({ data: { actorId, entityType: 'ApprovedCommunication', entityId: messageId,
    event: `ordinary_email_${action}`, after: { action, decisionId, attemptId, evidenceHash, status } } });
}

export async function previewStoredOrdinaryEmail(db: Db, claimed: AuthSession, messageId: string, runtime: Runtime) {
  return db.$transaction(async tx => {
    const state = await load(tx, claimed, messageId, runtime);
    if (!['DRAFT','PENDING','APPROVED','ERROR'].includes(state.row.state)) deny();
    return previewOrdinaryDecision(state.material, state.current, runtime.key, await clock(tx));
  }, { timeout: 30_000 });
}

export async function reserveStoredOrdinaryEmail(db: Db, claimed: AuthSession,
  input: { messageId: string; requestId: string; previewToken: string }, credentials: Credentials, runtime: Runtime) {
  uuid.parse(input.requestId);
  return db.$transaction(async tx => {
    const state = await load(tx, claimed, input.messageId, runtime);
    if (!['DRAFT','PENDING','APPROVED','ERROR'].includes(state.row.state)) deny();
    const result = confirmOrdinaryDecision(input.previewToken, state.material, state.current, runtime.key, credentials, await clock(tx));
    const { decision, decisionHash, proof, prepared } = result, attemptId = randomUUID();
    const blocking = await tx.communicationAttempt.count({ where: { messageId: input.messageId, state: { in: ['SENDING','UNCERTAIN','SENT'] } } });
    if (blocking) deny();
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailDecision" ("id","messageId","versionId","actorId","sessionId","decision","decisionHash","proof","envelopeHash")
      VALUES (${decision.decisionId}::uuid,${input.messageId}::uuid,${state.version.id}::uuid,${decision.actorId},${decision.sessionId}::uuid,
        ${JSON.stringify(decision)}::jsonb,${decisionHash},${proof},${canonicalSha256(prepared.envelope)})`;
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailAttempt" ("id","requestId","decisionId","messageId")
      VALUES (${attemptId}::uuid,${input.requestId}::uuid,${decision.decisionId}::uuid,${input.messageId}::uuid)`;
    await tx.approvedCommunication.update({ where: { id: input.messageId }, data: { state: 'SENDING' } });
    await audit(tx, claimed.userId, input.messageId, 'reserved', decision.decisionId, attemptId, decisionHash, 'RESERVED');
    // No retry and no success receipt until commit. A lost commit response leaves
    // the reservation blocking; it never grants permission to open a socket.
    confirmOrdinaryDecision(input.previewToken, state.material, state.current, runtime.key, credentials, await clock(tx));
    return { attemptId, decisionId: decision.decisionId };
  }, { timeout: 30_000 });
}

type StoredAttempt = { id: string; messageId: string; state: string; decisionId: string; decision: unknown; proof: string;
  decisionHash: string; envelopeHash: string; actorId: string; sessionId: string; versionId: string };
async function attempt(tx: Tx, attemptId: string) {
  uuid.parse(attemptId);
  const rows = await tx.$queryRaw<StoredAttempt[]>`SELECT a.*,d."decision",d."proof",d."decisionHash",d."envelopeHash",d."actorId",d."sessionId",d."versionId"
    FROM "OrdinaryEmailAttempt" a JOIN "OrdinaryEmailDecision" d ON d."id"=a."decisionId" WHERE a."id"=${attemptId}::uuid FOR UPDATE OF a`;
  return rows[0] ?? deny();
}
async function currentAttempt(tx: Tx, claimed: AuthSession, attemptId: string, runtime: Runtime) {
  uuid.parse(attemptId);
  // Observe only the context ID first, then follow the M4 actor/message lock
  // order. Immutable bindings are reread after those locks.
  const refs = await tx.$queryRaw<Array<{ messageId: string }>>`SELECT "messageId" FROM "OrdinaryEmailAttempt" WHERE "id"=${attemptId}::uuid`;
  if (!refs[0]) deny();
  const state = await load(tx, claimed, refs[0].messageId, runtime), row = await attempt(tx, attemptId);
  if (state.row.state !== 'SENDING' || row.actorId !== claimed.userId || row.sessionId !== claimed.sessionId
    || row.versionId !== state.version.id || canonicalSha256(row.decision) !== row.decisionHash) deny();
  const verified = checkPersistedOrdinaryDecision(row.decision, row.proof, state.material, state.current, runtime.key, await clock(tx));
  if (verified.decision.decisionId !== row.decisionId || canonicalSha256(verified.prepared.envelope) !== row.envelopeHash) deny();
  return { state, row, ...verified };
}
export async function takeStoredOrdinaryEmailAttempt(db: Db, claimed: AuthSession, request: OrdinaryAttemptRequest, runtime: Runtime): Promise<OrdinaryAttemptLease> {
  return db.$transaction(async tx => {
    const value = await currentAttempt(tx, claimed, request.attemptId, runtime);
    if (value.row.state !== 'RESERVED' || request.intentHash !== value.prepared.intentHash || request.mimeHash !== value.prepared.mimeHash
      || request.envelopeHash !== value.row.envelopeHash || canonicalSha256(request.channel) !== canonicalSha256(value.state.material.channel)) deny();
    const now = await clock(tx), expiresAt = new Date(Math.min(now.getTime()+15_000, Date.parse(value.decision.validUntil))), leaseId = randomUUID();
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailClaim" ("id","attemptId","expiresAt","createdAt")
      VALUES (${leaseId}::uuid,${request.attemptId}::uuid,${expiresAt},${now})`;
    await tx.$executeRaw`UPDATE "OrdinaryEmailAttempt" SET "state"='CLAIMED' WHERE "id"=${request.attemptId}::uuid`;
    await audit(tx, claimed.userId, value.row.messageId, 'claimed', value.row.decisionId, value.row.id, value.row.decisionHash, 'CLAIMED');
    const finalClock = await clock(tx);
    if (expiresAt <= finalClock) deny();
    checkPersistedOrdinaryDecision(value.row.decision, value.row.proof, value.state.material, value.state.current, runtime.key, finalClock);
    return Object.freeze({ attemptId: request.attemptId, leaseId, expiresAt: expiresAt.toISOString(), committed: true as const });
  }, { timeout: 30_000 });
}
export async function checkStoredOrdinaryEmailLease(db: Db, claimed: AuthSession, lease: OrdinaryAttemptLease, runtime: Runtime) {
  return db.$transaction(async tx => {
    const value = await currentAttempt(tx, claimed, lease.attemptId, runtime);
    const claims = await tx.$queryRaw<Array<{ expiresAt: Date }>>`SELECT "expiresAt" FROM "OrdinaryEmailClaim"
      WHERE "id"=${uuid.parse(lease.leaseId)}::uuid AND "attemptId"=${lease.attemptId}::uuid`;
    const finalClock = await clock(tx);
    if (value.row.state !== 'CLAIMED' || !claims[0] || claims[0].expiresAt.toISOString() !== lease.expiresAt
      || claims[0].expiresAt <= finalClock || !lease.committed) deny();
    checkPersistedOrdinaryDecision(value.row.decision, value.row.proof, value.state.material, value.state.current, runtime.key, finalClock);
  }, { timeout: 30_000 });
}

const resultSchema = z.object({ outcome: z.enum(['ACCEPTED','NOT_SENT','UNCERTAIN']),
  phase: z.enum(['CLAIM','CONNECT','GREETING','EHLO','AUTH','MAIL','RCPT','DATA','CONTENT']), replyCode: z.number().int().min(200).max(599).optional() }).strict();
/** Private server receipt sink, never a browser action. The already-issued
 * capability can record an outcome after expiry/revocation; it cannot submit
 * data. Failing to record leaves CLAIMED/SENDING and blocks every retry. */
export async function recordStoredOrdinaryEmailOutcome(db: Db, lease: OrdinaryAttemptLease, raw: OrdinarySmtpResult) {
  const result = resultSchema.parse(raw); uuid.parse(lease.leaseId); uuid.parse(lease.attemptId);
  return db.$transaction(async tx => {
    const refs = await tx.$queryRaw<Array<{ messageId: string }>>`SELECT "messageId" FROM "OrdinaryEmailAttempt" WHERE "id"=${lease.attemptId}::uuid`;
    if (!refs[0]) deny();
    await tx.$queryRaw`SELECT "id" FROM "ApprovedCommunication" WHERE "id"=${refs[0].messageId}::uuid FOR UPDATE`;
    const row = await attempt(tx, lease.attemptId);
    const claims = await tx.$queryRaw<Array<{ id: string; expiresAt: Date }>>`SELECT "id","expiresAt" FROM "OrdinaryEmailClaim"
      WHERE "id"=${lease.leaseId}::uuid AND "attemptId"=${lease.attemptId}::uuid`;
    if (!lease.committed || !claims[0] || claims[0].expiresAt.toISOString() !== lease.expiresAt) deny();
    const prior = await tx.$queryRaw<Array<{ outcome: string; phase: string; replyCode: number | null }>>`
      SELECT "outcome","phase","replyCode" FROM "OrdinaryEmailOutcome" WHERE "attemptId"=${lease.attemptId}::uuid`;
    if (prior[0]) {
      if (prior[0].outcome !== result.outcome || prior[0].phase !== result.phase || prior[0].replyCode !== (result.replyCode ?? null)) deny();
      return { outcome: result.outcome };
    }
    if (row.state !== 'CLAIMED') deny();
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailOutcome" ("id","attemptId","claimId","outcome","phase","replyCode")
      VALUES (${randomUUID()}::uuid,${row.id}::uuid,${lease.leaseId}::uuid,${result.outcome},${result.phase},${result.replyCode ?? null})`;
    await tx.$executeRaw`UPDATE "OrdinaryEmailAttempt" SET "state"=${result.outcome} WHERE "id"=${row.id}::uuid`;
    await tx.approvedCommunication.update({ where: { id: row.messageId }, data: { state: result.outcome==='ACCEPTED' ? 'SENT' : result.outcome==='NOT_SENT' ? 'ERROR' : 'UNCERTAIN' } });
    await audit(tx, row.actorId, row.messageId, 'outcome', row.decisionId, row.id, canonicalSha256(result), result.outcome);
    return { outcome: result.outcome };
  }, { timeout: 30_000 });
}
