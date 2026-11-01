import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { loadOrdinaryReplyCandidateContext } from './approved-communications';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { tokenDigestFromCookie } from './internal-session-registry';
import { verifyPrivilegedStepUpToken, type PrivilegedStepUpKey } from './privileged-step-up-token';
import { canonicalSha256 } from './canonical-json';
import { readOrdinaryObservation, verifyOrdinaryObservation } from './ordinary-email-observation';
import { ordinaryRecoveryReference, ordinaryRecoveryConfirmation, signOrdinaryRecoveryPreview,
  verifyOrdinaryRecoveryPreview, type OrdinaryRecoveryResult } from './ordinary-email-reconciliation-contract';
import type { readPrivateDocumentBounded } from './storage';

type Db = Pick<PrismaClient, '$transaction'>;
type Tx = Prisma.TransactionClient;
type Runtime = { key: PrivilegedStepUpKey; readDocument?: typeof readPrivateDocumentBounded;
  /** Private dependency for isolated qualification, never an action input. */
  readObservation?: typeof readOrdinaryObservation };
type Credentials = { sessionToken: string; stepUpToken: string | undefined };
type Row = { id: string; state: string; decisionId: string; versionId: string; decision: unknown; decisionHash: string;
  envelopeHash: string; claimId: string | null; claimCreatedAt: Date | null; claimExpiresAt: Date | null;
  outcomeId: string | null; originalOutcome: string | null };
type Reconciliation = { id: string; outcome: 'ACCEPTED' | 'NOT_SENT'; sourceHash: string; createdAt: Date; reason: string };
function deny(): never { throw new Error('ORDINARY_RECOVERY_DENIED'); }
const clock = async (tx: Tx) => (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
async function load(tx: Tx, claimed: AuthSession, raw: unknown, runtime: Runtime) {
  const reference = ordinaryRecoveryReference.parse(raw);
  if (!await lockRegisteredPrivilegedStepUpKey(tx, runtime.key)) deny();
  const context = await loadOrdinaryReplyCandidateContext(tx, claimed, reference.messageId, runtime);
  if (context.current.role !== 'admin' || !hasPermission(context.current, 'practice_communications.mark_used')) deny();
  const [row] = await tx.$queryRaw<Row[]>`SELECT a."id",a."state",a."decisionId",d."versionId",d."decision",d."decisionHash",d."envelopeHash",
    c."id" AS "claimId",c."createdAt" AS "claimCreatedAt",c."expiresAt" AS "claimExpiresAt",
    o."id" AS "outcomeId",o."outcome" AS "originalOutcome"
    FROM "OrdinaryEmailAttempt" a JOIN "OrdinaryEmailDecision" d ON d."id"=a."decisionId"
    LEFT JOIN "OrdinaryEmailClaim" c ON c."attemptId"=a."id"
    LEFT JOIN "OrdinaryEmailOutcome" o ON o."attemptId"=a."id"
    WHERE a."id"=${reference.attemptId}::uuid AND a."messageId"=${reference.messageId}::uuid FOR UPDATE OF a`;
  if (!row || canonicalSha256(row.decision) !== row.decisionHash) deny();
  const [recorded] = await tx.$queryRaw<Reconciliation[]>`SELECT "id","outcome","sourceHash","createdAt","reason"
    FROM "OrdinaryEmailReconciliation" WHERE "attemptId"=${row.id}::uuid`;
  if (recorded && recorded.outcome !== row.state) deny();
  return { reference, context, row, recorded };
}
type Loaded = Awaited<ReturnType<typeof load>>;
function recordedResult(recorded: Reconciliation): OrdinaryRecoveryResult {
  return { status: 'RECORDED', commandId: recorded.id, outcome: recorded.outcome,
    sourceHash: recorded.sourceHash, recordedAt: recorded.createdAt.toISOString() };
}
function stateHash(value: Loaded) {
  return canonicalSha256({ attemptId: value.row.id, state: value.row.state, decisionHash: value.row.decisionHash,
    originalOutcomeId: value.row.outcomeId, originalOutcome: value.row.originalOutcome,
    currentRevision: value.context.row.currentRevision, snapshotHash: value.context.version.snapshotHash });
}
type Evidence = { reason: Extract<OrdinaryRecoveryResult, { status: 'WAITING' }>['reason'] }
  | (ReturnType<typeof verifyOrdinaryObservation> & { sealed: Awaited<ReturnType<typeof readOrdinaryObservation>> });
async function evidence(value: Loaded, runtime: Runtime, now: Date): Promise<Evidence> {
  const row = value.row;
  if (row.state === 'RESERVED' && !row.claimId) return { reason: 'RESERVED_WITHOUT_CLAIM' as const };
  if (!['CLAIMED','UNCERTAIN'].includes(row.state)) return { reason: 'ALREADY_FINAL' as const };
  if (!row.claimId || !row.claimExpiresAt || !row.claimCreatedAt
    || (row.state === 'CLAIMED' ? row.outcomeId !== null : row.originalOutcome !== 'UNCERTAIN')) deny();
  if (row.claimExpiresAt > now) return { reason: 'IN_PROGRESS' as const };
  try {
    const sealed = await (runtime.readObservation ?? readOrdinaryObservation)(row.id);
    const decision = z.object({ intentHash: z.string(), mimeHash: z.string() }).passthrough().parse(row.decision);
    const verified = verifyOrdinaryObservation(sealed, { attemptId: row.id, leaseId: row.claimId,
      committed: true, expiresAt: row.claimExpiresAt.toISOString() }, { ...decision, envelopeHash: row.envelopeHash });
    const observedAt = Date.parse(verified.observation.observedAt);
    if (observedAt < row.claimCreatedAt.getTime()-5000 || observedAt > now.getTime()+5000) deny();
    return { sealed, ...verified };
  } catch { return { reason: 'NO_AUTHORITATIVE_OBSERVATION' as const }; }
}
async function fresh(tx: Tx, value: Loaded) {
  const now = await clock(tx);
  if (now.getTime() >= value.context.accessUntil) deny();
  return now;
}
async function personal(tx: Tx, value: Loaded, runtime: Runtime, credentials: Credentials) {
  const digest = await tokenDigestFromCookie(credentials.sessionToken);
  const registered = await tx.internalSession.findUnique({ where: { id: value.context.current.sessionId! },
    select: { tokenDigest: true, expiresAt: true, revokedAt: true } });
  const now = await fresh(tx,value);
  if (!digest || !registered || registered.revokedAt || registered.expiresAt <= now
    || digest.length !== registered.tokenDigest.length || !timingSafeEqual(digest,registered.tokenDigest)
    || !verifyPrivilegedStepUpToken({ key: runtime.key, token: credentials.stepUpToken,
      expectedUserId: value.context.current.userId, sessionToken: credentials.sessionToken,
      role: value.context.current.role, nowSeconds: Math.floor(now.getTime()/1000) })) deny();
  return now;
}

/** Read/preview only. Missing evidence never becomes NOT_SENT, including an
 * expired reservation with no claim. No transport configuration is read. */
export async function previewStoredOrdinaryRecovery(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime): Promise<OrdinaryRecoveryResult> {
  return db.$transaction(async tx => {
    const value = await load(tx,claimed,raw,runtime), now = await fresh(tx,value);
    if (value.recorded) return recordedResult(value.recorded);
    const source = await evidence(value,runtime,now);
    if ('reason' in source) return { status: 'WAITING', reason: source.reason };
    const issuedAt = await fresh(tx,value), expiresAt = new Date(Math.min(issuedAt.getTime()+300_000,value.context.accessUntil)).toISOString();
    const payload = { protocol: 'FAI_ORDINARY_EMAIL_RECOVERY_PREVIEW_V1' as const, ...value.reference,
      commandId: randomUUID(), actorId: value.context.current.userId, sessionId: value.context.current.sessionId!,
      keyVersion: runtime.key.version, sourceHash: source.sourceHash, stateHash: stateHash(value),
      outcome: source.observation.outcome, issuedAt: issuedAt.toISOString(), expiresAt };
    return { status: 'READY', token: signOrdinaryRecoveryPreview(payload,runtime.key), commandId: payload.commandId,
      outcome: payload.outcome, sourceHash: source.sourceHash, observedAt: source.observation.observedAt, expiresAt };
  }, { maxWait: 10_000, timeout: 30_000 });
}

/** Exact, idempotent Admin reconciliation. The browser cannot supply an outcome
 * or upload proof. Original sender/decision/receipt remain immutable. */
export async function confirmStoredOrdinaryRecovery(db: Db, claimed: AuthSession, raw: unknown,
  credentials: Credentials, runtime: Runtime): Promise<OrdinaryRecoveryResult> {
  const input = ordinaryRecoveryConfirmation.parse(raw);
  return db.$transaction(async tx => {
    const value = await load(tx,claimed,{ messageId: input.messageId, attemptId: input.attemptId },runtime);
    const now = await personal(tx,value,runtime,credentials);
    const preview = verifyOrdinaryRecoveryPreview(input.token,runtime.key,now);
    if (preview.actorId !== value.context.current.userId || preview.sessionId !== value.context.current.sessionId
      || preview.messageId !== input.messageId || preview.attemptId !== input.attemptId) deny();
    if (value.recorded) {
      if (value.recorded.id !== preview.commandId || value.recorded.sourceHash !== preview.sourceHash
        || value.recorded.outcome !== preview.outcome || value.recorded.reason !== input.reason) deny();
      return recordedResult(value.recorded);
    }
    const source = await evidence(value,runtime,now);
    if ('reason' in source || source.sourceHash !== preview.sourceHash || stateHash(value) !== preview.stateHash
      || source.observation.outcome !== preview.outcome) deny();
    const { observation: o } = source, row = value.row;
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailReconciliation"
      ("id","attemptId","claimId","previousOutcomeId","actorId","sessionId","keyVersion","reason","outcome","phase","replyCode","observation","sourceHash")
      VALUES (${preview.commandId}::uuid,${row.id}::uuid,${row.claimId}::uuid,${row.outcomeId}::uuid,
        ${value.context.current.userId},${value.context.current.sessionId}::uuid,${runtime.key.version},${input.reason},
        ${o.outcome},${o.phase},${o.replyCode},${JSON.stringify(source.sealed)}::jsonb,${source.sourceHash})`;
    if (row.state === 'CLAIMED') {
      await tx.$executeRaw`INSERT INTO "OrdinaryEmailOutcome" ("id","attemptId","claimId","outcome","phase","replyCode")
        VALUES (${randomUUID()}::uuid,${row.id}::uuid,${row.claimId}::uuid,${o.outcome},${o.phase},${o.replyCode})`;
    }
    await tx.$executeRaw`UPDATE "OrdinaryEmailAttempt" SET "state"=${o.outcome} WHERE "id"=${row.id}::uuid`;
    // A historical receipt cannot relabel a different revision/manual command.
    if (value.context.version.id === row.versionId && ['SENDING','UNCERTAIN'].includes(value.context.row.state)) {
      await tx.approvedCommunication.update({ where: { id: input.messageId }, data: { state: o.outcome === 'ACCEPTED' ? 'SENT' : 'ERROR' } });
    }
    const audit = { action: 'reconcile', attemptId: 'ordinary_attempt_uuid_'+row.id.replaceAll('-',''),
      reconciliationId: 'ordinary_reconciliation_uuid_'+preview.commandId.replaceAll('-',''),
      evidenceHash: source.sourceHash, status: o.outcome, previousStatus: row.state };
    await tx.communicationEvent.create({ data: { messageId: input.messageId, actorId: value.context.current.userId,
      event: 'ORDINARY_OUTCOME_RECONCILED', evidence: audit } });
    await tx.auditLog.create({ data: { id: 'ordinary-recovery:'+preview.commandId, actorId: value.context.current.userId,
      entityType: 'ApprovedCommunication', entityId: input.messageId, event: 'ordinary_email_reconciled', after: audit } });
    const finalClock = await personal(tx,value,runtime,credentials);
    verifyOrdinaryRecoveryPreview(input.token,runtime.key,finalClock);
    const [saved] = await tx.$queryRaw<Reconciliation[]>`SELECT "id","outcome","sourceHash","createdAt","reason" FROM "OrdinaryEmailReconciliation"
      WHERE "id"=${preview.commandId}::uuid`;
    return recordedResult(saved);
  }, { maxWait: 10_000, timeout: 30_000 });
}
