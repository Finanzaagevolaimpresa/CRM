import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { historicalContactAudit, historicalContactInput, HistoricalContactError, prepareHistoricalContact,
  prepareHistoricalConversion, type HistoricalContactContext, type HistoricalContactReceipt,
  type HistoricalContactInput, historicalConversionInput, historicalConversionHash, historicalConversionAudit,
  HISTORICAL_CONVERSION_OUTCOME, type HistoricalConversionInput } from './commercial-lead-historical-contact-contract';
import { commercialLeadInboxMode } from './commercial-lead-inbox-contract';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { hasPermission } from './permission-evaluator';
import { latestResponsibility, readResponsibility } from './responsibility';
import { responsibilityAcceptance } from './responsibility-contract';
import { assertNoSelectiveLeadMutation } from './selective-lead-scope';
import { internalSessionMode } from './session';
import { SerializableConflictError, withSerializableTransaction } from './serializable';

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
  try { return await withSerializableTransaction(db, async tx => {
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
    // Surface deferred journal failures inside the transaction callback, before
    // the ORM can return a result from a commit rejected by PostgreSQL.
    await tx.$executeRaw`SET CONSTRAINTS "CommercialLeadHistoricalContact_journal" IMMEDIATE`;
    const row = await loadRecord(tx, input.commandId);
    if (!row) return unavailable();
    await authorize(tx, actor);
    const result = await verifyJournal(tx, row, { ...scope,
      context: { ...scope.context, inboxVersion: versions[0].version } });
    return { state: 'RECORDED' as const, replay: false, receipt: result };
  }); } catch (error) {
    if (!(error instanceof SerializableConflictError)) throw error;
    // The failed transaction has rolled back. Reconcile once by a fresh,
    // authorized read; never retry the write or accept another payload.
    const outcome = await readHistoricalLeadContactOutcome(db, actor, { leadId: input.leadId, commandId: input.commandId });
    if (outcome.state !== 'RECORDED' || JSON.stringify(outcome.receipt.input) !== JSON.stringify(input)) return unavailable();
    return { state: 'RECORDED' as const, replay: true, receipt: outcome.receipt };
  }
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

/** Called only inside the existing N14 conversion transaction. No browser input
 * is accepted as proof: the contact and current responsibility are reloaded. */
export async function prepareHistoricalLeadConversion(tx: Tx, actor: Actor, input: HistoricalConversionInput) {
  const scope = await lockContext(tx, actor, input.leadId);
  if (!scope.canCreateClient) throw new HistoricalContactError('NOT_AUTHORIZED');
  if (scope.context.inboxVersion !== input.expectedInboxVersion
    || scope.context.assignmentId !== input.expectedAssignmentId) return unavailable();
  const row = await loadRecord(tx, input.contactId);
  if (!row) return unavailable();
  const contact = await verifyJournal(tx, row, scope);
  const basis = prepareHistoricalConversion(contact, { ...scope.context, historicalContactExists: true,
    inboxItemId: scope.item.id, cycleId: scope.cycle.id, canCreateClient: scope.canCreateClient });
  return { input, basis, contact, inboxItemId: scope.item.id, cycleId: scope.cycle.id,
    payloadHash: historicalConversionHash(input, actor.userId, row.payloadHash) };
}

const conversionRow = z.object({
  id: uuid, input: z.unknown(), actorId: identifier, sessionId: uuid, inboxItemId: uuid,
  cycleId: uuid, contactId: uuid, clientId: identifier, recordedAt: z.date(),
  inboxVersionBefore: z.number().int().min(2), inboxVersionAfter: z.number().int().min(3),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/u), auditId: identifier, transactionId: z.bigint().positive(),
}).strict();

/** Current authorization is checked before an exact replay or outcome is
 * disclosed. Reconciliation never creates a client or repeats a conversion. */
export async function readHistoricalConversionInTransaction(tx: Tx, actor: Actor,
  lookup: { leadId: string; commandId: string }, expected?: HistoricalConversionInput) {
  const session = await authorize(tx, actor);
  if (!hasPermission(session, 'client.read') || !hasPermission(session, 'client.write')) {
    throw new HistoricalContactError('NOT_AUTHORIZED');
  }
  await assertNoSelectiveLeadMutation(tx, actor.userId, lookup.leadId);
  const leads = await tx.$queryRaw<Array<{ id: string; assignedToId: string | null; clientId: string | null; deletedAt: Date | null }>>`
    SELECT id,"assignedToId","clientId","deletedAt" FROM "Lead" WHERE id=${lookup.leadId} FOR UPDATE`;
  const lead = leads[0];
  if (!lead || lead.deletedAt || lead.assignedToId !== actor.userId) return unavailable();
  const items = await tx.$queryRaw<Array<{ id: string; state: string; version: number; originKind: string; initializedAt: Date; closedAt: Date | null }>>`
    SELECT id,state,version,"originKind","initializedAt","closedAt" FROM "CommercialLeadInboxItem" WHERE "leadId"=${lead.id} FOR UPDATE`;
  const item = items[0];
  if (!item || item.originKind !== 'MANUAL_CRM') return unavailable();
  // After conversion a lead is no longer workable. Verify the unchanged
  // assignment and its explicit acceptance directly for reconciliation; this
  // does not revive an assignment or authorize a new operation on a closed lead.
  const assignment = await latestResponsibility(tx, 'Lead', lead.id);
  if (!assignment || !assignment.decision.allowed || assignment.decision.state.commercialOwnerId !== actor.userId
    || assignment.decision.state.clientId !== null || assignment.decision.state.projectId !== null
    || assignment.decision.state.clientServiceId !== null || assignment.decision.state.technicalOwnerId !== null) return unavailable();
  const acceptances = await tx.auditLog.findMany({ where: { entityType: 'Lead', entityId: lead.id,
    event: 'responsibility_accepted', actorId: actor.userId, after: { path: ['decisionId'], equals: assignment.id } },
    select: { after: true } });
  if (!acceptances.some(row => {
    const parsed = responsibilityAcceptance.safeParse(row.after);
    return parsed.success && parsed.data.role === 'commerciale' && parsed.data.userId === actor.userId
      && parsed.data.decisionId === assignment.id;
  })) return unavailable();
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT id,input,"actorId","sessionId","inboxItemId","cycleId","contactId","clientId","recordedAt",
      "inboxVersionBefore","inboxVersionAfter","payloadHash","auditId","transactionId"
    FROM "CommercialLeadHistoricalConversion" WHERE id=${lookup.commandId}::uuid FOR SHARE`;
  if (!rows.length) return null;
  const parsed = conversionRow.safeParse(rows[0]);
  if (rows.length !== 1 || !parsed.success) return unavailable();
  const row = parsed.data;
  if (!row.input || typeof row.input !== 'object' || Array.isArray(row.input)) return unavailable();
  const { protocol, ...raw } = row.input as Record<string, unknown>;
  if (protocol !== 'N14_HISTORICAL_CONVERSION_V1') return unavailable();
  const input = historicalConversionInput(raw);
  if (input.commandId !== row.id || input.leadId !== lead.id || input.contactId !== row.contactId
    || row.actorId !== actor.userId || input.expectedAssignmentId !== assignment.id
    || row.inboxItemId !== item.id || item.state !== 'CLOSED' || lead.clientId !== row.clientId
    || input.expectedInboxVersion !== row.inboxVersionBefore || row.inboxVersionAfter !== row.inboxVersionBefore + 1
    || item.version !== row.inboxVersionAfter || item.closedAt?.getTime() !== row.recordedAt.getTime()
    || (expected && JSON.stringify(expected) !== JSON.stringify(input))) return unavailable();
  const contact = await loadRecord(tx, row.contactId);
  if (!contact || contact.actorId !== actor.userId || contact.assignmentId !== assignment.id
    || contact.input.leadId !== lead.id || contact.inboxItemId !== item.id || contact.cycleId !== row.cycleId
    || contact.inboxVersionAfter > row.inboxVersionBefore || contact.recordedAt > row.recordedAt) return unavailable();
  const cycles = await tx.$queryRaw<Array<{ sequence: number; firstResponseAt: Date | null; outcome: string | null; closedAt: Date | null }>>`
    SELECT sequence,"firstResponseAt",outcome,"closedAt" FROM "CommercialLeadSlaCycle"
    WHERE id=${row.cycleId}::uuid AND "inboxItemId"=${item.id}::uuid FOR SHARE`;
  const cycle = cycles[0];
  if (cycles.length !== 1 || !cycle || cycle.sequence !== 1 || cycle.firstResponseAt
    || cycle.outcome !== HISTORICAL_CONVERSION_OUTCOME || cycle.closedAt?.getTime() !== row.recordedAt.getTime()
    || row.payloadHash !== historicalConversionHash(input, actor.userId, contact.payloadHash)) return unavailable();
  const audit = await tx.auditLog.findUnique({ where: { id: row.auditId }, select: {
    actorId: true, entityType: true, entityId: true, event: true, after: true,
  } });
  const expectedAudit = historicalConversionAudit(input);
  if (!audit || audit.actorId !== actor.userId || audit.entityType !== 'CommercialLeadInboxItem'
    || audit.entityId !== item.id || audit.event !== 'commercial_lead_historical_conversion_recorded'
    || !audit.after || typeof audit.after !== 'object' || Array.isArray(audit.after)
    || Object.keys(audit.after).length !== Object.keys(expectedAudit).length
    || Object.entries(expectedAudit).some(([key, value]) => (audit.after as Record<string, unknown>)[key] !== value)) return unavailable();
  const result = await tx.client.findUnique({ where: { id: row.clientId } });
  if (!result || result.deletedAt || result.leadId !== lead.id || result.salesOwnerId !== actor.userId || result.type !== input.clientType) return unavailable();
  await authorize(tx, actor);
  return { input, client: result, recordedAt: row.recordedAt.toISOString(), basis: HISTORICAL_CONVERSION_OUTCOME };
}

export async function appendHistoricalLeadConversion(tx: Tx, actor: Actor,
  prepared: Awaited<ReturnType<typeof prepareHistoricalLeadConversion>>, clientId: string, recordedAt: Date) {
  const { input } = prepared;
  const audit = await tx.auditLog.create({ data: { actorId: actor.userId, entityType: 'CommercialLeadInboxItem',
    entityId: prepared.inboxItemId, event: 'commercial_lead_historical_conversion_recorded', after: historicalConversionAudit(input) } });
  await tx.$executeRaw`
    INSERT INTO "CommercialLeadHistoricalConversion"
    (id,input,"actorId","sessionId","inboxItemId","cycleId","contactId","clientId","recordedAt",
      "inboxVersionBefore","inboxVersionAfter","payloadHash","auditId","transactionId")
    VALUES (${input.commandId}::uuid,${JSON.stringify(input)}::jsonb,${actor.userId},${actor.sessionId}::uuid,
      ${prepared.inboxItemId}::uuid,${prepared.cycleId}::uuid,${input.contactId}::uuid,${clientId},${recordedAt},
      ${input.expectedInboxVersion},${input.expectedInboxVersion + 1},${prepared.payloadHash},${audit.id},txid_current())`;
  // Validate the command first, then its SLA linkage. PostgreSQL processes
  // queued events in occurrence order when both names share one SET statement.
  await tx.$executeRaw`SET CONSTRAINTS "CommercialLeadHistoricalConversion_journal" IMMEDIATE`;
  await tx.$executeRaw`SET CONSTRAINTS "CommercialLeadSlaCycle_historical_basis" IMMEDIATE`;
  const result = await readHistoricalConversionInTransaction(tx, actor, { leadId: input.leadId, commandId: input.commandId }, input);
  if (!result || result.client.id !== clientId) return unavailable();
}

export async function readHistoricalLeadConversionOutcome(db: PrismaClient, actor: Actor, requested: unknown) {
  const lookup = z.object({ leadId: identifier, commandId: uuid }).strict().parse(requested);
  return withSerializableTransaction(db, async tx => {
    const result = await readHistoricalConversionInTransaction(tx, actor, lookup);
    return result ? { state: 'CONVERTED' as const, mayRepeat: false as const,
      clientId: result.client.id, recordedAt: result.recordedAt, basis: result.basis }
      : { state: 'NOT_OBSERVED' as const, mayRepeat: false as const };
  });
}
