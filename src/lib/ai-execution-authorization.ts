import {
  Prisma,
  type AiExecutionDecisionType,
  type AiExecutionRequest,
  type AiExecutionRequestOrigin,
  type AiRun,
} from '@prisma/client';
import { UserFacingActionError } from './action-errors';
import { hasPermission, type AuthSession } from './auth';
import {
  AI_RUN_RELIABILITY_VERSION,
  createAiRunLeaseWithDbClock,
  type AiRunLease,
} from './ai-run-reliability';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { prisma } from './prisma';

const REQUEST_TTL_MS = 30 * 60 * 1000;
const SERIALIZABLE_ATTEMPTS = 3;

export const AI_EXECUTION_DECISION_COPY = Object.freeze({
  APPROVED: {
    reasonCode: 'AI_EXECUTION_APPROVED',
    reason: 'Autorizzazione approvata dall’Admin per la finalità operativa dichiarata.',
  },
  REJECTED: {
    reasonCode: 'AI_EXECUTION_REJECTED',
    reason: 'Richiesta respinta dall’Admin dopo la verifica del perimetro operativo.',
  },
  NEEDS_INFORMATION: {
    reasonCode: 'AI_EXECUTION_NEEDS_INFORMATION',
    reason: 'Richiesta sospesa in attesa di informazioni operative integrative.',
  },
  REVOKED: {
    reasonCode: 'AI_EXECUTION_REVOKED',
    reason: 'Autorizzazione revocata dall’Admin prima del relativo utilizzo.',
  },
  CANCELLED: {
    reasonCode: 'AI_EXECUTION_CANCELLED',
    reason: 'Richiesta annullata prima del relativo utilizzo dell’autorizzazione.',
  },
  EXPIRED: {
    reasonCode: 'AI_EXECUTION_EXPIRED',
    reason: 'Richiesta scaduta prima della decisione o del relativo utilizzo.',
  },
} as const);

type RequestBinding = {
  origin: AiExecutionRequestOrigin;
  functionCode: string;
  agentId: string;
  agentConfigVersion: number;
  provider: string;
  model?: string | null;
  purposeCode: string;
  dataCategories: readonly string[];
  correlationId: string;
  idempotencyKey: string;
  inputFingerprint: string;
  executionInputHash: string;
  clientId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  clientServiceId?: string | null;
};

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isSerializableConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

async function withSerializableTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializableConflict(error)) throw error;
      if (attempt === SERIALIZABLE_ATTEMPTS) {
        throw new UserFacingActionError(
          'Conflitto temporaneo nel gate di autorizzazione AI. Riprova tra qualche istante.',
        );
      }
    }
  }
  throw new UserFacingActionError('Gate di autorizzazione AI non completato.');
}

async function databaseNow(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`,
  );
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new UserFacingActionError('Clock PostgreSQL non disponibile. Richiesta AI bloccata.');
  }
  return now;
}

function sameRequestBinding(
  existing: AiExecutionRequest,
  session: AuthSession,
  input: RequestBinding,
) {
  return existing.requesterKind === 'HUMAN_USER'
    && existing.requesterUserId === session.userId
    && existing.origin === input.origin
    && existing.functionCode === input.functionCode
    && existing.agentId === input.agentId
    && existing.agentConfigVersion === input.agentConfigVersion
    && existing.provider === input.provider
    && existing.model === (input.model ?? null)
    && existing.purposeCode === input.purposeCode
    && existing.correlationId === input.correlationId
    && existing.idempotencyKey === input.idempotencyKey
    && existing.inputFingerprint === input.inputFingerprint
    && existing.executionInputHash === input.executionInputHash
    && canonicalJson(existing.dataCategories) === canonicalJson([...input.dataCategories])
    && existing.clientId === (input.clientId ?? null)
    && existing.companyId === (input.companyId ?? null)
    && existing.projectId === (input.projectId ?? null)
    && existing.clientServiceId === (input.clientServiceId ?? null);
}

export function effectiveAiExecutionRequestStatus(
  request: Pick<AiExecutionRequest, 'status' | 'expiresAt'>,
  now = new Date(),
) {
  if (
    request.expiresAt <= now
    && ['PENDING_ADMIN_APPROVAL', 'NEEDS_INFORMATION', 'APPROVED'].includes(request.status)
  ) return 'EXPIRED' as const;
  return request.status;
}

export function canViewAiExecutionRequest(
  session: AuthSession,
  request: Pick<AiExecutionRequest, 'requesterUserId'>,
) {
  return (session.role === 'admin' && hasPermission(session, 'ai.execution.audit'))
    || request.requesterUserId === session.userId;
}

/**
 * Persists lazy expiration with the same append-only ledger used by explicit
 * decisions. This is invoked only for already-visible request identifiers, so
 * reading the authorization inbox cannot leave an expired grant apparently
 * usable or an Admin notification pending indefinitely.
 */
export async function expireAiExecutionRequestsOnRead(requestIds: readonly string[]) {
  const ids = [...new Set(requestIds)].filter(Boolean).slice(0, 250);
  if (ids.length === 0) return 0;

  return withSerializableTransaction(async (tx) => {
    const expired = await tx.$queryRaw<Array<{ id: string; inputFingerprint: string }>>(
      Prisma.sql`
        SELECT "id", "inputFingerprint"
        FROM "AiExecutionRequest"
        WHERE "id" IN (${Prisma.join(ids)})
          AND "status" IN (
            'PENDING_ADMIN_APPROVAL'::"AiExecutionRequestStatus",
            'NEEDS_INFORMATION'::"AiExecutionRequestStatus",
            'APPROVED'::"AiExecutionRequestStatus"
          )
          AND "expiresAt" <= CURRENT_TIMESTAMP
        ORDER BY "id"
        FOR UPDATE
      `,
    );
    for (const request of expired) {
      await tx.aiExecutionDecision.create({
        data: {
          requestId: request.id,
          decisionType: 'EXPIRED',
          actorUserId: null,
          actorRole: null,
          ...AI_EXECUTION_DECISION_COPY.EXPIRED,
          requestFingerprint: request.inputFingerprint,
        },
      });
    }
    return expired.length;
  });
}

/**
 * Creates only the durable authorization request. PostgreSQL creates the
 * REQUESTED ledger event, minimized audit record and one notification for each
 * active Admin in the same statement transaction.
 */
export async function createAiExecutionRequest(
  session: AuthSession,
  input: RequestBinding,
) {
  if (!hasPermission(session, 'ai.execution.request')) {
    throw new UserFacingActionError('Permesso ai.execution.request obbligatorio.');
  }

  const existing = await prisma.aiExecutionRequest.findUnique({
    where: {
      origin_idempotencyKey: {
        origin: input.origin,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    if (!sameRequestBinding(existing, session, input)) {
      throw new UserFacingActionError(
        'Chiave richiesta AI già utilizzata con un contenuto differente. Ricarica la pagina.',
      );
    }
    return existing;
  }

  try {
    return await withSerializableTransaction(async (tx) => {
      const duplicate = await tx.aiExecutionRequest.findUnique({
        where: {
          origin_idempotencyKey: {
            origin: input.origin,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (duplicate) {
        if (!sameRequestBinding(duplicate, session, input)) {
          throw new UserFacingActionError(
            'Chiave richiesta AI già utilizzata con un contenuto differente. Ricarica la pagina.',
          );
        }
        return duplicate;
      }

      const now = await databaseNow(tx);
      return tx.aiExecutionRequest.create({
        data: {
          origin: input.origin,
          requesterKind: 'HUMAN_USER',
          requesterUserId: session.userId,
          requesterIdentity: null,
          clientId: input.clientId ?? null,
          companyId: input.companyId ?? null,
          projectId: input.projectId ?? null,
          clientServiceId: input.clientServiceId ?? null,
          functionCode: input.functionCode,
          agentId: input.agentId,
          agentConfigVersion: input.agentConfigVersion,
          provider: input.provider,
          model: input.model ?? null,
          purposeCode: input.purposeCode,
          dataCategories: [...input.dataCategories],
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
          inputFingerprint: input.inputFingerprint,
          executionInputHash: input.executionInputHash,
          expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
          status: 'PENDING_ADMIN_APPROVAL',
          stateVersion: 1,
        },
      });
    });
  } catch (error) {
    if (error instanceof UserFacingActionError) throw error;
    if (isUniqueConstraintError(error)) {
      const duplicate = await prisma.aiExecutionRequest.findUnique({
        where: {
          origin_idempotencyKey: {
            origin: input.origin,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (duplicate && sameRequestBinding(duplicate, session, input)) return duplicate;
    }
    throw new UserFacingActionError(
      'Richiesta AI non creata. Verifica che esista almeno un Admin attivo e riprova.',
    );
  }
}

async function createDecision(
  session: AuthSession,
  requestId: string,
  decisionType: Extract<
    AiExecutionDecisionType,
    'APPROVED' | 'REJECTED' | 'NEEDS_INFORMATION' | 'REVOKED' | 'CANCELLED'
  >,
) {
  const permission = decisionType === 'APPROVED'
    ? 'ai.execution.approve'
    : decisionType === 'REVOKED'
      ? 'ai.execution.revoke'
      : decisionType === 'CANCELLED'
        ? 'ai.execution.request'
        : 'ai.execution.reject';
  if (!hasPermission(session, permission)) {
    throw new UserFacingActionError(`Permesso ${permission} obbligatorio.`);
  }

  return withSerializableTransaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "AiExecutionRequest" WHERE "id" = ${requestId} FOR UPDATE`,
    );
    const request = await tx.aiExecutionRequest.findUnique({
      where: { id: requestId },
      include: { authorizationGrant: true },
    });
    if (!request || !canViewAiExecutionRequest(session, request)) {
      throw new UserFacingActionError('Richiesta AI non disponibile nel perimetro autorizzato.');
    }

    const now = await databaseNow(tx);
    if (
      request.expiresAt <= now
      && ['PENDING_ADMIN_APPROVAL', 'NEEDS_INFORMATION', 'APPROVED'].includes(request.status)
    ) {
      await tx.aiExecutionDecision.create({
        data: {
          requestId: request.id,
          decisionType: 'EXPIRED',
          actorUserId: null,
          actorRole: null,
          ...AI_EXECUTION_DECISION_COPY.EXPIRED,
          requestFingerprint: request.inputFingerprint,
        },
      });
      return tx.aiExecutionRequest.findUniqueOrThrow({
        where: { id: request.id },
        include: { authorizationGrant: true },
      });
    }

    if (decisionType === 'CANCELLED') {
      const requesterOrAdmin = request.requesterUserId === session.userId || session.role === 'admin';
      if (!requesterOrAdmin) {
        throw new UserFacingActionError('Solo il richiedente o un Admin può annullare la richiesta.');
      }
    } else if (session.role !== 'admin') {
      throw new UserFacingActionError('La decisione AI richiede un Admin attivo.');
    }

    const copy = AI_EXECUTION_DECISION_COPY[decisionType];
    await tx.aiExecutionDecision.create({
      data: {
        requestId: request.id,
        decisionType,
        actorUserId: session.userId,
        actorRole: session.role,
        reasonCode: copy.reasonCode,
        reason: copy.reason,
        requestFingerprint: request.inputFingerprint,
      },
    });

    return tx.aiExecutionRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: { authorizationGrant: true },
    });
  });
}

export function approveAiExecutionRequest(session: AuthSession, requestId: string) {
  return createDecision(session, requestId, 'APPROVED');
}

export function rejectAiExecutionRequest(session: AuthSession, requestId: string) {
  return createDecision(session, requestId, 'REJECTED');
}

export function requestAiExecutionInformation(session: AuthSession, requestId: string) {
  return createDecision(session, requestId, 'NEEDS_INFORMATION');
}

export function revokeAiExecutionRequest(session: AuthSession, requestId: string) {
  return createDecision(session, requestId, 'REVOKED');
}

export function cancelAiExecutionRequest(session: AuthSession, requestId: string) {
  return createDecision(session, requestId, 'CANCELLED');
}

export async function markAiExecutionNotificationRead(
  session: AuthSession,
  requestId: string,
) {
  if (session.role !== 'admin') return;
  const now = new Date();
  await prisma.aiExecutionAdminNotification.updateMany({
    where: {
      requestId,
      recipientAdminId: session.userId,
      isRead: false,
    },
    data: { isRead: true, readAt: now, updatedAt: now },
  });
}

export type AuthorizedAiRunReservationInput = {
  requestId: string;
  authorizationGrantId: string;
  /**
   * Recomputed by the future consumer from the exact execution input.
   * Grant identifiers alone are never sufficient to consume authorization.
   */
  inputFingerprint: string;
  input?: Prisma.InputJsonValue;
  operationalInstructions?: string | null;
};

declare const aiExecutionRuntimePermitBrand: unique symbol;
export type AiExecutionRuntimePermit = {
  readonly [aiExecutionRuntimePermitBrand]: true;
};

type AiExecutionRuntimePermitClaims = {
  runId: string;
  provider: string;
  model: string | null;
  inputFingerprint: string;
  executionInputHash: string;
};

const activeAiExecutionRuntimePermits = new WeakMap<object, AiExecutionRuntimePermitClaims>();

function issueAiExecutionRuntimePermit(claims: AiExecutionRuntimePermitClaims) {
  const permit = Object.freeze({}) as AiExecutionRuntimePermit;
  activeAiExecutionRuntimePermits.set(permit, claims);
  return permit;
}

/**
 * The adapter boundary consumes this opaque capability before any mock or
 * external provider work. The exact adapter input must match the input stored
 * when the authorized AiRun was reserved.
 */
export function consumeAiExecutionRuntimePermit(
  permit: AiExecutionRuntimePermit | null | undefined,
  expected: {
    provider: string;
    model?: string | null;
    input: unknown;
  },
) {
  if (!permit || typeof permit !== 'object') {
    throw new UserFacingActionError('Autorizzazione runtime AI assente.');
  }
  const claims = activeAiExecutionRuntimePermits.get(permit);
  activeAiExecutionRuntimePermits.delete(permit);
  if (
    !claims
    || claims.provider !== expected.provider
    || claims.model !== (expected.model ?? null)
    || claims.executionInputHash !== canonicalSha256(expected.input ?? null)
  ) {
    throw new UserFacingActionError(
      'Autorizzazione runtime AI non valida o riferita a input modificati.',
    );
  }
  return Object.freeze({
    runId: claims.runId,
    inputFingerprint: claims.inputFingerprint,
  });
}

export type AuthorizedAiRunReservation = {
  run: AiRun;
  lease: AiRunLease;
  runtimePermit: AiExecutionRuntimePermit;
};

/**
 * Internal future-consumer boundary. It reserves and consumes exactly one
 * approved grant and creates one fenced AiRun, but never invokes an adapter.
 * PR85 intentionally does not expose this function through a server action,
 * route, worker, scheduler or UI control.
 */
export async function reserveAuthorizedAiRun(
  input: AuthorizedAiRunReservationInput,
): Promise<AuthorizedAiRunReservation> {
  const executionInputHash = canonicalSha256(input.input ?? null);
  const result = await withSerializableTransaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "AiExecutionRequest" WHERE "id" = ${input.requestId} FOR UPDATE`,
    );
    const request = await tx.aiExecutionRequest.findUnique({
      where: { id: input.requestId },
      include: {
        authorizationGrant: true,
        agentConfig: { select: { promptVersion: true } },
      },
    });
    if (
      !request
      || !request.authorizationGrant
      || request.authorizationGrant.id !== input.authorizationGrantId
      || request.status !== 'APPROVED'
      || input.inputFingerprint !== request.inputFingerprint
      || input.inputFingerprint !== request.authorizationGrant.inputFingerprint
      || executionInputHash !== request.executionInputHash
      || executionInputHash !== request.authorizationGrant.executionInputHash
    ) {
      throw new UserFacingActionError(
        'Autorizzazione AI non valida, non approvata o riferita a input modificati.',
      );
    }
    const now = await databaseNow(tx);
    if (
      request.expiresAt <= now
      || request.authorizationGrant.expiresAt <= now
    ) {
      await tx.aiExecutionDecision.create({
        data: {
          requestId: request.id,
          decisionType: 'EXPIRED',
          actorUserId: null,
          actorRole: null,
          ...AI_EXECUTION_DECISION_COPY.EXPIRED,
          requestFingerprint: request.inputFingerprint,
        },
      });
      return { expired: true as const };
    }

    const lease = await createAiRunLeaseWithDbClock(tx);
    const run = await tx.aiRun.create({
      data: {
        id: lease.runId,
        reliabilityVersion: AI_RUN_RELIABILITY_VERSION,
        agentId: request.agentId,
        agentConfigVersion: request.agentConfigVersion,
        clientId: request.clientId,
        clientServiceId: request.clientServiceId,
        projectId: request.projectId,
        status: 'running',
        provider: request.provider,
        model: request.model,
        promptVersion: request.agentConfig.promptVersion,
        requestKey: request.idempotencyKey,
        requestFingerprint: input.inputFingerprint,
        executionInputHash,
        leaseExpiresAt: lease.leaseExpiresAt,
        leaseTokenHash: lease.leaseTokenHash,
        input: input.input ?? Prisma.DbNull,
        operationalInstructions: input.operationalInstructions ?? null,
        createdById: request.requesterUserId,
        aiExecutionRequestId: request.id,
        authorizationGrantId: request.authorizationGrant.id,
        createdAt: lease.leaseStartedAt,
      },
    });
    return { expired: false as const, run, lease: lease.lease };
  });
  if (result.expired) {
    throw new UserFacingActionError('Autorizzazione AI scaduta.');
  }
  return {
    run: result.run,
    lease: result.lease,
    runtimePermit: issueAiExecutionRuntimePermit({
      runId: result.run.id,
      provider: result.run.provider,
      model: result.run.model,
      inputFingerprint: input.inputFingerprint,
      executionInputHash,
    }),
  };
}
