import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { selectiveLeadEditCommandSchema } from './selective-lead-edit-policy';
import { readSelectiveLeadEditGrant, selectiveLeadEditProof, type SelectiveLeadEditAdmission } from './selective-lead-edit-grant';

const generation = z.number().int().positive().max(2_147_483_647);
const receiptSchema = z.object({
  protocol: z.literal('SELECTIVE_LEAD_EDIT_RESULT_V1'),
  commandId: z.string().uuid(), leadId: z.string().min(1).max(128),
  actorId: z.string().min(1).max(128), capabilityId: z.string().uuid(), capabilityRevision: generation,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  beforeVersion: z.string().datetime(), afterVersion: z.string().datetime(),
  changedFields: z.array(z.enum(['interest', 'priority'])).min(1).max(2),
  recordedAt: z.string().datetime(), keyVersion: generation,
}).strict().superRefine((r, ctx) => {
  if (Date.parse(r.afterVersion) <= Date.parse(r.beforeVersion)
    || new Set(r.changedFields).size !== r.changedFields.length
    || r.changedFields.join(',') !== [...r.changedFields].sort().join(',')) {
    ctx.addIssue({ code: 'custom', message: 'Invalid selective edit receipt.' });
  }
});
export type SelectiveLeadEditReceipt = z.infer<typeof receiptSchema>;

/** Digest the validated command, not the ordinary lead form or its raw encoding. */
export function leadEditRequestDigest(raw: unknown) {
  return canonicalSha256(selectiveLeadEditCommandSchema.parse(raw));
}

/** Caller supplies actual transaction outcomes and persists this together with
 * the mutation and audit. Signing alone proves neither commit nor atomicity. */
export function signLeadEditReceipt(key: PrivilegedStepUpKey, raw: unknown) {
  const payload = receiptSchema.parse(raw);
  if (payload.keyVersion !== key.version) throw new Error('SELECTIVE_LEAD_EDIT_RECEIPT_KEY');
  return { payload, proof: selectiveLeadEditProof(key, 'receipt', payload) };
}

/** The server must first lock session, journal and current admission facts.
 * A receipt alone never renews a revoked read/edit capability or executes work. */
export function readLeadEditReceipt(raw: unknown, rawCapability: unknown, rawRead: unknown,
  key: PrivilegedStepUpKey, current: SelectiveLeadEditAdmission,
  expected: { commandId: string; requestDigest: string }, now: number) {
  try {
    const capability = readSelectiveLeadEditGrant(rawCapability, rawRead, key, current, now);
    if (!capability) return null;
    const row = z.object({ payload: receiptSchema, proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
    const p = row.payload;
    if (p.commandId !== expected.commandId || p.requestDigest !== expected.requestDigest
      || p.leadId !== current.read.leadId || p.actorId !== current.read.recipientId
      || p.capabilityId !== capability.id || p.capabilityRevision !== capability.revision
      || p.keyVersion !== key.version || Date.parse(p.recordedAt) > now
      || p.changedFields.some(f => !capability.selection.fields.includes(f))) return null;
    if (!timingSafeEqual(Buffer.from(row.proof, 'hex'), Buffer.from(selectiveLeadEditProof(key, 'receipt', p), 'hex'))) return null;
    return p;
  } catch { return null; }
}
