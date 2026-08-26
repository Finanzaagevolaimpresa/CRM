import { randomUUID } from 'node:crypto';
import { Prisma, type ClientType, type PrismaClient } from '@prisma/client';
import {
  CommercialLeadInboxError,
  commercialLeadInboxMode,
  isCommercialLeadReasonCode,
  type CommercialLeadActivityType,
  type CommercialLeadOriginKind,
  type CommercialLeadReasonCode,
} from './commercial-lead-inbox-contract';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { LEAD_EVENT_SCHEMA_VERSION } from './lead-event-contract';
import { hasPermission } from './permission-evaluator';
import { internalSessionMode } from './session';

export const COMMERCIAL_LEAD_INBOX_TRANSACTION = Object.freeze({
  attempts: 3,
  maxWaitMs: 2_000,
  timeoutMs: 5_000,
  lockTimeoutMs: 1_000,
  statementTimeoutMs: 4_000,
} as const);

export type CommercialLeadActor = Readonly<{
  userId: string;
  sessionId: string;
}>;

export type CommercialLeadFaultPoint =
  | 'AFTER_ITEM'
  | 'AFTER_CLIENT'
  | 'AFTER_LEAD'
  | 'AFTER_CYCLE'
  | 'AFTER_ACTIVITY'
  | 'AFTER_AUDIT';

export type CommercialLeadAttribution = Readonly<{
  originKind: CommercialLeadOriginKind;
  projectionLedgerId?: string;
  privacyEvidenceReceiptId?: string;
}>;

type LockedLead = Readonly<{
  id: string;
  firstName: string;
  lastName: string;
  companyName: string | null;
  notes: string | null;
  clientId: string | null;
  assignedToId: string | null;
  status: string;
  source: string | null;
  leadSource: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}>;

type LockedItem = Readonly<{
  id: string;
  leadId: string;
  state: string;
  version: number;
  closedAt: Date | null;
}>;

type LockedCycle = Readonly<{
  id: string;
  sequence: number;
  version: number;
  dueAt: Date;
  firstResponseAt: Date | null;
  closedAt: Date | null;
  outcome: string | null;
}>;

const retryableSqlStates = new Set(['40001', '40P01', '55P03']);

function fail(code: ConstructorParameters<typeof CommercialLeadInboxError>[0]): never {
  throw new CommercialLeadInboxError(code);
}

function retryable(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return (typeof candidate.code === 'string' && retryableSqlStates.has(candidate.code))
    || (typeof candidate.meta?.code === 'string' && retryableSqlStates.has(candidate.meta.code));
}

async function transaction<T>(
  db: PrismaClient,
  operation: (tx: Prisma.TransactionClient, commandNow: Date) => Promise<T>,
) {
  for (let attempt = 1; attempt <= COMMERCIAL_LEAD_INBOX_TRANSACTION.attempts; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${COMMERCIAL_LEAD_INBOX_TRANSACTION.lockTimeoutMs}ms'`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${COMMERCIAL_LEAD_INBOX_TRANSACTION.statementTimeoutMs}ms'`);
        const clockRows = await tx.$queryRaw<Array<{ now: Date }>>`
          SELECT clock_timestamp()::timestamptz(3) AS now
        `;
        const commandNow = clockRows[0]?.now ?? fail('N14_VERSION_CONFLICT');
        return operation(tx, commandNow);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: COMMERCIAL_LEAD_INBOX_TRANSACTION.maxWaitMs,
        timeout: COMMERCIAL_LEAD_INBOX_TRANSACTION.timeoutMs,
      });
    } catch (error) {
      if (!retryable(error)) throw error;
      if (attempt === COMMERCIAL_LEAD_INBOX_TRANSACTION.attempts) fail('N14_VERSION_CONFLICT');
    }
  }
  return fail('N14_VERSION_CONFLICT');
}

function requireEnforcedMode() {
  if (commercialLeadInboxMode() !== 'enforced') fail('N14_DISABLED');
}

async function authorizeActor(
  tx: Prisma.TransactionClient,
  actor: CommercialLeadActor,
  requirement: 'CLAIM' | 'WORK' | 'MANAGE',
) {
  if (!actor.userId || !/^[0-9a-f-]{36}$/u.test(actor.sessionId)) {
    fail('N14_SESSION_REVALIDATION_FAILED');
  }
  let registry = false;
  try { registry = internalSessionMode() === 'registry'; } catch { /* fail closed */ }
  if (!registry) fail('N14_SESSION_REVALIDATION_FAILED');
  const session = await lockAuthoritativeInternalSession(tx, {
    sessionId: actor.sessionId,
    userId: actor.userId,
  });
  const permission = requirement === 'MANAGE'
    ? 'lead.inbox.assign'
    : requirement === 'CLAIM' ? 'lead.inbox.claim' : 'lead.write';
  if (!session || session.revokedAt || !session.live || !session.active || session.deletedAt
    || !hasPermission({
      role: session.role,
      active: session.active,
      permissionOverrides: session.permissionOverrides,
    }, permission)) {
    fail('N14_PERMISSION_DENIED');
  }
  return session;
}

async function lockLead(tx: Prisma.TransactionClient, leadId: string) {
  const rows = await tx.$queryRaw<LockedLead[]>(Prisma.sql`
    SELECT "id", "firstName", "lastName", "companyName", "notes", "clientId",
      "assignedToId", "status"::text AS "status", "source",
      "leadSource"::text AS "leadSource", "createdAt", "updatedAt", "deletedAt"
    FROM "Lead" WHERE "id" = ${leadId} FOR UPDATE
  `);
  const lead = rows[0];
  if (!lead || lead.deletedAt) fail('N14_LEAD_NOT_FOUND');
  return lead;
}

async function lockItem(tx: Prisma.TransactionClient, leadId: string) {
  const rows = await tx.$queryRaw<LockedItem[]>(Prisma.sql`
    SELECT "id", "leadId", "state", "version", "closedAt"
    FROM "CommercialLeadInboxItem" WHERE "leadId" = ${leadId} FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function lockOpenCycle(tx: Prisma.TransactionClient, itemId: string) {
  const rows = await tx.$queryRaw<LockedCycle[]>(Prisma.sql`
    SELECT "id", "sequence", "version", "dueAt", "firstResponseAt", "closedAt", "outcome"
    FROM "CommercialLeadSlaCycle"
    WHERE "inboxItemId" = ${itemId}::uuid AND "closedAt" IS NULL
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function optionalActivePolicyAndClock(tx: Prisma.TransactionClient, commandNow?: Date) {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    now: Date;
    dueAt: Date;
  }>>(Prisma.sql`
    WITH active_policy AS (
      SELECT "id", "responseTargetSeconds"
      FROM "CommercialLeadSlaPolicyVersion"
      WHERE "policyCode" = 'COMMERCIAL_FIRST_RESPONSE' AND "status" = 'ACTIVE'
      FOR SHARE
    ), database_clock AS (
      SELECT COALESCE(${commandNow ?? null}::timestamptz, clock_timestamp())::timestamptz(3) AS now
    )
    SELECT active_policy."id", database_clock.now,
      (database_clock.now + make_interval(secs => active_policy."responseTargetSeconds"))::timestamptz(3) AS "dueAt"
    FROM active_policy CROSS JOIN database_clock
  `);
  return rows[0] ?? null;
}

async function activePolicyAndClock(tx: Prisma.TransactionClient, commandNow?: Date) {
  return await optionalActivePolicyAndClock(tx, commandNow) ?? fail('N14_ACTIVE_POLICY_UNAVAILABLE');
}

async function databaseClock(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp()::timestamptz(3) AS now
  `;
  return rows[0]?.now ?? fail('N14_VERSION_CONFLICT');
}

async function verifiedAttribution(
  tx: Prisma.TransactionClient,
  lead: LockedLead,
  attribution: CommercialLeadAttribution,
  commandNow?: Date,
) {
  if (attribution.originKind === 'MANUAL_CRM') {
    if (attribution.projectionLedgerId || attribution.privacyEvidenceReceiptId) fail('N14_ATTRIBUTION_INVALID');
    return {
      sourceSystem: 'CRM', formCode: 'LEAD_CREATE_UI', formVersion: 'n14-v1',
      sourceOccurredAt: commandNow ?? await databaseClock(tx), projectionLedgerId: null, privacyEvidenceReceiptId: null,
    };
  }
  if (attribution.originKind === 'LEGACY_UNVERIFIED') {
    if (attribution.projectionLedgerId || attribution.privacyEvidenceReceiptId) fail('N14_ATTRIBUTION_INVALID');
    return {
      sourceSystem: 'LEGACY', formCode: 'UNVERIFIED', formVersion: 'n14-v1',
      sourceOccurredAt: lead.createdAt, projectionLedgerId: null, privacyEvidenceReceiptId: null,
    };
  }
  if (attribution.originKind === 'BUSINESS_PROJECTION_N13') {
    if (!attribution.projectionLedgerId || attribution.privacyEvidenceReceiptId) fail('N14_ATTRIBUTION_INVALID');
    const rows = await tx.$queryRaw<Array<{
      id: string; sourceSystem: string; formCode: string; formVersion: string; sourceOccurredAt: Date;
    }>>(Prisma.sql`
      SELECT ledger."id",
        inbox."envelopeJson"::jsonb #>> '{source,systemCode}' AS "sourceSystem",
        inbox."envelopeJson"::jsonb #>> '{source,formCode}' AS "formCode",
        inbox."envelopeJson"::jsonb #>> '{source,formVersion}' AS "formVersion",
        inbox."occurredAt"::timestamptz AS "sourceOccurredAt"
      FROM "LeadProjectionLedger" ledger
      JOIN "BusinessInboxEvent" inbox ON inbox."id" = ledger."inboxEventId"
      WHERE ledger."id" = ${attribution.projectionLedgerId}::uuid
        AND ledger."leadId" = ${lead.id} AND ledger."state" IN ('PROJECTED_NEW', 'RESOLVED_NEW')
        AND inbox."schemaVersion" = ${LEAD_EVENT_SCHEMA_VERSION}
      FOR SHARE OF ledger, inbox
    `);
    const row = rows[0];
    if (!row?.sourceSystem || !row.formCode || !row.formVersion) fail('N14_ATTRIBUTION_INVALID');
    return { ...row, projectionLedgerId: row.id, privacyEvidenceReceiptId: null };
  }
  if (!attribution.privacyEvidenceReceiptId || attribution.projectionLedgerId) fail('N14_ATTRIBUTION_INVALID');
  const rows = await tx.$queryRaw<Array<{
    id: string; sourceSystem: string; formCode: string; formVersion: string; sourceOccurredAt: Date;
  }>>(Prisma.sql`
    SELECT "id", "sourceSystem", "formCode", "formVersion", "sourceSubmittedAt" AS "sourceOccurredAt"
    FROM "PrivacyEvidenceReceipt"
    WHERE "id" = ${attribution.privacyEvidenceReceiptId}::uuid
      AND "leadId" = ${lead.id} AND "websiteLeadReceiptId" IS NOT NULL
      AND "purposeCode" = 'SERVICE_REQUEST_FOLLOW_UP'
    FOR SHARE
  `);
  const row = rows[0];
  if (!row) fail('N14_ATTRIBUTION_INVALID');
  return { ...row, projectionLedgerId: null, privacyEvidenceReceiptId: row.id };
}

function inject(point: CommercialLeadFaultPoint | undefined, expected: CommercialLeadFaultPoint) {
  if (point === expected) throw new Error(`N14_SYNTHETIC_FAULT_${expected}`);
}

async function appendActivity(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    itemId: string;
    activityType: CommercialLeadActivityType;
    actor: CommercialLeadActor;
    reasonCode: CommercialLeadReasonCode;
    assigneeBeforeId: string | null;
    assigneeAfterId: string | null;
    versionBefore: number;
    versionAfter: number;
  }>,
) {
  const sequenceRows = await tx.$queryRaw<Array<{ sequence: number }>>(Prisma.sql`
    SELECT COALESCE(MAX("sequence"), 0)::integer + 1 AS sequence
    FROM "CommercialLeadActivity" WHERE "inboxItemId" = ${input.itemId}::uuid
  `);
  return tx.commercialLeadActivity.create({ data: {
    id: randomUUID(),
    inboxItemId: input.itemId,
    sequence: sequenceRows[0]?.sequence ?? 1,
    activityType: input.activityType,
    actorKind: 'USER',
    actorUserId: input.actor.userId,
    actorSessionId: input.actor.sessionId,
    assigneeBeforeId: input.assigneeBeforeId,
    assigneeAfterId: input.assigneeAfterId,
    reasonCode: input.reasonCode,
    inboxVersionBefore: input.versionBefore,
    inboxVersionAfter: input.versionAfter,
  } });
}

async function appendAudit(
  tx: Prisma.TransactionClient,
  actor: CommercialLeadActor,
  event: string,
  itemId: string,
  after: Prisma.InputJsonObject,
) {
  await tx.auditLog.create({ data: {
    actorId: actor.userId,
    event,
    entityType: 'CommercialLeadInboxItem',
    entityId: itemId,
    after,
  } });
}

export async function initializeCommercialLeadInboxItem(
  db: PrismaClient,
  input: Readonly<{
    leadId: string;
    actor: CommercialLeadActor;
    attribution: CommercialLeadAttribution;
    reasonCode: 'MANUAL_INTAKE' | 'PROJECTED_NEW' | 'LEGACY_ENROLLMENT';
    faultAt?: CommercialLeadFaultPoint;
  }>,
) {
  requireEnforcedMode();
  if (!isCommercialLeadReasonCode(input.reasonCode)) fail('N14_REASON_INVALID');
  const requirement = input.attribution.originKind === 'LEGACY_UNVERIFIED' ? 'MANAGE' : 'WORK';
  return transaction(db, async (tx, commandNow) => {
    await authorizeActor(tx, input.actor, requirement);
    const lead = await lockLead(tx, input.leadId);
    if (await lockItem(tx, input.leadId)) fail('N14_ITEM_ALREADY_EXISTS');
    const policy = await activePolicyAndClock(tx, commandNow);
    const attribution = await verifiedAttribution(tx, lead, input.attribution, commandNow);
    const item = await tx.commercialLeadInboxItem.create({ data: {
      id: randomUUID(), leadId: lead.id, originKind: input.attribution.originKind,
      attributionVersion: 'n14-v1', sourceSystem: attribution.sourceSystem,
      formCode: attribution.formCode, formVersion: attribution.formVersion,
      sourceOccurredAt: attribution.sourceOccurredAt,
      projectionLedgerId: attribution.projectionLedgerId,
      privacyEvidenceReceiptId: attribution.privacyEvidenceReceiptId,
      state: 'OPEN', version: 1, initializedAt: policy.now,
    } });
    inject(input.faultAt, 'AFTER_ITEM');
    await tx.commercialLeadSlaCycle.create({ data: {
      id: randomUUID(), inboxItemId: item.id, sequence: 1, policyVersionId: policy.id,
      availableAt: policy.now, dueAt: policy.dueAt, version: 1,
    } });
    inject(input.faultAt, 'AFTER_CYCLE');
    await appendActivity(tx, {
      itemId: item.id, activityType: 'INITIALIZED', actor: input.actor,
      reasonCode: input.reasonCode, assigneeBeforeId: lead.assignedToId,
      assigneeAfterId: lead.assignedToId, versionBefore: 0, versionAfter: 1,
    });
    inject(input.faultAt, 'AFTER_ACTIVITY');
    await appendAudit(tx, input.actor, 'commercial_lead_inbox_initialized', item.id, {
      originKind: input.attribution.originKind, state: 'OPEN', version: 1,
      reasonCode: input.reasonCode,
    });
    inject(input.faultAt, 'AFTER_AUDIT');
    return item;
  });
}

export async function maybeEnrollProjectedCommercialLead(
  tx: Prisma.TransactionClient,
  input: Readonly<{ leadId: string; projectionLedgerId: string }>,
) {
  if (commercialLeadInboxMode() !== 'enforced') return null;
  const lead = await lockLead(tx, input.leadId);
  if (await lockItem(tx, input.leadId)) return null;
  const policy = await optionalActivePolicyAndClock(tx);
  if (!policy) return null;
  const attribution = await verifiedAttribution(tx, lead, {
    originKind: 'BUSINESS_PROJECTION_N13',
    projectionLedgerId: input.projectionLedgerId,
  }, policy.now);
  const item = await tx.commercialLeadInboxItem.create({ data: {
    id: randomUUID(), leadId: lead.id, originKind: 'BUSINESS_PROJECTION_N13',
    attributionVersion: 'n14-v1', sourceSystem: attribution.sourceSystem,
    formCode: attribution.formCode, formVersion: attribution.formVersion,
    sourceOccurredAt: attribution.sourceOccurredAt, projectionLedgerId: attribution.projectionLedgerId,
    privacyEvidenceReceiptId: null, state: 'OPEN', version: 1, initializedAt: policy.now,
  } });
  await tx.commercialLeadSlaCycle.create({ data: {
    id: randomUUID(), inboxItemId: item.id, sequence: 1, policyVersionId: policy.id,
    availableAt: policy.now, dueAt: policy.dueAt, version: 1,
  } });
  await tx.commercialLeadActivity.create({ data: {
    id: randomUUID(), inboxItemId: item.id, sequence: 1, activityType: 'INITIALIZED',
    actorKind: 'SYSTEM', actorUserId: null, actorSessionId: null,
    assigneeBeforeId: lead.assignedToId, assigneeAfterId: lead.assignedToId,
    reasonCode: 'PROJECTED_NEW', inboxVersionBefore: 0, inboxVersionAfter: 1,
  } });
  await tx.auditLog.create({ data: {
    actorId: null, event: 'commercial_lead_inbox_initialized',
    entityType: 'CommercialLeadInboxItem', entityId: item.id,
    after: { originKind: 'BUSINESS_PROJECTION_N13', state: 'OPEN', version: 1, reasonCode: 'PROJECTED_NEW' },
  } });
  return item;
}

export async function maybeEnrollManualCommercialLead(
  tx: Prisma.TransactionClient,
  input: Readonly<{ leadId: string; actor: CommercialLeadActor }>,
) {
  if (commercialLeadInboxMode() !== 'enforced') return null;
  await authorizeActor(tx, input.actor, 'WORK');
  const lead = await lockLead(tx, input.leadId);
  if (await lockItem(tx, input.leadId)) return null;
  const policy = await optionalActivePolicyAndClock(tx);
  if (!policy) return null;
  const item = await tx.commercialLeadInboxItem.create({ data: {
    id: randomUUID(), leadId: lead.id, originKind: 'MANUAL_CRM',
    attributionVersion: 'n14-v1', sourceSystem: 'CRM', formCode: 'LEAD_CREATE_UI',
    formVersion: 'n14-v1', sourceOccurredAt: policy.now, projectionLedgerId: null,
    privacyEvidenceReceiptId: null, state: 'OPEN', version: 1, initializedAt: policy.now,
  } });
  await tx.commercialLeadSlaCycle.create({ data: {
    id: randomUUID(), inboxItemId: item.id, sequence: 1, policyVersionId: policy.id,
    availableAt: policy.now, dueAt: policy.dueAt, version: 1,
  } });
  await appendActivity(tx, {
    itemId: item.id, activityType: 'INITIALIZED', actor: input.actor,
    reasonCode: 'MANUAL_INTAKE', assigneeBeforeId: lead.assignedToId,
    assigneeAfterId: lead.assignedToId, versionBefore: 0, versionAfter: 1,
  });
  await appendAudit(tx, input.actor, 'commercial_lead_inbox_initialized', item.id, {
    originKind: 'MANUAL_CRM', state: 'OPEN', version: 1, reasonCode: 'MANUAL_INTAKE',
  });
  return item;
}

async function mutateOwner(
  db: PrismaClient,
  input: Readonly<{
    leadId: string;
    actor: CommercialLeadActor;
    targetUserId: string | null;
    expectedInboxVersion: number;
    activityType: 'CLAIMED' | 'ASSIGNED' | 'UNASSIGNED';
    reasonCode: 'SELF_CLAIM' | 'MANAGER_ASSIGNMENT' | 'MANAGER_UNASSIGNMENT';
    requirement: 'CLAIM' | 'WORK' | 'MANAGE';
    faultAt?: CommercialLeadFaultPoint;
  }>,
) {
  requireEnforcedMode();
  return transaction(db, async (tx, commandNow) => {
    await authorizeActor(tx, input.actor, input.requirement);
    const lead = await lockLead(tx, input.leadId);
    const item = await lockItem(tx, input.leadId);
    if (!item) fail('N14_ITEM_NOT_FOUND');
    if (item.state !== 'OPEN') fail('N14_ITEM_NOT_OPEN');
    if (item.version !== input.expectedInboxVersion) fail('N14_VERSION_CONFLICT');
    if (input.activityType === 'CLAIMED' && (lead.assignedToId || input.targetUserId !== input.actor.userId)) {
      fail('N14_VERSION_CONFLICT');
    }
    if (input.targetUserId) {
      const target = await tx.$queryRaw<Array<{ id: string; role: string }>>(Prisma.sql`
        SELECT "id", "role" FROM "User" WHERE "id" = ${input.targetUserId}
          AND "active" = TRUE AND "deletedAt" IS NULL FOR SHARE
      `);
      if (!target[0] || target[0].role !== 'commerciale') {
        fail('N14_TARGET_USER_INVALID');
      }
    }
    await tx.$queryRaw`SELECT set_config('fai.n14_write_context', 'authorized', true)`;
    await tx.lead.update({ where: { id: lead.id }, data: { assignedToId: input.targetUserId } });
    inject(input.faultAt, 'AFTER_LEAD');
    const updated = await tx.commercialLeadInboxItem.update({
      where: { id: item.id }, data: { version: item.version + 1, updatedAt: commandNow },
    });
    inject(input.faultAt, 'AFTER_ITEM');
    await appendActivity(tx, {
      itemId: item.id, activityType: input.activityType, actor: input.actor,
      reasonCode: input.reasonCode, assigneeBeforeId: lead.assignedToId,
      assigneeAfterId: input.targetUserId, versionBefore: item.version,
      versionAfter: updated.version,
    });
    inject(input.faultAt, 'AFTER_ACTIVITY');
    await appendAudit(tx, input.actor, `commercial_lead_inbox_${input.activityType.toLowerCase()}`, item.id, {
      state: item.state, version: updated.version, reasonCode: input.reasonCode,
    });
    inject(input.faultAt, 'AFTER_AUDIT');
    return updated;
  });
}

export function claimCommercialLeadInboxItem(db: PrismaClient, input: Readonly<{
  leadId: string; actor: CommercialLeadActor; expectedInboxVersion: number; faultAt?: CommercialLeadFaultPoint;
}>) {
  return mutateOwner(db, { ...input, targetUserId: input.actor.userId, activityType: 'CLAIMED', reasonCode: 'SELF_CLAIM', requirement: 'CLAIM' });
}

export function assignCommercialLeadInboxItem(db: PrismaClient, input: Readonly<{
  leadId: string; actor: CommercialLeadActor; targetUserId: string; expectedInboxVersion: number; faultAt?: CommercialLeadFaultPoint;
}>) {
  return mutateOwner(db, { ...input, activityType: 'ASSIGNED', reasonCode: 'MANAGER_ASSIGNMENT', requirement: 'MANAGE' });
}

export function unassignCommercialLeadInboxItem(db: PrismaClient, input: Readonly<{
  leadId: string; actor: CommercialLeadActor; expectedInboxVersion: number; faultAt?: CommercialLeadFaultPoint;
}>) {
  return mutateOwner(db, { ...input, targetUserId: null, activityType: 'UNASSIGNED', reasonCode: 'MANAGER_UNASSIGNMENT', requirement: 'MANAGE' });
}

export async function recordCommercialLeadFirstResponse(
  db: PrismaClient,
  input: Readonly<{
    leadId: string; actor: CommercialLeadActor; expectedInboxVersion: number; faultAt?: CommercialLeadFaultPoint;
  }>,
) {
  requireEnforcedMode();
  return transaction(db, async (tx, commandNow) => {
    await authorizeActor(tx, input.actor, 'WORK');
    const lead = await lockLead(tx, input.leadId);
    const item = await lockItem(tx, input.leadId);
    if (!item) fail('N14_ITEM_NOT_FOUND');
    if (item.state !== 'OPEN') fail('N14_ITEM_NOT_OPEN');
    if (item.version !== input.expectedInboxVersion) fail('N14_VERSION_CONFLICT');
    if (lead.assignedToId !== input.actor.userId) fail('N14_PERMISSION_DENIED');
    const cycle = await lockOpenCycle(tx, item.id);
    if (!cycle) fail('N14_VERSION_CONFLICT');
    if (cycle.firstResponseAt) fail('N14_FIRST_RESPONSE_ALREADY_RECORDED');
    const now = commandNow;
    const outcome = now.getTime() <= cycle.dueAt.getTime() ? 'MET' : 'BREACHED';
    await tx.commercialLeadSlaCycle.update({ where: { id: cycle.id }, data: {
      firstResponseAt: now, outcome, version: cycle.version + 1, updatedAt: now,
    } });
    inject(input.faultAt, 'AFTER_CYCLE');
    const updated = await tx.commercialLeadInboxItem.update({ where: { id: item.id }, data: {
      version: item.version + 1, updatedAt: now,
    } });
    inject(input.faultAt, 'AFTER_ITEM');
    await appendActivity(tx, {
      itemId: item.id, activityType: 'FIRST_RESPONSE_RECORDED', actor: input.actor,
      reasonCode: 'CUSTOMER_CONTACTED', assigneeBeforeId: lead.assignedToId,
      assigneeAfterId: lead.assignedToId, versionBefore: item.version, versionAfter: updated.version,
    });
    inject(input.faultAt, 'AFTER_ACTIVITY');
    await appendAudit(tx, input.actor, 'commercial_lead_inbox_first_response_recorded', item.id, {
      state: item.state, version: updated.version, outcome, reasonCode: 'CUSTOMER_CONTACTED',
    });
    inject(input.faultAt, 'AFTER_AUDIT');
    return { item: updated, outcome, firstResponseAt: now } as const;
  });
}

const closeStatusByReason = Object.freeze({
  QUALIFIED_OUT: 'non_qualificato',
  LOST: 'perso',
  ARCHIVED: 'archiviato',
} as const);

export async function closeCommercialLeadInboxItem(
  db: PrismaClient,
  input: Readonly<{
    leadId: string;
    actor: CommercialLeadActor;
    expectedInboxVersion: number;
    reasonCode: keyof typeof closeStatusByReason;
    faultAt?: CommercialLeadFaultPoint;
  }>,
) {
  requireEnforcedMode();
  if (!Object.hasOwn(closeStatusByReason, input.reasonCode)) fail('N14_REASON_INVALID');
  return transaction(db, async (tx, commandNow) => {
    await authorizeActor(tx, input.actor, 'WORK');
    const lead = await lockLead(tx, input.leadId);
    const item = await lockItem(tx, input.leadId);
    if (!item) fail('N14_ITEM_NOT_FOUND');
    if (item.state !== 'OPEN') fail('N14_ITEM_NOT_OPEN');
    if (item.version !== input.expectedInboxVersion) fail('N14_VERSION_CONFLICT');
    if (lead.assignedToId !== input.actor.userId) fail('N14_PERMISSION_DENIED');
    const cycle = await lockOpenCycle(tx, item.id);
    if (!cycle) fail('N14_VERSION_CONFLICT');
    const now = commandNow;
    await tx.$queryRaw`SELECT set_config('fai.n14_write_context', 'authorized', true)`;
    await tx.lead.update({ where: { id: lead.id }, data: { status: closeStatusByReason[input.reasonCode] } });
    inject(input.faultAt, 'AFTER_LEAD');
    await tx.commercialLeadSlaCycle.update({ where: { id: cycle.id }, data: {
      closedAt: now,
      outcome: cycle.firstResponseAt ? cycle.outcome : 'CLOSED_WITHOUT_RESPONSE',
      version: cycle.version + 1, updatedAt: now,
    } });
    inject(input.faultAt, 'AFTER_CYCLE');
    const updated = await tx.commercialLeadInboxItem.update({ where: { id: item.id }, data: {
      state: 'CLOSED', closedAt: now, version: item.version + 1, updatedAt: now,
    } });
    inject(input.faultAt, 'AFTER_ITEM');
    await appendActivity(tx, {
      itemId: item.id, activityType: 'CLOSED', actor: input.actor,
      reasonCode: input.reasonCode, assigneeBeforeId: lead.assignedToId,
      assigneeAfterId: lead.assignedToId, versionBefore: item.version, versionAfter: updated.version,
    });
    inject(input.faultAt, 'AFTER_ACTIVITY');
    await appendAudit(tx, input.actor, 'commercial_lead_inbox_closed', item.id, {
      state: 'CLOSED', version: updated.version, reasonCode: input.reasonCode,
    });
    inject(input.faultAt, 'AFTER_AUDIT');
    return updated;
  });
}

export async function convertCommercialLeadInboxItem(
  db: PrismaClient,
  input: Readonly<{
    leadId: string;
    actor: CommercialLeadActor;
    expectedInboxVersion: number;
    clientType: ClientType;
    faultAt?: CommercialLeadFaultPoint;
  }>,
) {
  requireEnforcedMode();
  return transaction(db, async (tx, commandNow) => {
    await authorizeActor(tx, input.actor, 'WORK');
    const lead = await lockLead(tx, input.leadId);
    const item = await lockItem(tx, input.leadId);
    if (!item) fail('N14_ITEM_NOT_FOUND');
    if (item.state !== 'OPEN') fail('N14_ITEM_NOT_OPEN');
    if (item.version !== input.expectedInboxVersion) fail('N14_VERSION_CONFLICT');
    if (lead.assignedToId !== input.actor.userId) fail('N14_PERMISSION_DENIED');
    if (lead.clientId) fail('N14_VERSION_CONFLICT');
    const cycle = await lockOpenCycle(tx, item.id);
    if (!cycle) fail('N14_VERSION_CONFLICT');
    if (!cycle.firstResponseAt || !cycle.outcome) fail('N14_FIRST_RESPONSE_REQUIRED');

    const displayName = lead.companyName || `${lead.firstName} ${lead.lastName}`.trim();
    const client = await tx.client.create({ data: {
      type: input.clientType,
      displayName,
      leadId: lead.id,
      salesOwnerId: lead.assignedToId,
      notes: lead.notes,
    } });
    inject(input.faultAt, 'AFTER_CLIENT');
    await tx.$queryRaw`SELECT set_config('fai.n14_write_context', 'authorized', true)`;
    await tx.lead.update({ where: { id: lead.id }, data: {
      clientId: client.id,
      status: 'vinto',
      updatedAt: commandNow,
    } });
    inject(input.faultAt, 'AFTER_LEAD');
    await tx.commercialLeadSlaCycle.update({ where: { id: cycle.id }, data: {
      closedAt: commandNow,
      version: cycle.version + 1,
      updatedAt: commandNow,
    } });
    inject(input.faultAt, 'AFTER_CYCLE');
    const updated = await tx.commercialLeadInboxItem.update({ where: { id: item.id }, data: {
      state: 'CLOSED',
      closedAt: commandNow,
      version: item.version + 1,
      updatedAt: commandNow,
    } });
    inject(input.faultAt, 'AFTER_ITEM');
    await appendActivity(tx, {
      itemId: item.id,
      activityType: 'CLOSED',
      actor: input.actor,
      reasonCode: 'CONVERTED',
      assigneeBeforeId: lead.assignedToId,
      assigneeAfterId: lead.assignedToId,
      versionBefore: item.version,
      versionAfter: updated.version,
    });
    inject(input.faultAt, 'AFTER_ACTIVITY');
    await appendAudit(tx, input.actor, 'commercial_lead_inbox_closed', item.id, {
      state: 'CLOSED', version: updated.version, reasonCode: 'CONVERTED',
    });
    await tx.auditLog.create({ data: {
      actorId: input.actor.userId,
      event: 'lead_convert_to_client',
      entityType: 'Lead',
      entityId: lead.id,
      after: { fromStatus: lead.status, toStatus: 'vinto', reasonCode: 'CONVERTED' },
    } });
    inject(input.faultAt, 'AFTER_AUDIT');
    return client;
  });
}

export async function reopenCommercialLeadInboxItem(
  db: PrismaClient,
  input: Readonly<{
    leadId: string; actor: CommercialLeadActor; expectedInboxVersion: number; faultAt?: CommercialLeadFaultPoint;
  }>,
) {
  requireEnforcedMode();
  return transaction(db, async (tx, commandNow) => {
    await authorizeActor(tx, input.actor, 'MANAGE');
    const lead = await lockLead(tx, input.leadId);
    const item = await lockItem(tx, input.leadId);
    if (!item) fail('N14_ITEM_NOT_FOUND');
    if (item.state !== 'CLOSED') fail('N14_ITEM_NOT_CLOSED');
    if (item.version !== input.expectedInboxVersion) fail('N14_VERSION_CONFLICT');
    if (lead.clientId) fail('N14_LEAD_ALREADY_CONVERTED');
    const policy = await activePolicyAndClock(tx, commandNow);
    const sequenceRows = await tx.$queryRaw<Array<{ sequence: number }>>(Prisma.sql`
      SELECT COALESCE(MAX("sequence"), 0)::integer + 1 AS sequence
      FROM "CommercialLeadSlaCycle" WHERE "inboxItemId" = ${item.id}::uuid
    `);
    await tx.$queryRaw`SELECT set_config('fai.n14_write_context', 'authorized', true)`;
    await tx.lead.update({ where: { id: lead.id }, data: { status: 'da_contattare' } });
    inject(input.faultAt, 'AFTER_LEAD');
    const updated = await tx.commercialLeadInboxItem.update({ where: { id: item.id }, data: {
      state: 'OPEN', closedAt: null, version: item.version + 1, updatedAt: policy.now,
    } });
    inject(input.faultAt, 'AFTER_ITEM');
    await tx.commercialLeadSlaCycle.create({ data: {
      id: randomUUID(), inboxItemId: item.id, sequence: sequenceRows[0]?.sequence ?? 1,
      policyVersionId: policy.id, availableAt: policy.now, dueAt: policy.dueAt, version: 1,
    } });
    inject(input.faultAt, 'AFTER_CYCLE');
    await appendActivity(tx, {
      itemId: item.id, activityType: 'REOPENED', actor: input.actor,
      reasonCode: 'REOPENED_FOR_REWORK', assigneeBeforeId: lead.assignedToId,
      assigneeAfterId: lead.assignedToId, versionBefore: item.version, versionAfter: updated.version,
    });
    inject(input.faultAt, 'AFTER_ACTIVITY');
    await appendAudit(tx, input.actor, 'commercial_lead_inbox_reopened', item.id, {
      state: 'OPEN', version: updated.version, reasonCode: 'REOPENED_FOR_REWORK',
    });
    inject(input.faultAt, 'AFTER_AUDIT');
    return updated;
  });
}
