import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { lockLeadEditCapability } from './selective-lead-edit-access';
import { readSelectiveLeadEditGrant } from './selective-lead-edit-grant';
import { parseBoundLeadEditCommand, selectiveLeadEditCommandSchema, type SelectiveLeadEditableField } from './selective-lead-edit-policy';
import { createLeadEditPreview, readLeadEditPreview, type LeadEditPreviewAdmission } from './selective-lead-edit-preview';
import { leadEditRequestDigest, readLeadEditReceipt, signLeadEditReceipt } from './selective-lead-edit-receipt';
import { LeadEditError, leadEditClock, lockLeadEditReadContext, withLeadEditTransaction,
  type LeadEditTransactionState } from './selective-lead-edit-transaction';

type Tx = Prisma.TransactionClient;
type ReadContext = Awaited<ReturnType<typeof lockLeadEditReadContext>>;
type Capability = Awaited<ReturnType<typeof lockLeadEditCapability>>;
type Command = ReturnType<typeof selectiveLeadEditCommandSchema.parse>;
type JournalRow = { id: string; actorId: string; sessionId: string; leadId: string; capabilityId: string;
  capabilityRevision: number; requestDigest: string; beforeVersion: Date; afterVersion: Date;
  changedFields: string[]; receipt: unknown; receiptProof: string; createdAt: Date };
const plain = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
function stale(): never { throw new LeadEditError('STALE'); }
function denied(): never { throw new LeadEditError('DENIED'); }

function previewAdmission(state: LeadEditTransactionState, read: ReadContext, capability: Capability): LeadEditPreviewAdmission {
  const limits = [state.current.expiresAt * 1000, state.current.registryExpiresAt.getTime(),
    ...[read.payload.selection.expiresAt, capability.payload.selection.expiresAt].filter((x): x is string => x !== null).map(Date.parse)];
  return { actorId: state.current.userId, sessionId: state.current.sessionId!, actorEpoch: state.actor.selectiveLeadEpoch,
    recipientEpoch: state.recipient.selectiveLeadEpoch, leadEpoch: read.lead.recordUpdateEpoch,
    authorityRevision: state.editAuthority.revision, readGrantRevision: read.grant.revision,
    capabilityRevision: capability.grant.revision, validUntil: Math.min(...limits),
    stateHash: canonicalSha256(plain({ lead: read.lead, readGrant: { id: read.grant.id, revision: read.grant.revision, proof: read.grant.proof },
      capability: { id: capability.grant.id, revision: capability.grant.revision, proof: capability.grant.proof } })) };
}
function boundCommand(raw: unknown, read: ReadContext, capability: Capability) {
  const command = parseBoundLeadEditCommand(raw, { capabilityId: capability.grant.id, capabilityRevision: capability.grant.revision,
    selection: capability.payload.selection, currentVersion: read.lead.updatedAt.toISOString() });
  const fields = (Object.keys(command.changes) as SelectiveLeadEditableField[])
    .filter(field => read.lead[field] !== command.changes[field]).sort();
  if (fields.length === 0) stale();
  return { command, fields };
}

/** Future POST preview. This performs locks/reads only, with no command or audit
 * writes; it is not exported by an action or route until DB/browser qualification.
 */
export async function previewLeadEdit(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = selectiveLeadEditCommandSchema.parse(raw);
  return withLeadEditTransaction(db, claimed, claimed.userId, null, async (tx, state) => {
    const read = await lockLeadEditReadContext(tx, state, input.leadId);
    const capability = await lockLeadEditCapability(tx, state, read);
    const { command, fields } = boundCommand(input, read, capability);
    const now = await leadEditClock(tx);
    return { command, changes: fields.map(field => ({ field, before: read.lead[field], after: command.changes[field] })),
      token: createLeadEditPreview('change', state.key, command, previewAdmission(state, read, capability), now.getTime()) };
  });
}

async function previousCommand(tx: Tx, state: LeadEditTransactionState, read: ReadContext, capability: Capability, input: Command) {
  const rows = await tx.$queryRaw<JournalRow[]>`
    SELECT id,"actorId","sessionId","leadId","capabilityId","capabilityRevision","requestDigest",
      "beforeVersion","afterVersion","changedFields",receipt,"receiptProof","createdAt"
    FROM "SelectiveLeadEditCommand" WHERE id=${input.commandId}::uuid FOR SHARE`;
  const row = rows[0];
  if (!row) return null;
  const digest = leadEditRequestDigest(input);
  if (row.actorId !== state.current.userId || row.sessionId !== state.current.sessionId
    || row.leadId !== input.leadId || row.requestDigest !== digest || row.beforeVersion.toISOString() !== input.expectedVersion) stale();
  const receipt = readLeadEditReceipt({ payload: row.receipt, proof: row.receiptProof }, capability.raw, read.raw,
    state.key, capability.current, { commandId: input.commandId, requestDigest: digest }, (await leadEditClock(tx)).getTime());
  if (!receipt || row.capabilityId !== receipt.capabilityId || row.capabilityRevision !== receipt.capabilityRevision
    || row.beforeVersion.toISOString() !== receipt.beforeVersion || row.afterVersion.toISOString() !== receipt.afterVersion
    || row.createdAt.toISOString() !== receipt.recordedAt || canonicalSha256(row.changedFields) !== canonicalSha256(receipt.changedFields)) denied();
  const audit = await tx.auditLog.findUnique({ where: { id: row.id } });
  if (!audit || audit.actorId !== state.current.userId || audit.entityType !== 'SelectiveLeadEditCommand'
    || audit.entityId !== row.id || audit.event !== 'selective_lead_edit_applied'
    || canonicalSha256(audit.before) !== canonicalSha256({ version: receipt.beforeVersion })
    || canonicalSha256(audit.after) !== canonicalSha256({ version: receipt.afterVersion, fields: receipt.changedFields })) denied();
  return receipt;
}

/** Single recipient command, not personal authority enrollment. Persistence is
 * deliberately unreachable from product routes until the future SQL, admin
 * capability management and PostgreSQL/browser gates are complete.
 */
export async function confirmLeadEdit(db: PrismaClient, claimed: AuthSession, raw: unknown, token: string, confirmed: boolean) {
  if (confirmed !== true || typeof token !== 'string' || token.length > 32_000) denied();
  const input = selectiveLeadEditCommandSchema.parse(raw);
  return withLeadEditTransaction(db, claimed, claimed.userId, null, async (tx, state) => {
    const read = await lockLeadEditReadContext(tx, state, input.leadId, true);
    const capability = await lockLeadEditCapability(tx, state, read);
    const previous = await previousCommand(tx, state, read, capability, input);
    if (previous) return previous;
    const { command, fields } = boundCommand(input, read, capability);
    const admission = previewAdmission(state, read, capability), now = await leadEditClock(tx);
    const preview = readLeadEditPreview('change', state.key, token, admission, now.getTime());
    if (!preview || canonicalSha256(preview) !== canonicalSha256(command)) stale();
    const updatedAt = new Date(Math.max(now.getTime(), read.lead.updatedAt.getTime() + 1));
    const after = await tx.lead.update({ where: { id: input.leadId, updatedAt: read.lead.updatedAt, deletedAt: null, clientId: null },
      data: { ...command.changes, updatedAt } });
    const unchanged = (value: unknown) => {
      const copy = plain(value) as Record<string, Prisma.InputJsonValue>;
      for (const field of [...fields, 'updatedAt']) delete copy[field];
      return canonicalSha256(copy);
    };
    if (unchanged(after) !== unchanged(read.lead) || fields.some(field => after[field] !== command.changes[field])) denied();
    const recordedAt = await leadEditClock(tx), requestDigest = leadEditRequestDigest(command);
    const signed = signLeadEditReceipt(state.key, { protocol: 'SELECTIVE_LEAD_EDIT_RESULT_V1', commandId: command.commandId,
      leadId: command.leadId, actorId: state.current.userId, capabilityId: capability.grant.id, capabilityRevision: capability.grant.revision,
      requestDigest, beforeVersion: read.lead.updatedAt.toISOString(), afterVersion: after.updatedAt.toISOString(),
      changedFields: fields, recordedAt: recordedAt.toISOString(), keyVersion: state.key.version });
    await tx.$executeRaw`INSERT INTO "SelectiveLeadEditCommand"
      (id,"actorId","sessionId","leadId","capabilityId","capabilityRevision","requestDigest",
       "beforeVersion","afterVersion","changedFields",receipt,"receiptProof","createdAt")
      VALUES (${command.commandId}::uuid,${state.current.userId},${state.current.sessionId}::uuid,${command.leadId},
       ${capability.grant.id}::uuid,${capability.grant.revision},${requestDigest},${read.lead.updatedAt},${after.updatedAt},
       ${fields}::text[],${JSON.stringify(signed.payload)}::jsonb,${signed.proof},${recordedAt})`;
    await tx.auditLog.create({ data: { id: command.commandId, actorId: state.current.userId,
      entityType: 'SelectiveLeadEditCommand', entityId: command.commandId, event: 'selective_lead_edit_applied', createdAt: recordedAt,
      before: { version: signed.payload.beforeVersion }, after: { version: signed.payload.afterVersion, fields } } });
    const finish = await leadEditClock(tx);
    if (!readSelectiveLeadEditGrant(capability.raw, read.raw, state.key, capability.current, finish.getTime())
      || !readLeadEditPreview('change', state.key, token, admission, finish.getTime())) stale();
    return signed.payload;
  });
}

/** Receipt lookup uses the original validated command and current admission.
 * A null result is only an observation, never proof that a request cannot commit.
 */
export async function readLeadEditOutcome(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = selectiveLeadEditCommandSchema.parse(raw);
  return withLeadEditTransaction(db, claimed, claimed.userId, null, async (tx, state) => {
    const read = await lockLeadEditReadContext(tx, state, input.leadId);
    const capability = await lockLeadEditCapability(tx, state, read);
    return previousCommand(tx, state, read, capability, input);
  });
}
