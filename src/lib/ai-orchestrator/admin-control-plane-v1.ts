import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Prisma, type PrismaClient, type RoleCode } from '@prisma/client';
import { z } from 'zod';
import { evaluatePermission } from '../permission-evaluator';
import { type Permission } from '../permissions';
import { SerializableConflictError, withSerializableTransaction } from '../serializable';
import {
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS,
  AI_ORCHESTRATOR_ADMIN_EMERGENCY_STOP_INTENT_HASH,
  AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE,
  AI_ORCHESTRATOR_ADMIN_GLOBAL_SCOPE_CODE,
  AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY_CODE,
  AiOrchestratorAdminChangeReasonCodeSchema,
  AiOrchestratorAdminGlobalPolicySchema,
  AiOrchestratorAdminNonGlobalScopeTypeSchema,
  AiOrchestratorAdminPermissionDecisionSchema,
  AiOrchestratorAdminPermissionSchema,
  AiOrchestratorAdminReasonSchema,
  AiOrchestratorAdminScopePolicySchema,
  AiOrchestratorAdminScopeTypeSchema,
  buildAiOrchestratorAdminRequestIdentity,
  buildAiOrchestratorAdminRevisionIdentity,
  createAiOrchestratorAdminPolicyHash,
  createAiOrchestratorAdminRequestHash,
  createAiOrchestratorAdminRevisionHash,
  diffAiOrchestratorAdminPolicies,
  engageAiOrchestratorEmergencyStop,
  getAiOrchestratorAdminControlTarget,
  validateAiOrchestratorAdminPolicyForTarget,
  type AiOrchestratorAdminControlTarget,
  type AiOrchestratorAdminGlobalPolicy,
  type AiOrchestratorAdminOperationCode,
  type AiOrchestratorAdminPermission,
  type AiOrchestratorAdminPermissionDecision,
  type AiOrchestratorAdminPolicy,
  type AiOrchestratorAdminScopeType,
} from './admin-control-policy-v1';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TRANSACTION_ATTEMPTS = 3;
const MAX_REVISION_PAGE_SIZE = 50;
const DEFAULT_REVISION_PAGE_SIZE = 25;

const actorUserIdSchema = z.string().trim().min(1).max(191);
const requestIdSchema = z.string().regex(UUID_V4_PATTERN, 'requestId deve essere un UUIDv4 lowercase.');
const hashSchema = z.string().regex(SHA256_PATTERN);

const commonCommandFields = {
  actorUserId: actorUserIdSchema,
  requestId: requestIdSchema,
  reasonCode: AiOrchestratorAdminChangeReasonCodeSchema,
  reason: AiOrchestratorAdminReasonSchema,
  confirmed: z.literal(true),
} as const;

export const AiOrchestratorAdminSetGlobalPolicyCommandSchema = z.object({
  ...commonCommandFields,
  operationCode: z.literal('SET_GLOBAL_POLICY'),
  expectedVersion: z.number().int().positive(),
  expectedRevisionHash: hashSchema,
  policy: AiOrchestratorAdminGlobalPolicySchema,
}).strict();

export const AiOrchestratorAdminSetScopePolicyCommandSchema = z.object({
  ...commonCommandFields,
  operationCode: z.literal('SET_SCOPE_POLICY'),
  expectedVersion: z.number().int().positive(),
  expectedRevisionHash: hashSchema,
  policy: AiOrchestratorAdminScopePolicySchema,
}).strict();

export const AiOrchestratorAdminEmergencyStopCommandSchema = z.object({
  ...commonCommandFields,
  operationCode: z.literal('EMERGENCY_STOP'),
  reasonCode: z.enum(['EMERGENCY_STOP', 'SECURITY_RESPONSE']),
}).strict();

export const AiOrchestratorAdminControlCommandSchema = z.discriminatedUnion('operationCode', [
  AiOrchestratorAdminSetGlobalPolicyCommandSchema,
  AiOrchestratorAdminSetScopePolicyCommandSchema,
  AiOrchestratorAdminEmergencyStopCommandSchema,
]);

export type AiOrchestratorAdminControlCommand = z.infer<typeof AiOrchestratorAdminControlCommandSchema>;

export type AiOrchestratorAdminControlRejectionCode =
  | 'ACTOR_NOT_AUTHORIZED'
  | 'CAS_MISMATCH'
  | 'LEDGER_INTEGRITY_ERROR'
  | 'NO_CHANGE'
  | 'REQUEST_ID_COLLISION'
  | 'TARGET_NOT_FOUND';

export interface AiOrchestratorAdminRevisionSnapshot {
  readonly id: string;
  readonly scopeType: AiOrchestratorAdminScopeType;
  readonly scopeCode: string;
  readonly targetDefinitionHash: string;
  readonly version: number;
  readonly policy: AiOrchestratorAdminPolicy;
  readonly policyHash: string;
  readonly previousRevisionHash: string | null;
  readonly revisionHash: string;
  readonly requestId: string | null;
  readonly requestHash: string;
  readonly requestedPolicyHash: string;
  readonly expectedVersion: number | null;
  readonly expectedRevisionHash: string | null;
  readonly operationCode: AiOrchestratorAdminOperationCode;
  readonly requiredPermissions: readonly AiOrchestratorAdminPermission[];
  readonly permissionDecisions: readonly AiOrchestratorAdminPermissionDecision[];
  readonly actorUserId: string | null;
  readonly actorRole: RoleCode | null;
  readonly reasonCode: string;
  readonly reason: string;
  readonly confirmed: boolean;
  readonly createdAt: Date;
}

/** Read projection intentionally excludes reason, actor, request and RBAC proof. */
export interface AiOrchestratorAdminDesiredPolicySnapshot {
  readonly scopeType: AiOrchestratorAdminScopeType;
  readonly scopeCode: string;
  readonly targetDefinitionHash: string;
  readonly version: number;
  readonly policy: AiOrchestratorAdminPolicy;
  readonly policyHash: string;
  readonly revisionHash: string;
  readonly createdAt: Date;
}

function projectDesiredPolicySnapshot(
  revision: AiOrchestratorAdminRevisionSnapshot,
): AiOrchestratorAdminDesiredPolicySnapshot {
  return Object.freeze({
    scopeType: revision.scopeType,
    scopeCode: revision.scopeCode,
    targetDefinitionHash: revision.targetDefinitionHash,
    version: revision.version,
    policy: revision.policy,
    policyHash: revision.policyHash,
    revisionHash: revision.revisionHash,
    createdAt: revision.createdAt,
  });
}

const revisionCursorPayloadSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().min(1).max(191),
  scopeType: AiOrchestratorAdminScopeTypeSchema.nullable(),
  scopeCode: z.string().min(1).max(160).nullable(),
}).strict();

export interface AiOrchestratorAdminRevisionCursor {
  readonly createdAt: Date;
  readonly id: string;
  readonly scopeType: AiOrchestratorAdminScopeType | null;
  readonly scopeCode: string | null;
}

export function encodeAiOrchestratorAdminRevisionCursor(
  cursor: AiOrchestratorAdminRevisionCursor,
) {
  const payload = revisionCursorPayloadSchema.parse({
    version: 1,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
    scopeType: cursor.scopeType,
    scopeCode: cursor.scopeCode,
  });
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeAiOrchestratorAdminRevisionCursor(
  value: string,
): AiOrchestratorAdminRevisionCursor {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) {
    throw new TypeError('AI_ORCHESTRATOR_ADMIN_CURSOR_INVALID');
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) {
      throw new TypeError('AI_ORCHESTRATOR_ADMIN_CURSOR_NON_CANONICAL');
    }
    const payload = revisionCursorPayloadSchema.parse(JSON.parse(decoded.toString('utf8')));
    return Object.freeze({
      createdAt: new Date(payload.createdAt),
      id: payload.id,
      scopeType: payload.scopeType,
      scopeCode: payload.scopeCode,
    });
  } catch {
    throw new TypeError('AI_ORCHESTRATOR_ADMIN_CURSOR_INVALID');
  }
}

export type AiOrchestratorAdminControlMutationResult =
  | { readonly ok: true; readonly replayed: boolean; readonly revision: AiOrchestratorAdminRevisionSnapshot }
  | { readonly ok: false; readonly code: AiOrchestratorAdminControlRejectionCode; readonly message: string };

type Tx = Prisma.TransactionClient;

export interface AiOrchestratorAdminPersistedRevisionRowV1 {
  id: string;
  scopeType: string;
  scopeCode: string;
  targetDefinitionHash: string;
  version: number;
  policy: unknown;
  policyHash: string;
  previousRevisionHash: string | null;
  revisionHash: string;
  requestId: string | null;
  requestHash: string;
  requestedPolicyHash: string | null;
  expectedVersion: number | null;
  expectedRevisionHash: string | null;
  operationCode: string;
  requiredPermissions: unknown;
  permissionDecisions: unknown;
  actorUserId: string | null;
  actorRole: string | null;
  reasonCode: string;
  reason: string;
  confirmed: boolean;
  createdAt: Date;
}

/** @deprecated Use AiOrchestratorAdminPersistedRevisionRowV1. */
export type RevisionRow = AiOrchestratorAdminPersistedRevisionRowV1;

interface ActorRow {
  id: string;
  role: RoleCode;
  active: boolean;
  deletedAt: Date | null;
}

interface PreparedCommand {
  readonly command: AiOrchestratorAdminControlCommand;
  readonly target: AiOrchestratorAdminControlTarget;
  readonly requestedPolicyHash: string;
  readonly expectedVersion: number | null;
  readonly expectedRevisionHash: string | null;
  readonly requestHash: string;
}

function rejected(code: AiOrchestratorAdminControlRejectionCode, message: string): AiOrchestratorAdminControlMutationResult {
  return { ok: false, code, message };
}

function jsonInput(value: unknown) {
  return value as Prisma.InputJsonValue;
}

function prepareCommand(input: unknown): PreparedCommand {
  const command = AiOrchestratorAdminControlCommandSchema.parse(input);
  let target: AiOrchestratorAdminControlTarget | null;
  let requestedPolicyHash: string;
  let expectedVersion: number | null;
  let expectedRevisionHash: string | null;

  if (command.operationCode === 'SET_GLOBAL_POLICY') {
    target = getAiOrchestratorAdminControlTarget('GLOBAL', AI_ORCHESTRATOR_ADMIN_GLOBAL_SCOPE_CODE);
    requestedPolicyHash = createAiOrchestratorAdminPolicyHash(command.policy);
    expectedVersion = command.expectedVersion;
    expectedRevisionHash = command.expectedRevisionHash;
  } else if (command.operationCode === 'SET_SCOPE_POLICY') {
    target = getAiOrchestratorAdminControlTarget(command.policy.scopeType, command.policy.scopeCode);
    requestedPolicyHash = createAiOrchestratorAdminPolicyHash(command.policy);
    expectedVersion = command.expectedVersion;
    expectedRevisionHash = command.expectedRevisionHash;
  } else {
    target = getAiOrchestratorAdminControlTarget('GLOBAL', AI_ORCHESTRATOR_ADMIN_GLOBAL_SCOPE_CODE);
    requestedPolicyHash = AI_ORCHESTRATOR_ADMIN_EMERGENCY_STOP_INTENT_HASH;
    expectedVersion = null;
    expectedRevisionHash = null;
  }

  if (!target) throw new TypeError('Target Admin Control Plane non canonico.');
  if (command.operationCode !== 'EMERGENCY_STOP') {
    validateAiOrchestratorAdminPolicyForTarget(target, command.policy);
  }

  const requestIdentity = buildAiOrchestratorAdminRequestIdentity({
    actorUserId: command.actorUserId,
    requestId: command.requestId,
    scopeType: target.scopeType,
    scopeCode: target.scopeCode,
    expectedVersion,
    expectedRevisionHash,
    operationCode: command.operationCode,
    requestedPolicyHash,
    reasonCode: command.reasonCode,
    reason: command.reason,
    confirmed: command.confirmed,
  });

  return Object.freeze({
    command,
    target,
    requestedPolicyHash,
    expectedVersion,
    expectedRevisionHash,
    requestHash: createAiOrchestratorAdminRequestHash(requestIdentity),
  });
}

async function loadActor(tx: Tx, actorUserId: string) {
  const actors = await tx.$queryRaw<ActorRow[]>(Prisma.sql`
    SELECT "id", "role", "active", "deletedAt"
    FROM "User"
    WHERE "id" = ${actorUserId}
    FOR SHARE
  `);
  const actor = actors[0] ?? null;
  if (!actor || actor.active !== true || actor.deletedAt !== null) return null;
  const permissionOverrides = await tx.$queryRaw<Array<{ permission: string; allowed: boolean }>>(Prisma.sql`
    SELECT "permission", "allowed"
    FROM "UserPermissionOverride"
    WHERE "userId" = ${actor.id}
    ORDER BY "permission" COLLATE "C"
    FOR SHARE
  `);
  return { actor, permissionOverrides };
}

async function lockScope(tx: Tx, target: AiOrchestratorAdminControlTarget) {
  await tx.$queryRaw(Prisma.sql`
    SELECT PG_ADVISORY_XACT_LOCK(
      HASHTEXTEXTENDED(${`${target.scopeType}\u001f${target.scopeCode}`}, 7901::BIGINT)
    )::TEXT AS "lock"
  `);
}

async function loadLatestRevision(tx: Tx, target: AiOrchestratorAdminControlTarget) {
  const rows = await tx.$queryRaw<AiOrchestratorAdminPersistedRevisionRowV1[]>(Prisma.sql`
    SELECT *
    FROM "AiOrchestratorAdminPolicyRevision"
    WHERE "scopeType" = ${target.scopeType}
      AND "scopeCode" = ${target.scopeCode}
    ORDER BY "version" DESC
    LIMIT 1
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function loadRevisionByRequestId(tx: Tx, requestId: string) {
  const rows = await tx.$queryRaw<AiOrchestratorAdminPersistedRevisionRowV1[]>(Prisma.sql`
    SELECT *
    FROM "AiOrchestratorAdminPolicyRevision"
    WHERE "requestId" = ${requestId}
    LIMIT 1
  `);
  return rows[0] ?? null;
}

export function assertAiOrchestratorAdminPersistedRevisionV1(
  row: AiOrchestratorAdminPersistedRevisionRowV1,
): AiOrchestratorAdminRevisionSnapshot {
  const scopeType = AiOrchestratorAdminScopeTypeSchema.parse(row.scopeType);
  const target = getAiOrchestratorAdminControlTarget(scopeType, row.scopeCode);
  if (!target || target.targetDefinitionHash !== row.targetDefinitionHash) {
    throw new Error('AI_ORCHESTRATOR_ADMIN_LEDGER_TARGET_MISMATCH');
  }
  const policy = validateAiOrchestratorAdminPolicyForTarget(target, row.policy);
  const policyHash = createAiOrchestratorAdminPolicyHash(policy);
  if (policyHash !== row.policyHash || !row.requestedPolicyHash) {
    throw new Error('AI_ORCHESTRATOR_ADMIN_LEDGER_POLICY_HASH_MISMATCH');
  }
  const operationCode = z.enum(['GENESIS', 'SET_GLOBAL_POLICY', 'SET_SCOPE_POLICY', 'EMERGENCY_STOP']).parse(row.operationCode);
  const requiredPermissions = z.array(AiOrchestratorAdminPermissionSchema).parse(row.requiredPermissions);
  const permissionDecisions = z.array(AiOrchestratorAdminPermissionDecisionSchema).parse(row.permissionDecisions);
  const actorRole = row.actorRole === null
    ? null
    : z.enum(['admin', 'direzione', 'commerciale', 'consulente', 'revisore', 'backoffice', 'amministrazione', 'collaboratore_limitato']).parse(row.actorRole);

  const requestHash = createAiOrchestratorAdminRequestHash({
    actorUserId: row.actorUserId,
    requestId: row.requestId,
    scopeType,
    scopeCode: row.scopeCode,
    expectedVersion: row.expectedVersion,
    expectedRevisionHash: row.expectedRevisionHash,
    operationCode,
    requestedPolicyHash: row.requestedPolicyHash,
    reasonCode: row.reasonCode,
    reason: row.reason,
    confirmed: row.confirmed,
  });
  if (requestHash !== row.requestHash) throw new Error('AI_ORCHESTRATOR_ADMIN_LEDGER_REQUEST_HASH_MISMATCH');

  const revisionIdentity = buildAiOrchestratorAdminRevisionIdentity({
    scopeType,
    scopeCode: row.scopeCode,
    targetDefinitionHash: row.targetDefinitionHash,
    version: row.version,
    policyHash: row.policyHash,
    previousRevisionHash: row.previousRevisionHash,
    requestId: row.requestId,
    requestHash: row.requestHash,
    operationCode,
    requiredPermissions,
    permissionDecisions,
    actorUserId: row.actorUserId,
    actorRole,
    reasonCode: row.reasonCode,
    reason: row.reason,
    confirmed: row.confirmed,
  });
  if (createAiOrchestratorAdminRevisionHash(revisionIdentity) !== row.revisionHash) {
    throw new Error('AI_ORCHESTRATOR_ADMIN_LEDGER_REVISION_HASH_MISMATCH');
  }

  return Object.freeze({
    id: row.id,
    scopeType,
    scopeCode: row.scopeCode,
    targetDefinitionHash: row.targetDefinitionHash,
    version: row.version,
    policy,
    policyHash: row.policyHash,
    previousRevisionHash: row.previousRevisionHash,
    revisionHash: row.revisionHash,
    requestId: row.requestId,
    requestHash: row.requestHash,
    requestedPolicyHash: row.requestedPolicyHash,
    expectedVersion: row.expectedVersion,
    expectedRevisionHash: row.expectedRevisionHash,
    operationCode,
    requiredPermissions: Object.freeze(requiredPermissions),
    permissionDecisions: Object.freeze(permissionDecisions),
    actorUserId: row.actorUserId,
    actorRole,
    reasonCode: row.reasonCode,
    reason: row.reason,
    confirmed: row.confirmed,
    createdAt: row.createdAt,
  });
}

/** @deprecated Use assertAiOrchestratorAdminPersistedRevisionV1. */
export const assertPersistedRevision = assertAiOrchestratorAdminPersistedRevisionV1;

async function auditBlocked(
  tx: Tx,
  prepared: PreparedCommand,
  code: AiOrchestratorAdminControlRejectionCode,
  actorRole: RoleCode | null,
  extra: Record<string, unknown> = {},
) {
  await tx.auditLog.create({
    data: {
      actorId: prepared.command.actorUserId,
      event: code === 'CAS_MISMATCH'
        ? 'ai_orchestrator_control_cas_conflict'
        : 'ai_orchestrator_control_change_blocked',
      entityType: 'AiOrchestratorAdminPolicyRevision',
      entityId: `${prepared.target.scopeType}:${prepared.target.scopeCode}`,
      after: jsonInput({
        actorRole,
        operationCode: prepared.command.operationCode,
        rejectionCode: code,
        requestHash: prepared.requestHash,
        requestId: prepared.command.requestId,
        scopeCode: prepared.target.scopeCode,
        scopeType: prepared.target.scopeType,
        ...extra,
      }),
    },
  });
}

function resolvePermissionDecisions(
  actor: ActorRow,
  permissionOverrides: readonly { permission: string; allowed: boolean }[],
  requiredPermissions: readonly AiOrchestratorAdminPermission[],
) {
  const session = { role: actor.role, active: actor.active, permissionOverrides };
  return requiredPermissions.map((permission) => ({
    permission,
    ...evaluatePermission(session, permission as Permission),
  }));
}

async function mutateTx(tx: Tx, prepared: PreparedCommand): Promise<AiOrchestratorAdminControlMutationResult> {
  const actorContext = await loadActor(tx, prepared.command.actorUserId);
  if (!actorContext) {
    await auditBlocked(tx, prepared, 'ACTOR_NOT_AUTHORIZED', null);
    return rejected('ACTOR_NOT_AUTHORIZED', 'Attore inattivo, eliminato o inesistente.');
  }

  await lockScope(tx, prepared.target);
  const existingRequest = await loadRevisionByRequestId(tx, prepared.command.requestId);
  if (existingRequest) {
    if (existingRequest.requestHash !== prepared.requestHash) {
      await auditBlocked(tx, prepared, 'REQUEST_ID_COLLISION', actorContext.actor.role);
      return rejected('REQUEST_ID_COLLISION', 'requestId già usato con contenuto differente.');
    }
    return {
      ok: true,
      replayed: true,
      revision: assertAiOrchestratorAdminPersistedRevisionV1(existingRequest),
    };
  }

  const latestRow = await loadLatestRevision(tx, prepared.target);
  if (!latestRow) {
    await auditBlocked(tx, prepared, 'TARGET_NOT_FOUND', actorContext.actor.role);
    return rejected('TARGET_NOT_FOUND', 'Policy bootstrap del target non disponibile.');
  }

  let latest: AiOrchestratorAdminRevisionSnapshot;
  try {
    latest = assertAiOrchestratorAdminPersistedRevisionV1(latestRow);
  } catch {
    await auditBlocked(tx, prepared, 'LEDGER_INTEGRITY_ERROR', actorContext.actor.role);
    return rejected('LEDGER_INTEGRITY_ERROR', 'Integrità del ledger Admin Control Plane non valida.');
  }

  if (
    prepared.command.operationCode !== 'EMERGENCY_STOP'
    && (
      prepared.expectedVersion !== latest.version
      || prepared.expectedRevisionHash !== latest.revisionHash
    )
  ) {
    await auditBlocked(tx, prepared, 'CAS_MISMATCH', actorContext.actor.role, {
      currentRevisionHash: latest.revisionHash,
      currentVersion: latest.version,
      expectedRevisionHash: prepared.expectedRevisionHash,
      expectedVersion: prepared.expectedVersion,
    });
    return rejected('CAS_MISMATCH', 'La policy è cambiata: ricaricare la versione corrente.');
  }

  const nextPolicy = prepared.command.operationCode === 'EMERGENCY_STOP'
    ? engageAiOrchestratorEmergencyStop(latest.policy)
    : validateAiOrchestratorAdminPolicyForTarget(prepared.target, prepared.command.policy);
  const diff = diffAiOrchestratorAdminPolicies(latest.policy, nextPolicy, prepared.command.operationCode);
  const permissionDecisions = resolvePermissionDecisions(
    actorContext.actor,
    actorContext.permissionOverrides,
    diff.requiredPermissions,
  );
  if (permissionDecisions.some(({ allowed }) => !allowed)) {
    await auditBlocked(tx, prepared, 'ACTOR_NOT_AUTHORIZED', actorContext.actor.role, {
      requiredPermissions: diff.requiredPermissions,
    });
    return rejected('ACTOR_NOT_AUTHORIZED', 'Permessi AI Orchestrator insufficienti.');
  }
  const acceptedPermissionDecisions = z.array(AiOrchestratorAdminPermissionDecisionSchema)
    .parse(permissionDecisions);

  if (diff.changedPaths.length === 0) {
    await auditBlocked(tx, prepared, 'NO_CHANGE', actorContext.actor.role);
    return rejected('NO_CHANGE', 'La nuova policy è identica alla revisione corrente.');
  }

  const policyHash = createAiOrchestratorAdminPolicyHash(nextPolicy);
  const requestIdentity = buildAiOrchestratorAdminRequestIdentity({
    actorUserId: prepared.command.actorUserId,
    requestId: prepared.command.requestId,
    scopeType: prepared.target.scopeType,
    scopeCode: prepared.target.scopeCode,
    expectedVersion: prepared.expectedVersion,
    expectedRevisionHash: prepared.expectedRevisionHash,
    operationCode: prepared.command.operationCode,
    requestedPolicyHash: prepared.requestedPolicyHash,
    reasonCode: prepared.command.reasonCode,
    reason: prepared.command.reason,
    confirmed: prepared.command.confirmed,
  });
  const requestHash = createAiOrchestratorAdminRequestHash(requestIdentity);
  if (requestHash !== prepared.requestHash) throw new Error('AI_ORCHESTRATOR_ADMIN_REQUEST_HASH_DRIFT');

  const revisionIdentity = buildAiOrchestratorAdminRevisionIdentity({
    scopeType: prepared.target.scopeType,
    scopeCode: prepared.target.scopeCode,
    targetDefinitionHash: prepared.target.targetDefinitionHash,
    version: latest.version + 1,
    policyHash,
    previousRevisionHash: latest.revisionHash,
    requestId: prepared.command.requestId,
    requestHash,
    operationCode: prepared.command.operationCode,
    requiredPermissions: [...diff.requiredPermissions],
    permissionDecisions: acceptedPermissionDecisions,
    actorUserId: actorContext.actor.id,
    actorRole: actorContext.actor.role,
    reasonCode: prepared.command.reasonCode,
    reason: prepared.command.reason,
    confirmed: prepared.command.confirmed,
  });
  const revisionHash = createAiOrchestratorAdminRevisionHash(revisionIdentity);
  const id = randomUUID();

  const created = await tx.aiOrchestratorAdminPolicyRevision.create({
    data: {
      id,
      scopeType: prepared.target.scopeType,
      scopeCode: prepared.target.scopeCode,
      targetDefinitionHash: prepared.target.targetDefinitionHash,
      version: latest.version + 1,
      policy: jsonInput(nextPolicy),
      policyHash,
      previousRevisionHash: latest.revisionHash,
      revisionHash,
      requestId: prepared.command.requestId,
      requestHash,
      requestedPolicyHash: prepared.requestedPolicyHash,
      expectedVersion: prepared.expectedVersion,
      expectedRevisionHash: prepared.expectedRevisionHash,
      operationCode: prepared.command.operationCode,
      requiredPermissions: jsonInput([...diff.requiredPermissions]),
      permissionDecisions: jsonInput(acceptedPermissionDecisions),
      actorUserId: actorContext.actor.id,
      actorRole: actorContext.actor.role,
      reasonCode: prepared.command.reasonCode,
      reason: prepared.command.reason,
      confirmed: prepared.command.confirmed,
    },
  });

  await tx.auditLog.create({
    data: {
      actorId: actorContext.actor.id,
      event: prepared.command.operationCode === 'EMERGENCY_STOP'
        ? 'ai_orchestrator_emergency_stop_activated'
        : 'ai_orchestrator_control_policy_changed',
      entityType: 'AiOrchestratorAdminPolicyRevision',
      entityId: created.id,
      before: jsonInput({
        policyHash: latest.policyHash,
        revisionHash: latest.revisionHash,
        version: latest.version,
      }),
      after: jsonInput({
        changedPaths: diff.changedPaths,
        operationCode: prepared.command.operationCode,
        policyHash: created.policyHash,
        requestHash: created.requestHash,
        requestId: created.requestId,
        revisionHash: created.revisionHash,
        scopeCode: created.scopeCode,
        scopeType: created.scopeType,
        version: created.version,
      }),
    },
  });

  return {
    ok: true,
    replayed: false,
    revision: assertAiOrchestratorAdminPersistedRevisionV1(
      created as unknown as AiOrchestratorAdminPersistedRevisionRowV1,
    ),
  };
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function mutateAiOrchestratorAdminControlPolicy(
  prisma: PrismaClient,
  input: unknown,
): Promise<AiOrchestratorAdminControlMutationResult> {
  const prepared = prepareCommand(input);
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await withSerializableTransaction(prisma, (tx) => mutateTx(tx, prepared));
    } catch (error) {
      const retryable = error instanceof SerializableConflictError || isUniqueConstraintError(error);
      if (!retryable || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }
  throw new Error('Numero massimo di tentativi Admin Control Plane non valido.');
}

async function requireCurrentPermission(
  tx: Tx,
  actorUserId: string,
  permission: 'ai.orchestrator.read' | 'ai.orchestrator.audit',
) {
  const actorContext = await loadActor(tx, actorUserIdSchema.parse(actorUserId));
  if (!actorContext) return null;
  const decision = evaluatePermission({
    role: actorContext.actor.role,
    active: actorContext.actor.active,
    permissionOverrides: actorContext.permissionOverrides,
  }, permission);
  return decision.allowed ? { ...actorContext, decision } : null;
}

export interface AiOrchestratorAdminEffectiveState {
  readonly operational: false;
  readonly databaseEligible: false;
  readonly workerEnabled: false;
  readonly dispatchEnabled: false;
  readonly humanApprovalBypassAllowed: false;
  readonly physicalDispatchBarrierPresent: boolean;
  readonly environmentWorkerGateOpen: boolean;
  readonly stateMachineGateOpen: boolean;
  readonly databaseDispatchGateOpen: boolean;
  readonly providerIsMock: boolean;
  readonly syntheticDataOnly: boolean;
  readonly externalProvidersDisabled: boolean;
  readonly enabledCapabilityCount: number;
  readonly blockReasons: readonly string[];
}

export type AiOrchestratorAdminSnapshotResult =
  | {
    readonly ok: true;
    readonly desired: {
      readonly global: AiOrchestratorAdminDesiredPolicySnapshot;
      readonly scopes: readonly AiOrchestratorAdminDesiredPolicySnapshot[];
    };
    readonly effective: AiOrchestratorAdminEffectiveState;
  }
  | { readonly ok: false; readonly code: 'ACTOR_NOT_AUTHORIZED' | 'LEDGER_INTEGRITY_ERROR'; readonly message: string };

export async function getAiOrchestratorAdminControlSnapshot(
  prisma: PrismaClient,
  input: { actorUserId: string; env?: NodeJS.ProcessEnv },
): Promise<AiOrchestratorAdminSnapshotResult> {
  return withSerializableTransaction(prisma, async (tx) => {
    const actorContext = await requireCurrentPermission(tx, input.actorUserId, 'ai.orchestrator.read');
    if (!actorContext) return { ok: false, code: 'ACTOR_NOT_AUTHORIZED', message: 'Permesso di lettura AI Orchestrator richiesto.' };

    const latestRows = await tx.$queryRaw<AiOrchestratorAdminPersistedRevisionRowV1[]>(Prisma.sql`
      SELECT DISTINCT ON ("scopeType", "scopeCode") *
      FROM "AiOrchestratorAdminPolicyRevision"
      ORDER BY "scopeType", "scopeCode", "version" DESC
    `);
    let revisions: AiOrchestratorAdminRevisionSnapshot[];
    try {
      revisions = latestRows.map(assertAiOrchestratorAdminPersistedRevisionV1);
    } catch {
      return { ok: false, code: 'LEDGER_INTEGRITY_ERROR', message: 'Integrità del ledger Admin Control Plane non valida.' };
    }
    if (
      revisions.length !== AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.length
      || revisions.some((revision) => !getAiOrchestratorAdminControlTarget(revision.scopeType, revision.scopeCode))
    ) return { ok: false, code: 'LEDGER_INTEGRITY_ERROR', message: 'Catalogo policy Admin Control Plane incompleto.' };

    const global = revisions.find((revision) => revision.scopeType === 'GLOBAL');
    if (!global || global.policy.policyCode !== AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE) {
      return { ok: false, code: 'LEDGER_INTEGRITY_ERROR', message: 'Policy globale Admin Control Plane non disponibile.' };
    }

    const operational = await tx.$queryRaw<Array<{
      stateMachineEnabled: boolean;
      dispatchEnabled: boolean;
      syntheticDataOnly: boolean;
      provider: string;
      externalProvidersEnabled: boolean;
      enabledCapabilityCount: number;
      physicalDispatchBarrierCount: number;
    }>>(Prisma.sql`
      SELECT orchestrator."stateMachineEnabled",
        orchestrator."dispatchEnabled",
        orchestrator."syntheticDataOnly",
        orchestrator."provider",
        control."externalProvidersEnabled",
        (SELECT COUNT(*)::INTEGER FROM "AiOrchestratorWorkerCapabilitySetting" WHERE "enabled" = true) AS "enabledCapabilityCount",
        (
          SELECT COUNT(*)::INTEGER
          FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = '"AiOrchestratorSetting"'::REGCLASS
            AND constraint_row.conname = 'AiOrchestratorSetting_dispatch_disabled_check'
            AND constraint_row.convalidated = true
            AND pg_get_constraintdef(constraint_row.oid) = 'CHECK (("dispatchEnabled" = false))'
        ) AS "physicalDispatchBarrierCount"
      FROM "AiOrchestratorSetting" orchestrator
      CROSS JOIN "AiControlSetting" control
      WHERE orchestrator."id" = 'global' AND control."id" = 'global'
    `);
    const gates = operational[0];
    if (!gates) return { ok: false, code: 'LEDGER_INTEGRITY_ERROR', message: 'Gate operativi globali mancanti.' };
    const env = input.env ?? process.env;
    const blockReasons = ['FOUNDATION_LOCKED_V1', 'HUMAN_APPROVAL_BARRIER'];
    if (env.AI_ORCHESTRATOR_WORKER_ENABLED !== '1') blockReasons.push('ENVIRONMENT_WORKER_GATE_CLOSED');
    if (!gates.stateMachineEnabled) blockReasons.push('DATABASE_STATE_MACHINE_GATE_CLOSED');
    if (!gates.dispatchEnabled) blockReasons.push('DATABASE_DISPATCH_GATE_CLOSED');
    if (gates.physicalDispatchBarrierCount === 1) blockReasons.push('PHYSICAL_DISPATCH_BARRIER');
    if (gates.provider !== 'mock' || (env.AI_PROVIDER ?? 'mock') !== 'mock') blockReasons.push('NON_MOCK_PROVIDER');
    if (!gates.syntheticDataOnly) blockReasons.push('NON_SYNTHETIC_DATA_MODE');
    if (gates.externalProvidersEnabled || (env.AI_EXTERNAL_PROVIDERS_ENABLED ?? 'false') !== 'false') blockReasons.push('EXTERNAL_PROVIDERS_NOT_DISABLED');
    if ((env.AI_ALLOWED_MODELS ?? '').trim() !== '') blockReasons.push('MODEL_ALLOWLIST_NOT_EMPTY');
    if (gates.enabledCapabilityCount !== 0) blockReasons.push('CAPABILITY_GATE_OPEN');
    const globalPolicy = global.policy as AiOrchestratorAdminGlobalPolicy;
    if (globalPolicy.emergencyStopEngaged) blockReasons.push('ADMIN_EMERGENCY_STOP');
    if (globalPolicy.globalKillSwitch) blockReasons.push('ADMIN_GLOBAL_KILL_SWITCH');

    return {
      ok: true,
      desired: {
        global: projectDesiredPolicySnapshot(global),
        scopes: Object.freeze(revisions
          .filter((revision) => revision.scopeType !== 'GLOBAL')
          .map(projectDesiredPolicySnapshot)),
      },
      effective: Object.freeze({
        operational: false,
        databaseEligible: false,
        workerEnabled: false,
        dispatchEnabled: false,
        humanApprovalBypassAllowed: false,
        physicalDispatchBarrierPresent: gates.physicalDispatchBarrierCount === 1,
        environmentWorkerGateOpen: env.AI_ORCHESTRATOR_WORKER_ENABLED === '1',
        stateMachineGateOpen: gates.stateMachineEnabled,
        databaseDispatchGateOpen: gates.dispatchEnabled,
        providerIsMock: gates.provider === 'mock' && (env.AI_PROVIDER ?? 'mock') === 'mock',
        syntheticDataOnly: gates.syntheticDataOnly,
        externalProvidersDisabled: !gates.externalProvidersEnabled && (env.AI_EXTERNAL_PROVIDERS_ENABLED ?? 'false') === 'false',
        enabledCapabilityCount: gates.enabledCapabilityCount,
        blockReasons: Object.freeze(blockReasons),
      }),
    };
  });
}

export type AiOrchestratorAdminRevisionListResult =
  | {
    readonly ok: true;
    readonly revisions: readonly AiOrchestratorAdminRevisionSnapshot[];
    readonly nextCursor: string | null;
  }
  | {
    readonly ok: false;
    readonly code: 'ACTOR_NOT_AUTHORIZED' | 'INVALID_CURSOR' | 'INVALID_FILTER' | 'LEDGER_INTEGRITY_ERROR';
    readonly message: string;
  };

export async function listAiOrchestratorAdminPolicyRevisions(
  prisma: PrismaClient,
  input: { actorUserId: string; scopeType?: string; scopeCode?: string; cursor?: string; limit?: number },
): Promise<AiOrchestratorAdminRevisionListResult> {
  const parsedFilter = z.object({
    actorUserId: actorUserIdSchema,
    scopeType: AiOrchestratorAdminScopeTypeSchema.optional(),
    scopeCode: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(),
    cursor: z.string().min(1).max(2_048).optional(),
    limit: z.number().int().min(1).max(MAX_REVISION_PAGE_SIZE).default(DEFAULT_REVISION_PAGE_SIZE),
  }).strict().superRefine((filter, context) => {
    if (filter.scopeCode && !filter.scopeType) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeType'],
        message: 'Lo scope type è obbligatorio quando è presente lo scope code.',
      });
    }
    if (
      filter.scopeType
      && filter.scopeCode
      && !getAiOrchestratorAdminControlTarget(filter.scopeType, filter.scopeCode)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeCode'],
        message: 'Target storico non canonico.',
      });
    }
  }).safeParse(input);
  if (!parsedFilter.success) {
    return { ok: false, code: 'INVALID_FILTER', message: 'Filtro storico AI Orchestrator non valido.' };
  }
  const filter = parsedFilter.data;
  let cursor: AiOrchestratorAdminRevisionCursor | null = null;
  if (filter.cursor) {
    try {
      cursor = decodeAiOrchestratorAdminRevisionCursor(filter.cursor);
      if (
        cursor.scopeType !== (filter.scopeType ?? null)
        || cursor.scopeCode !== (filter.scopeCode ?? null)
      ) throw new TypeError('AI_ORCHESTRATOR_ADMIN_CURSOR_FILTER_MISMATCH');
    } catch {
      return { ok: false, code: 'INVALID_CURSOR', message: 'Cursore storico AI Orchestrator non valido.' };
    }
  }
  return withSerializableTransaction(prisma, async (tx) => {
    const actorContext = await requireCurrentPermission(tx, filter.actorUserId, 'ai.orchestrator.audit');
    if (!actorContext) return { ok: false, code: 'ACTOR_NOT_AUTHORIZED', message: 'Permesso audit AI Orchestrator richiesto.' };
    const cursorPredicate = cursor
      ? Prisma.sql`AND ("createdAt", "id") < (
        (${cursor.createdAt}::TIMESTAMPTZ AT TIME ZONE 'UTC'),
        ${cursor.id}
      )`
      : Prisma.sql``;
    const rows = await tx.$queryRaw<AiOrchestratorAdminPersistedRevisionRowV1[]>(Prisma.sql`
      SELECT *
      FROM "AiOrchestratorAdminPolicyRevision"
      WHERE (${filter.scopeType ?? null}::TEXT IS NULL OR "scopeType" = ${filter.scopeType ?? null})
        AND (${filter.scopeCode ?? null}::TEXT IS NULL OR "scopeCode" = ${filter.scopeCode ?? null})
        ${cursorPredicate}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${filter.limit + 1}
    `);
    try {
      const validatedRows = rows.map(assertAiOrchestratorAdminPersistedRevisionV1);
      const hasMore = rows.length > filter.limit;
      const revisions = Object.freeze(validatedRows.slice(0, filter.limit));
      const last = revisions.at(-1);
      return {
        ok: true,
        revisions,
        nextCursor: hasMore && last
          ? encodeAiOrchestratorAdminRevisionCursor({
            createdAt: last.createdAt,
            id: last.id,
            scopeType: filter.scopeType ?? null,
            scopeCode: filter.scopeCode ?? null,
          })
          : null,
      };
    } catch {
      return { ok: false, code: 'LEDGER_INTEGRITY_ERROR', message: 'Integrità del ledger Admin Control Plane non valida.' };
    }
  });
}

// Compile-time proof that the persisted scope-policy discriminator cannot be
// mistaken for the global policy discriminator by future adapters.
const _policyDiscriminatorProof: [
  typeof AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE,
  typeof AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY_CODE,
] = [AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE, AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY_CODE];
void _policyDiscriminatorProof;
void AiOrchestratorAdminNonGlobalScopeTypeSchema;
