import { z } from 'zod';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { leadFieldProjection, selectiveLeadSelectionSchema } from './selective-lead-policy';
import { verifySelectiveLeadProof } from './selective-lead-proof';

const generation = z.number().int().positive().safe();
const identifier = z.string().min(1).max(128);
export const selectiveLeadGrantPayloadSchema = z.object({
  id: z.string().uuid(), selection: selectiveLeadSelectionSchema, revision: generation,
  approvedById: identifier, approvedAt: z.string().datetime(), authorityRevision: generation,
  actorEpoch: generation, recipientEpoch: generation, leadEpoch: generation, keyVersion: generation,
}).strict();
export type SelectiveLeadGrantPayload = z.infer<typeof selectiveLeadGrantPayloadSchema>;

export type SelectiveLeadGrantAdmission = {
  leadId: string; recipientId: string; revision: number;
  authority: { enabled: boolean; userId: string; revision: number; actorEpoch: number; actorActive: boolean };
  recipientActive: boolean; recipientEpoch: number; leadEpoch: number; leadOperational: boolean;
};

/** Pure grant verification, never an admission to the ordinary record route.
 * The caller must obtain fresh authority, recipient, lead and session state
 * under the same transaction locks as grant mutation. Historical exclusions
 * remain in force when this function denies the selected projection. */
export function readSelectiveLeadGrant(raw: unknown, key: PrivilegedStepUpKey,
  current: SelectiveLeadGrantAdmission, now: number) {
  try {
    const row = z.object({ payload: selectiveLeadGrantPayloadSchema,
      proof: z.string().regex(/^[a-f0-9]{64}$/), revokedAt: z.string().datetime().nullable(),
    }).strict().parse(raw);
    const p = row.payload;
    if (!Number.isSafeInteger(now) || now < 0 || row.revokedAt !== null
      || !current.authority.enabled || !current.authority.actorActive || !current.recipientActive || !current.leadOperational
      || p.selection.leadId !== current.leadId || p.selection.recipientId !== current.recipientId
      || p.approvedById === current.recipientId || p.approvedById !== current.authority.userId
      || p.authorityRevision !== current.authority.revision || p.actorEpoch !== current.authority.actorEpoch
      || p.recipientEpoch !== current.recipientEpoch || p.leadEpoch !== current.leadEpoch
      || p.revision !== current.revision || p.revision !== p.selection.revision + 1
      || p.keyVersion !== key.version || new Date(p.approvedAt).getTime() > now
      || (p.selection.expiresAt && new Date(p.selection.expiresAt).getTime() <= now)
      || !verifySelectiveLeadProof(key, 'grant', p, row.proof)) return null;
    return p;
  } catch { return null; }
}

/** Only a successfully verified grant may reach this closed-field projection.
 * Related records, files, comments and future fields are never copied. */
export function selectiveLeadGrantProjection(lead: Record<string, unknown>, grant: SelectiveLeadGrantPayload) {
  if (lead.id !== grant.selection.leadId) throw new Error('SELECTIVE_LEAD_PROJECTION_CONTEXT');
  return leadFieldProjection(lead, grant.selection.fields);
}
