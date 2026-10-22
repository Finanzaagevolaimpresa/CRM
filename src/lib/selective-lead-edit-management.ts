import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewLead } from './access-control';
import { hasPermission } from './permission-evaluator';
import { canonicalSha256 } from './canonical-json';
import { leadFieldProjection } from './selective-lead-policy';
import { leadEditDecisionReceiptSchema } from './selective-lead-edit-access';
import { selectiveLeadEditPayloadSchema, selectiveLeadEditProof, type SelectiveLeadEditPayload } from './selective-lead-edit-grant';
import { selectiveLeadEditSelectionSchema, validateLeadEditSelection, type SelectiveLeadEditSelection } from './selective-lead-edit-policy';
import { createLeadEditPreview, readLeadEditPreview, type LeadEditPreviewAdmission } from './selective-lead-edit-preview';
import { LeadEditError, leadEditClock, lockLeadEditReadContext, withLeadEditTransaction,
  type LeadEditPersonalProof, type LeadEditTransactionState } from './selective-lead-edit-transaction';

type Tx = Prisma.TransactionClient;
type Grant = { id: string; leadId: string; recipientId: string; readGrantId: string;
  revision: number; payload: unknown; proof: string; revokedAt: Date | null };
type Decision = { id: string; actorId: string; sessionId: string; leadId: string; recipientId: string;
  expectedRevision: number; operation: 'GRANT' | 'REVOKE'; requestDigest: string;
  receipt: unknown; receiptProof: string; transactionId: bigint };
const plain = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
function deny(): never { throw new LeadEditError('DENIED'); }
function stale(): never { throw new LeadEditError('STALE'); }
function manager(state: LeadEditTransactionState, allowSelf = false) {
  if (state.current.userId !== state.editAuthority.userId || state.current.role !== 'admin'
    || (!allowSelf && state.current.userId === state.recipient.id)) deny();
}
async function managerLead(tx: Tx, state: LeadEditTransactionState, id: string, write: boolean, revoking = false) {
  manager(state);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Lead" WHERE id=${id} ${Prisma.raw(write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const row = await tx.lead.findUnique({ where: { id } });
  // Revocation may remove an already unusable capability after trash/conversion;
  // it never changes the lead or restores a read grant. All scope limits remain.
  if (!row || !canViewLead(state.current, revoking ? { ...row, deletedAt: null } : row)
    || (!revoking && (row.clientId || row.status === 'archiviato'))) deny();
  return row;
}
async function selected(tx: Tx, state: LeadEditTransactionState, input: SelectiveLeadEditSelection, write: boolean) {
  if (state.recipient.permissionOverrides.some(item => item.permission === 'lead.write' && !item.allowed)) deny();
  await managerLead(tx, state, input.leadId, write);
  const read = await lockLeadEditReadContext(tx, state, input.leadId, write);
  validateLeadEditSelection(input, read.payload, read.grant.proof, read.now.getTime());
  const rows = await tx.$queryRaw<Grant[]>`SELECT id,"leadId","recipientId","readGrantId",revision,payload,proof,"revokedAt"
    FROM "SelectiveLeadEditGrant" WHERE "leadId"=${input.leadId} AND "recipientId"=${input.recipientId} FOR UPDATE`;
  const previous = rows[0] ?? null;
  if ((previous?.revision ?? 0) !== input.revision) stale();
  const validUntil = Math.min(state.current.expiresAt * 1000, state.current.registryExpiresAt.getTime(),
    ...[input.expiresAt, read.payload.selection.expiresAt].filter((value): value is string => value !== null).map(Date.parse));
  const admission: LeadEditPreviewAdmission = { actorId: state.current.userId, sessionId: state.current.sessionId!,
    actorEpoch: state.actor.selectiveLeadEpoch, recipientEpoch: state.recipient.selectiveLeadEpoch,
    leadEpoch: read.lead.recordUpdateEpoch, authorityRevision: state.editAuthority.revision,
    readGrantRevision: read.grant.revision, capabilityRevision: input.revision, validUntil,
    stateHash: canonicalSha256(plain({ lead: read.lead, recipient: { id: state.recipient.id, name: state.recipient.name,
      email: state.recipient.email, role: state.recipient.role, permissions: state.recipient.permissionOverrides,
      epoch: state.recipient.selectiveLeadEpoch }, readGrant: { id: read.grant.id, revision: read.grant.revision, proof: read.grant.proof },
      previous: previous ? { id: previous.id, revision: previous.revision, proof: previous.proof, revokedAt: previous.revokedAt } : null })) };
  return { read, previous, admission };
}

async function replayDecision(tx: Tx, state: LeadEditTransactionState, id: string, digest: string,
  leadId: string, operation: 'GRANT' | 'REVOKE') {
  const rows = await tx.$queryRaw<Decision[]>`SELECT id,"actorId","sessionId","leadId","recipientId",
    "expectedRevision",operation,"requestDigest",receipt,"receiptProof","transactionId"
    FROM "SelectiveLeadEditDecision" WHERE id=${id}::uuid FOR SHARE`;
  const row = rows[0];
  if (!row) return null;
  if (row.actorId !== state.current.userId || row.sessionId !== state.current.sessionId
    || row.leadId !== leadId || row.recipientId !== state.recipient.id || row.operation !== operation || row.requestDigest !== digest) stale();
  const parsed = leadEditDecisionReceiptSchema.safeParse(row.receipt);
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(row.receiptProof)) deny();
  const receipt = parsed.data;
  if (receipt.commandId !== id || receipt.operation !== operation || receipt.revision !== row.expectedRevision + 1
    || receipt.keyVersion !== state.key.version || !timingSafeEqual(Buffer.from(row.receiptProof, 'hex'),
      Buffer.from(selectiveLeadEditProof(state.key, 'receipt', receipt), 'hex'))) deny();
  const history = await tx.$queryRaw<Array<{ id: string; grantId: string; revision: number; commandId: string;
    payload: unknown; proof: string; transactionId: bigint }>>`
    SELECT id,"grantId",revision,"commandId",payload,proof,"transactionId" FROM "SelectiveLeadEditRevision" WHERE id=${receipt.revisionId}::uuid`;
  const revision = history[0], audit = await tx.auditLog.findUnique({ where: { id: receipt.revisionId } });
  if (!revision || !audit) deny();
  const payload = selectiveLeadEditPayloadSchema.safeParse(revision.payload);
  if (!payload.success || revision.grantId !== receipt.grantId || revision.revision !== receipt.revision || revision.commandId !== id
    || revision.transactionId !== row.transactionId || payload.data.id !== receipt.grantId || payload.data.revision !== receipt.revision
    || payload.data.selection.commandId !== id || payload.data.selection.leadId !== leadId
    || payload.data.selection.recipientId !== state.recipient.id || payload.data.approvedById !== state.current.userId
    || payload.data.selection.fields.length !== receipt.fieldCount || payload.data.keyVersion !== state.key.version
    || revision.proof !== selectiveLeadEditProof(state.key, 'grant', payload.data)
    || audit.actorId !== state.current.userId || audit.event !== 'selective_lead_edit_capability_changed'
    || audit.entityType !== 'SelectiveLeadEditRevision' || audit.entityId !== receipt.revisionId
    || canonicalSha256(audit.before) !== canonicalSha256({ version: row.expectedRevision })
    || canonicalSha256(audit.after) !== canonicalSha256({ version: receipt.revision, action: operation, fieldCount: receipt.fieldCount })) deny();
  return receipt;
}

async function persistDecision(tx: Tx, state: LeadEditTransactionState, payload: SelectiveLeadEditPayload,
  previous: Grant | null, operation: 'GRANT' | 'REVOKE', digest: string, now: Date) {
  const input = payload.selection, proof = selectiveLeadEditProof(state.key, 'grant', payload),
    revokedAt = operation === 'REVOKE' ? now : null, revisionId = randomUUID();
  if (previous) {
    const count = await tx.$executeRaw`UPDATE "SelectiveLeadEditGrant"
      SET revision=${payload.revision},payload=${JSON.stringify(payload)}::jsonb,proof=${proof},"revokedAt"=${revokedAt},"updatedAt"=${now}
      WHERE id=${previous.id}::uuid AND revision=${previous.revision}`;
    if (count !== 1) stale();
  } else await tx.$executeRaw`INSERT INTO "SelectiveLeadEditGrant"
    (id,"leadId","recipientId","readGrantId",revision,payload,proof,"revokedAt","createdAt","updatedAt")
    VALUES (${payload.id}::uuid,${input.leadId},${input.recipientId},${input.readGrantId}::uuid,${payload.revision},
      ${JSON.stringify(payload)}::jsonb,${proof},${revokedAt},${now},${now})`;
  const receipt = leadEditDecisionReceiptSchema.parse({ protocol: 'SELECTIVE_LEAD_EDIT_DECISION_RECEIPT_V1',
    commandId: input.commandId, grantId: payload.id, revisionId, revision: payload.revision,
    operation, fieldCount: input.fields.length, keyVersion: state.key.version });
  const receiptProof = selectiveLeadEditProof(state.key, 'receipt', receipt);
  await tx.$executeRaw`INSERT INTO "SelectiveLeadEditDecision"
    (id,"actorId","sessionId","leadId","recipientId","expectedRevision",operation,"requestDigest",receipt,"receiptProof","createdAt")
    VALUES (${input.commandId}::uuid,${state.current.userId},${state.current.sessionId}::uuid,${input.leadId},${input.recipientId},
      ${input.revision},${operation},${digest},${JSON.stringify(receipt)}::jsonb,${receiptProof},${now})`;
  await tx.$executeRaw`INSERT INTO "SelectiveLeadEditRevision"
    (id,"grantId",revision,"commandId",payload,proof,"revokedAt","createdAt")
    VALUES (${revisionId}::uuid,${payload.id}::uuid,${payload.revision},${input.commandId}::uuid,
      ${JSON.stringify(payload)}::jsonb,${proof},${revokedAt},${now})`;
  await tx.auditLog.create({ data: { id: revisionId, actorId: state.current.userId,
    entityType: 'SelectiveLeadEditRevision', entityId: revisionId, event: 'selective_lead_edit_capability_changed', createdAt: now,
    before: { version: input.revision }, after: { version: payload.revision, action: operation, fieldCount: input.fields.length } } });
  return receipt;
}

/** The future management UI calls this as a read-only POST preview. */
export async function previewLeadEditingSelection(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = selectiveLeadEditSelectionSchema.parse(raw);
  return withLeadEditTransaction(db, claimed, input.recipientId, null, async (tx, state) => {
    const found = await selected(tx, state, input, false), now = await leadEditClock(tx);
    return { input, token: createLeadEditPreview('selection', state.key, input, found.admission, now.getTime()),
      fields: leadFieldProjection(found.read.lead as unknown as Record<string, unknown>, input.fields),
      recipient: { name: state.recipient.name, email: state.recipient.email, role: state.recipient.role }, replacesSelection: !!found.previous };
  });
}
export async function confirmLeadEditingSelection(db: PrismaClient, claimed: AuthSession, raw: unknown, token: string, proof: LeadEditPersonalProof) {
  const input = selectiveLeadEditSelectionSchema.parse(raw);
  if (typeof token !== 'string' || token.length > 32_000) deny();
  const digest = canonicalSha256({ operation: 'GRANT', input, token });
  return withLeadEditTransaction(db, claimed, input.recipientId, proof, async (tx, state) => {
    await managerLead(tx, state, input.leadId, true);
    const previous = await replayDecision(tx, state, input.commandId, digest, input.leadId, 'GRANT');
    if (previous) return previous;
    const found = await selected(tx, state, input, true), now = await leadEditClock(tx);
    const preview = readLeadEditPreview('selection', state.key, token, found.admission, now.getTime());
    if (!preview || canonicalSha256(preview) !== canonicalSha256(input)) stale();
    const payload = selectiveLeadEditPayloadSchema.parse({ protocol: 'SELECTIVE_LEAD_EDIT_GRANT_V1',
      id: found.previous?.id ?? randomUUID(), revision: input.revision + 1, selection: input,
      approvedById: state.current.userId, approvedAt: now.toISOString(), authorityRevision: state.editAuthority.revision,
      actorEpoch: state.actor.selectiveLeadEpoch, recipientEpoch: state.recipient.selectiveLeadEpoch,
      leadEpoch: found.read.lead.recordUpdateEpoch, keyVersion: state.key.version });
    const receipt = await persistDecision(tx, state, payload, found.previous, 'GRANT', digest, now);
    if (!readLeadEditPreview('selection', state.key, token, found.admission, (await leadEditClock(tx)).getTime())) stale();
    return receipt;
  });
}
const revokeSchema = z.object({ grantId: z.string().uuid(), revision: z.number().int().positive().max(2_147_483_646), commandId: z.string().uuid() }).strict();

/** Management choices are limited to existing valid read selections. The
 * directory/identity/lead locks retain one coherent view, and the actual
 * preview/confirmation rereads everything. No choice enrolls editing. */
export async function readLeadEditingManagement(db: PrismaClient, claimed: AuthSession, leadId: string) {
  z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(leadId);
  return withLeadEditTransaction(db, claimed, claimed.userId, null, async (tx, state) => {
    manager(state, true);
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${leadId} FOR SHARE`;
    const row = await tx.lead.findUnique({ where: { id: leadId } });
    if (!row || !canViewLead(state.current, { ...row, deletedAt: null })) deny();
    const reads = await tx.selectiveLeadGrant.findMany({ where: { leadId }, orderBy: { recipientId: 'asc' },
      include: { recipient: { include: { permissionOverrides: true } } } });
    const edits = await tx.$queryRaw<Grant[]>`SELECT id,"leadId","recipientId","readGrantId",revision,payload,proof,"revokedAt"
      FROM "SelectiveLeadEditGrant" WHERE "leadId"=${leadId} ORDER BY "recipientId" FOR SHARE`;
    const choices: Array<{ id: string; name: string; email: string; role: string; readGrantId: string;
      readGrantRevision: number; readGrantProof: string; revision: number; fields: Array<'interest' | 'priority'>; expiresAt: string | null }> = [];
    for (const read of reads) {
      const person = read.recipient;
      if (person.id === state.current.userId || !person.active || person.deletedAt
        || !hasPermission(person, 'lead.read')
        || person.permissionOverrides.some(item => ['lead.read', 'lead.write'].includes(item.permission) && !item.allowed)) continue;
      try {
        const valid = await lockLeadEditReadContext(tx, { ...state, recipient: person }, leadId);
        const fields = valid.payload.selection.fields.filter((field): field is 'interest' | 'priority' => field === 'interest' || field === 'priority');
        if (fields.length) choices.push({ id: person.id, name: person.name, email: person.email, role: person.role,
          readGrantId: valid.grant.id, readGrantRevision: valid.grant.revision, readGrantProof: valid.grant.proof,
          revision: edits.find(edit => edit.recipientId === person.id)?.revision ?? 0,
          fields, expiresAt: valid.payload.selection.expiresAt });
      } catch (error) {
        if (!(error instanceof LeadEditError && error.code === 'DENIED') && !(error instanceof z.ZodError)) throw error;
      }
    }
    return { leadId, choices, grants: edits.map(edit => {
      const person = reads.find(read => read.id === edit.readGrantId)?.recipient;
      if (!person) deny();
      const parsed = selectiveLeadEditPayloadSchema.safeParse(edit.payload);
      return { id: edit.id, revision: edit.revision, recipientId: person.id, recipientName: person.name,
        recipientEmail: person.email, revoked: !!edit.revokedAt,
        fields: parsed.success ? parsed.data.selection.fields : [],
        expiresAt: parsed.success ? parsed.data.selection.expiresAt : null };
    }) };
  });
}

export async function revokeLeadEditing(db: PrismaClient, claimed: AuthSession, raw: unknown, proof: LeadEditPersonalProof) {
  const input = revokeSchema.parse(raw), digest = canonicalSha256({ operation: 'REVOKE', input });
  // Identity hints only; all state is reread under the transaction's locks.
  const hints = await db.$queryRaw<Array<{ leadId: string; recipientId: string }>>`
    SELECT "leadId","recipientId" FROM "SelectiveLeadEditGrant" WHERE id=${input.grantId}::uuid`;
  const hint = hints[0]; if (!hint) deny();
  return withLeadEditTransaction(db, claimed, hint.recipientId, proof, async (tx, state) => {
    const lead = await managerLead(tx, state, hint.leadId, true, true);
    const replay = await replayDecision(tx, state, input.commandId, digest, hint.leadId, 'REVOKE');
    if (replay) return replay;
    const rows = await tx.$queryRaw<Grant[]>`SELECT id,"leadId","recipientId","readGrantId",revision,payload,proof,"revokedAt"
      FROM "SelectiveLeadEditGrant" WHERE id=${input.grantId}::uuid FOR UPDATE`;
    const grant = rows[0];
    if (!grant || grant.leadId !== hint.leadId || grant.recipientId !== hint.recipientId || grant.revision !== input.revision || grant.revokedAt) stale();
    const old = selectiveLeadEditPayloadSchema.parse(grant.payload), now = await leadEditClock(tx);
    if (old.id !== grant.id || old.selection.readGrantId !== grant.readGrantId
      || old.selection.leadId !== hint.leadId || old.selection.recipientId !== hint.recipientId) deny();
    const payload = selectiveLeadEditPayloadSchema.parse({ ...old, revision: grant.revision + 1,
      selection: { ...old.selection, revision: grant.revision, commandId: input.commandId },
      approvedById: state.current.userId, approvedAt: now.toISOString(), authorityRevision: state.editAuthority.revision,
      actorEpoch: state.actor.selectiveLeadEpoch, recipientEpoch: state.recipient.selectiveLeadEpoch,
      leadEpoch: lead.recordUpdateEpoch, keyVersion: state.key.version });
    return persistDecision(tx, state, payload, grant, 'REVOKE', digest, now);
  }, { inactiveRecipientForRevocation: true });
}
