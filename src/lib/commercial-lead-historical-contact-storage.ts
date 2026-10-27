import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { historicalContactAudit, historicalContactInput, HistoricalContactError, prepareHistoricalContact,
  prepareHistoricalConversion, type HistoricalContactContext, type HistoricalContactReceipt,
  type HistoricalContactInput } from './commercial-lead-historical-contact-contract';
import { commercialLeadInboxMode } from './commercial-lead-inbox-contract';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { hasPermission } from './permission-evaluator';
import { readResponsibility } from './responsibility';
import { assertNoSelectiveLeadMutation } from './selective-lead-scope';
import { internalSessionMode } from './session';
import { withSerializableTransaction } from './serializable';

// Preparation only. No route/action imports this module. Its draft DDL is only
// for an isolated database; no production schema or activation is implied.
type Tx = Prisma.TransactionClient;
type Actor = Readonly<{ userId: string; sessionId: string }>;
const unavailable = (): never => { throw new HistoricalContactError('STALE_CONTEXT'); };
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const uuid = z.string().uuid();
const stored = z.object({
  id: uuid, input: z.unknown(), actorId: identifier, sessionId: uuid, inboxItemId: uuid, cycleId: uuid,
  assignmentId: identifier, recordedAt: z.date(), inboxVersionBefore: z.number().int().min(1),
  inboxVersionAfter: z.number().int().min(2), payloadHash: z.string().regex(/^[0-9a-f]{64}$/u),
  auditId: identifier, transactionId: z.bigint().positive(),
}).strict();
export type HistoricalContactRecord = Readonly<z.infer<typeof stored> & { input: HistoricalContactInput }>;

/** Decode database rows before using them as evidence. This does not authorize
 * access; callers must first lock and authorize the live scope below. */
export function decodeHistoricalContactRecord(value: unknown): HistoricalContactRecord {
  const parsed = stored.safeParse(value);
  if (!parsed.success) return unavailable();
  const row = parsed.data;
  if (!row.input || typeof row.input !== 'object' || Array.isArray(row.input)) return unavailable();
  const { protocol, ...raw } = row.input as Record<string, unknown>;
  if (protocol !== 'N14_HISTORICAL_CONTACT_V1') return unavailable();
  const input = historicalContactInput(raw);
  if (input.commandId !== row.id || input.expectedAssignmentId !== row.assignmentId
    || input.expectedInboxVersion !== row.inboxVersionBefore
    || row.inboxVersionAfter !== row.inboxVersionBefore + 1) return unavailable();
  return Object.freeze({ ...row, input });
}

function receipt(row: HistoricalContactRecord): HistoricalContactReceipt {
  return { id: row.id, input: row.input, actorId: row.actorId, recordedAt: row.recordedAt.toISOString(),
    inboxItemId: row.inboxItemId, cycleId: row.cycleId, inboxVersionAfter: row.inboxVersionAfter, payloadHash: row.payloadHash };
}

async function authorize(tx: Tx, actor: Actor) {
  if (commercialLeadInboxMode() !== 'enforced' || internalSessionMode() !== 'registry'
    || !uuid.safeParse(actor.sessionId).success || !identifier.safeParse(actor.userId).success) {
    throw new HistoricalContactError('NOT_AUTHORIZED');
  }
  const session = await lockAuthoritativeInternalSession(tx, { userId: actor.userId, sessionId: actor.sessionId });
  if (!session || !session.live || !session.active || session.revokedAt || session.deletedAt
    || session.role !== 'commerciale' || !hasPermission(session, 'lead.read') || !hasPermission(session, 'lead.write')) {
    throw new HistoricalContactError('NOT_AUTHORIZED');
  }
  return session;
}

async function lockContext(tx: Tx, actor: Actor, leadId: string) {
  const session = await authorize(tx, actor);
  await assertNoSelectiveLeadMutation(tx, actor.userId, leadId);
  const leads = await tx.$queryRaw<Array<{ id: string; assignedToId: string | null; clientId: string | null; deletedAt: Date | null }>>`
    SELECT id,"assignedToId","clientId","deletedAt" FROM "Lead" WHERE id=${leadId} FOR UPDATE`;
  const lead = leads[0];
  if (!lead || lead.assignedToId !== actor.userId || lead.deletedAt || lead.clientId) return unavailable();
  const items = await tx.$queryRaw<Array<{ id: string; originKind: string; state: string; version: number; initializedAt: Date }>>`
    SELECT id,"originKind",state,version,"initializedAt" FROM "CommercialLeadInboxItem" WHERE "leadId"=${leadId} FOR UPDATE`;
  const item = items[0];
  if (!item || item.originKind !== 'MANUAL_CRM' || item.state !== 'OPEN') return unavailable();
  const cycles = await tx.$queryRaw<Array<{ id: string; sequence: number; firstResponseAt: Date | null }>>`
    SELECT id,sequence,"firstResponseAt" FROM "CommercialLeadSlaCycle"
    WHERE "inboxItemId"=${item.id}::uuid AND "closedAt" IS NULL FOR UPDATE`;
  if (cycles.length !== 1 || cycles[0].sequence !== 1 || cycles[0].firstResponseAt) return unavailable();
  // All responsibility writers acquire the same Lead row lock. A new decision,
  // including A -> B -> A, cannot reuse the previous personal acceptance.
  const responsibility = await readResponsibility(tx, 'Lead', leadId);
  const decision = responsibility.current;
  const acceptance = responsibility.accepted.find(r => r.acceptance.role === 'commerciale'
    && r.acceptance.userId === actor.userId && r.acceptance.decisionId === decision?.id);
  if (!responsibility.valid || !decision || !acceptance) return unavailable();
  const times = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp()::timestamptz(3) AS now`;
  if (!times[0]) return unavailable();
  const context: HistoricalContactContext = {
    leadId, actorId: actor.userId, actorRole: session.role, sessionLive: true, canWriteLead: true,
    selectiveAccessOnly: false, currentOwnerId: lead.assignedToId, assignmentId: decision.id,
    acceptedAssignmentId: acceptance.acceptance.decisionId, acceptedById: acceptance.acceptance.userId,
    origin: item.originKind, state: item.state, inboxVersion: item.version, deleted: false, converted: false,
    cycleSequence: cycles[0].sequence, firstResponseAt: null, historicalContactExists: false,
    initializedAt: item.initializedAt.toISOString(), recordedAt: times[0].now.toISOString(),
  };
  return { context, item, cycle: cycles[0], canCreateClient: hasPermission(session, 'client.write') };
}

async function loadRecord(tx: Tx, commandId: string) {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT id,input,"actorId","sessionId","inboxItemId","cycleId","assignmentId","recordedAt",
      "inboxVersionBefore","inboxVersionAfter","payloadHash","auditId","transactionId"
    FROM "CommercialLeadHistoricalContact" WHERE id=${commandId}::uuid FOR SHARE`;
  if (rows.length > 1) return unavailable();
  return rows.length ? decodeHistoricalContactRecord(rows[0]) : null;
}

async function verifyJournal(tx: Tx, row: HistoricalContactRecord, scope: Awaited<ReturnType<typeof lockContext>>) {
  if (row.actorId !== scope.context.actorId || row.input.leadId !== scope.context.leadId) return unavailable();
  const context = { ...scope.context, historicalContactExists: true, inboxItemId: scope.item.id,
    cycleId: scope.cycle.id, canCreateClient: true };
  // This verifies a receipt's continuing relevance, not a conversion permission.
  // A future conversion must independently check scope.canCreateClient.
  prepareHistoricalConversion(receipt(row), context);
  const prepared = prepareHistoricalContact(row.input, { ...scope.context, inboxVersion: row.inboxVersionBefore,
    historicalContactExists: false, recordedAt: row.recordedAt.toISOString() });
  const audit = await tx.auditLog.findUnique({ where: { id: row.auditId }, select: {
    actorId: true, entityType: true, entityId: true, event: true, after: true,
  } });
  const expected = historicalContactAudit(row.id, prepared);
  if (!audit || audit.actorId !== row.actorId || audit.entityType !== 'CommercialLeadInboxItem'
    || audit.entityId !== row.inboxItemId || audit.event !== 'commercial_lead_historical_contact_recorded'
    || !audit.after || typeof audit.after !== 'object' || Array.isArray(audit.after)
    || Object.keys(audit.after).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => (audit.after as Record<string, unknown>)[key] !== value)) return unavailable();
  return receipt(row);
}

/** Candidate persistence only. Replays return the same durable receipt after
 * current authorization; a missing receipt is never turned into permission to
 * submit a fresh command. No SLA date/outcome or client is changed here. */
export async function recordHistoricalLeadContact(db: PrismaClient, actor: Actor, requested: unknown) {
  const input = historicalContactInput(requested);
  return withSerializableTransaction(db, async tx => {
    const scope = await lockContext(tx, actor, input.leadId);
    const existing = await loadRecord(tx, input.commandId);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) return unavailable();
      return { state: 'RECORDED' as const, replay: true, receipt: await verifyJournal(tx, existing, scope) };
    }
    const prior = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "CommercialLeadHistoricalContact"
      WHERE "inboxItemId"=${scope.item.id}::uuid AND "assignmentId"=${input.expectedAssignmentId} FOR SHARE`;
    const prepared = prepareHistoricalContact(input, { ...scope.context, historicalContactExists: prior.length > 0 });
    const versions = await tx.$queryRaw<Array<{ version: number }>>`
      UPDATE "CommercialLeadInboxItem" SET version=version+1,"updatedAt"=${new Date(prepared.recordedAt)}
      WHERE id=${scope.item.id}::uuid AND version=${input.expectedInboxVersion} AND state='OPEN' RETURNING version`;
    if (versions.length !== 1 || versions[0].version !== input.expectedInboxVersion + 1) return unavailable();
    const audit = await tx.auditLog.create({ data: { actorId: actor.userId, entityType: 'CommercialLeadInboxItem',
      entityId: scope.item.id, event: 'commercial_lead_historical_contact_recorded',
      after: historicalContactAudit(input.commandId, prepared) } });
    await tx.$executeRaw`
      INSERT INTO "CommercialLeadHistoricalContact"
      (id,input,"actorId","sessionId","inboxItemId","cycleId","assignmentId","recordedAt",
       "inboxVersionBefore","inboxVersionAfter","payloadHash","auditId","transactionId")
      VALUES (${input.commandId}::uuid,${JSON.stringify(input)}::jsonb,${actor.userId},${actor.sessionId}::uuid,
       ${scope.item.id}::uuid,${scope.cycle.id}::uuid,${input.expectedAssignmentId},${new Date(prepared.recordedAt)},
       ${input.expectedInboxVersion},${versions[0].version},${prepared.payloadHash},${audit.id},txid_current())`;
    const row = await loadRecord(tx, input.commandId);
    if (!row) return unavailable();
    await authorize(tx, actor);
    const result = await verifyJournal(tx, row, { ...scope,
      context: { ...scope.context, inboxVersion: versions[0].version } });
    return { state: 'RECORDED' as const, replay: false, receipt: result };
  });
}

/** Read-only with row locks, suitable for a future explicit outcome query. An
 * absent record remains NOT_OBSERVED, never NOT_COMMITTED or safe-to-repeat. */
export async function readHistoricalLeadContactOutcome(db: PrismaClient, actor: Actor, requested: unknown) {
  const lookup = z.object({ leadId: identifier, commandId: uuid }).strict().parse(requested);
  return withSerializableTransaction(db, async tx => {
    const scope = await lockContext(tx, actor, lookup.leadId);
    const row = await loadRecord(tx, lookup.commandId);
    if (!row) return { state: 'NOT_OBSERVED' as const, mayRepeat: false as const };
    const result = await verifyJournal(tx, row, scope);
    await authorize(tx, actor);
    return { state: 'RECORDED' as const, mayRepeat: false as const, receipt: result };
  });
}
