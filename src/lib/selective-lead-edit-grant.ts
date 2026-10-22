import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { readSelectiveLeadGrant, type SelectiveLeadGrantAdmission } from './selective-lead-grant';
import { selectiveLeadEditSelectionSchema, validateLeadEditSelection } from './selective-lead-edit-policy';

const generation = z.number().int().positive().max(2_147_483_647);
const identifier = z.string().min(1).max(128);
export const selectiveLeadEditPayloadSchema = z.object({
  protocol: z.literal('SELECTIVE_LEAD_EDIT_GRANT_V1'),
  id: z.string().uuid(), revision: generation, selection: selectiveLeadEditSelectionSchema,
  approvedById: identifier, approvedAt: z.string().datetime(), authorityRevision: generation,
  actorEpoch: generation, recipientEpoch: generation, leadEpoch: generation, keyVersion: generation,
}).strict();
export type SelectiveLeadEditPayload = z.infer<typeof selectiveLeadEditPayloadSchema>;
type Purpose = 'grant' | 'preview' | 'command-preview' | 'receipt';

/** Domain separation: a signed read grant or its receipt can never grant edits. */
export function selectiveLeadEditProof(key: PrivilegedStepUpKey, purpose: Purpose, value: unknown) {
  if (!Number.isSafeInteger(key.version) || key.version <= 0 || key.secret.length < 32
    || !['grant', 'preview', 'command-preview', 'receipt'].includes(purpose)) {
    throw new Error('SELECTIVE_LEAD_EDIT_PROOF_INVALID');
  }
  return createHmac('sha256', key.secret)
    .update(`FAI_SELECTIVE_LEAD_EDIT_V1:${purpose}:${key.version}:`)
    .update(canonicalJson(value)).digest('hex');
}

export type SelectiveLeadEditAdmission = {
  capabilityId: string; capabilityRevision: number;
  authority: { purpose: 'lead-edit'; enabled: boolean; userId: string; revision: number;
    actorEpoch: number; actorActive: boolean; actorIsAdmin: boolean; writeAllowed: boolean };
  read: SelectiveLeadGrantAdmission;
  recipientWriteDenied: boolean;
  leadConverted: boolean;
};

/** No read-only authority fallback. Every call needs a still-valid signed read
 * grant plus a separate active editing authority, current epochs and binding.
 * Caller must establish all live facts, session and journal under DB locks. */
export function readSelectiveLeadEditGrant(raw: unknown, rawRead: unknown, key: PrivilegedStepUpKey,
  current: SelectiveLeadEditAdmission, now: number) {
  try {
    const read = readSelectiveLeadGrant(rawRead, key, current.read, now);
    if (!read) return null;
    const row = z.object({ payload: selectiveLeadEditPayloadSchema,
      proof: z.string().regex(/^[a-f0-9]{64}$/), revokedAt: z.string().datetime().nullable() }).strict().parse(raw);
    const p = row.payload, a = current.authority;
    if (row.revokedAt !== null || p.id !== current.capabilityId || p.revision !== current.capabilityRevision
      || p.revision !== p.selection.revision + 1 || p.keyVersion !== key.version
      || a.purpose !== 'lead-edit' || a.enabled !== true || a.actorActive !== true
      || a.actorIsAdmin !== true || a.writeAllowed !== true || current.recipientWriteDenied !== false
      || current.leadConverted !== false || p.approvedById === current.read.recipientId
      || p.approvedById !== a.userId || p.approvedById !== read.approvedById
      || p.authorityRevision !== a.revision || p.actorEpoch !== a.actorEpoch
      || p.actorEpoch !== current.read.authority.actorEpoch
      || p.recipientEpoch !== current.read.recipientEpoch || p.leadEpoch !== current.read.leadEpoch
      || Date.parse(p.approvedAt) > now) return null;
    validateLeadEditSelection(p.selection, read, (rawRead as { proof: string }).proof, now);
    const expected = selectiveLeadEditProof(key, 'grant', p);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(row.proof, 'hex'))) return null;
    return p;
  } catch { return null; }
}
