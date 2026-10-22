import { timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { selectiveLeadEditableFields } from './selective-lead-edit-policy';
import { readSelectiveLeadEditGrant, selectiveLeadEditProof, type SelectiveLeadEditAdmission } from './selective-lead-edit-grant';
import { LeadEditError, leadEditClock, lockLeadEditReadContext, withLeadEditTransaction,
  type LeadEditTransactionState } from './selective-lead-edit-transaction';

type Tx = Prisma.TransactionClient;
type ReadContext = Awaited<ReturnType<typeof lockLeadEditReadContext>>;
type GrantRow = { id: string; leadId: string; recipientId: string; readGrantId: string; revision: number;
  payload: unknown; proof: string; revokedAt: Date | null };
type RevisionRow = { id: string; grantId: string; revision: number; commandId: string; payload: unknown;
  proof: string; revokedAt: Date | null; transactionId: bigint };
type DecisionRow = { id: string; actorId: string; leadId: string; recipientId: string; expectedRevision: number;
  operation: string; receipt: unknown; receiptProof: string; transactionId: bigint };
const generation = z.number().int().positive().max(2_147_483_647);
export const leadEditDecisionReceiptSchema = z.object({
  protocol: z.literal('SELECTIVE_LEAD_EDIT_DECISION_RECEIPT_V1'), commandId: z.string().uuid(),
  grantId: z.string().uuid(), revisionId: z.string().uuid(), revision: generation,
  operation: z.enum(['GRANT', 'REVOKE']), fieldCount: z.number().int().min(1).max(2), keyVersion: generation,
}).strict();
function deny(): never { throw new LeadEditError('DENIED'); }

/** Internal only. The caller must already hold withLeadEditTransaction and the
 * lead/read-grant locks. Future tables are intentionally absent from schema62;
 * this module has no action/route callers until the full increment is qualified.
 */
export async function lockLeadEditCapability(tx: Tx, state: LeadEditTransactionState, read: ReadContext) {
  const rows = await tx.$queryRaw<GrantRow[]>`
    SELECT id,"leadId","recipientId","readGrantId",revision,payload,proof,"revokedAt"
    FROM "SelectiveLeadEditGrant" WHERE "leadId"=${read.lead.id} AND "recipientId"=${state.recipient.id} FOR SHARE`;
  const grant = rows[0];
  if (!grant || grant.leadId !== read.lead.id || grant.recipientId !== state.recipient.id || grant.readGrantId !== read.grant.id) deny();
  const current: SelectiveLeadEditAdmission = {
    capabilityId: grant.id, capabilityRevision: grant.revision,
    authority: { purpose: 'lead-edit', enabled: state.editAuthority.enabled, userId: state.editAuthority.userId,
      revision: state.editAuthority.revision, actorEpoch: state.authorityUser.selectiveLeadEpoch,
      actorActive: true, actorIsAdmin: true, writeAllowed: true },
    read: read.current,
    recipientWriteDenied: state.recipient.permissionOverrides.some(p => p.permission === 'lead.write' && !p.allowed),
    leadConverted: !!read.lead.clientId,
  };
  const raw = { payload: grant.payload, proof: grant.proof, revokedAt: grant.revokedAt?.toISOString() ?? null };
  const payload = readSelectiveLeadEditGrant(raw, read.raw, state.key, current, (await leadEditClock(tx)).getTime());
  if (!payload) deny();
  const history = await tx.$queryRaw<RevisionRow[]>`
    SELECT id,"grantId",revision,"commandId",payload,proof,"revokedAt","transactionId"
    FROM "SelectiveLeadEditRevision" WHERE "grantId"=${grant.id}::uuid AND revision=${grant.revision}`;
  const revision = history[0];
  if (!revision) deny();
  const decisions = await tx.$queryRaw<DecisionRow[]>`
    SELECT id,"actorId","leadId","recipientId","expectedRevision",operation,receipt,"receiptProof","transactionId"
    FROM "SelectiveLeadEditDecision" WHERE id=${revision.commandId}::uuid`;
  const command = decisions[0], audit = await tx.auditLog.findUnique({ where: { id: revision.id } });
  if (!command || !audit || revision.revokedAt || revision.proof !== grant.proof
    || canonicalSha256(revision.payload) !== canonicalSha256(grant.payload)
    || command.id !== payload.selection.commandId || command.leadId !== read.lead.id
    || command.recipientId !== state.recipient.id || command.expectedRevision + 1 !== grant.revision
    || command.operation !== 'GRANT' || command.actorId !== payload.approvedById
    || command.transactionId !== revision.transactionId || audit.actorId !== payload.approvedById
    || audit.event !== 'selective_lead_edit_capability_changed'
    || audit.entityType !== 'SelectiveLeadEditRevision' || audit.entityId !== revision.id
    || canonicalSha256(audit.before) !== canonicalSha256({ version: command.expectedRevision })
    || canonicalSha256(audit.after) !== canonicalSha256({ version: grant.revision, action: 'GRANT', fieldCount: payload.selection.fields.length })) deny();
  const parsed = leadEditDecisionReceiptSchema.safeParse(command.receipt);
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(command.receiptProof)) deny();
  const receipt = parsed.data;
  if (receipt.commandId !== command.id || receipt.grantId !== grant.id || receipt.revisionId !== revision.id
    || receipt.revision !== grant.revision || receipt.operation !== 'GRANT' || receipt.fieldCount !== payload.selection.fields.length
    || receipt.keyVersion !== state.key.version
    || !timingSafeEqual(Buffer.from(command.receiptProof, 'hex'),
      Buffer.from(selectiveLeadEditProof(state.key, 'receipt', receipt), 'hex'))) deny();
  const now = await leadEditClock(tx);
  if (!readSelectiveLeadEditGrant(raw, read.raw, state.key, current, now.getTime())) deny();
  return { grant, raw, payload, current, now };
}

/** Data for the restricted form: only explicitly editable/readable values
 * and concurrency identifiers. No names, owner, notes or ordinary lead payload.
 * No grant, audit, command or other row is created by this read operation.
 */
export async function readLeadEditing(db: PrismaClient, claimed: AuthSession, leadId: string) {
  return withLeadEditTransaction(db, claimed, claimed.userId, null, async (tx, state) => {
    const read = await lockLeadEditReadContext(tx, state, leadId);
    const capability = await lockLeadEditCapability(tx, state, read);
    return { leadId, expectedVersion: read.lead.updatedAt.toISOString(),
      capabilityId: capability.grant.id, capabilityRevision: capability.grant.revision,
      readGrantId: read.grant.id, readGrantRevision: read.grant.revision, readGrantProof: read.grant.proof,
      expiresAt: capability.payload.selection.expiresAt,
      fields: capability.payload.selection.fields.map(key => ({ key,
        label: selectiveLeadEditableFields[key], value: read.lead[key] })) };
  });
}
