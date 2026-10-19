import { z } from 'zod';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { practiceFieldProjection, selectivePracticeSelectionSchema } from './selective-practice-policy';
import { verifySelectivePracticeProof } from './selective-practice-proof';

const generation = z.number().int().positive().safe();
const identifier = z.string().min(1).max(128);
export const selectivePracticeGrantPayloadSchema = z.object({
  id: z.string().uuid(), selection: selectivePracticeSelectionSchema, revision: generation,
  approvedById: identifier, approvedAt: z.string().datetime(), authorityRevision: generation,
  actorEpoch: generation, recipientEpoch: generation, practiceEpoch: generation, contextHash: z.string().regex(/^[a-f0-9]{64}$/), keyVersion: generation,
}).strict();
export type SelectivePracticeGrantPayload = z.infer<typeof selectivePracticeGrantPayloadSchema>;

export type SelectivePracticeGrantAdmission = {
  practiceId: string; recipientId: string; revision: number;
  authority: { enabled: boolean; userId: string; revision: number; actorEpoch: number; actorActive: boolean };
  recipientActive: boolean; recipientEpoch: number; practiceEpoch: number; practiceOperational: boolean; contextHash: string;
};

/** Pure grant verification, never an admission to the ordinary record route.
 * The caller must obtain fresh authority, recipient, practice, parent and session state
 * under the same transaction locks as grant mutation. Historical exclusions
 * remain in force when this function denies the selected projection. */
export function readSelectivePracticeGrant(raw: unknown, key: PrivilegedStepUpKey,
  current: SelectivePracticeGrantAdmission, now: number) {
  try {
    const row = z.object({ payload: selectivePracticeGrantPayloadSchema,
      proof: z.string().regex(/^[a-f0-9]{64}$/), revokedAt: z.string().datetime().nullable(),
    }).strict().parse(raw);
    const p = row.payload;
    if (!Number.isSafeInteger(now) || now < 0 || row.revokedAt !== null
      || !current.authority.enabled || !current.authority.actorActive || !current.recipientActive || !current.practiceOperational
      || p.selection.practiceId !== current.practiceId || p.selection.recipientId !== current.recipientId
      || p.approvedById === current.recipientId || p.approvedById !== current.authority.userId
      || p.authorityRevision !== current.authority.revision || p.actorEpoch !== current.authority.actorEpoch
      || p.recipientEpoch !== current.recipientEpoch || p.practiceEpoch !== current.practiceEpoch
      || p.contextHash !== current.contextHash
      || p.revision !== current.revision || p.revision !== p.selection.revision + 1
      || p.keyVersion !== key.version || new Date(p.approvedAt).getTime() > now
      || (p.selection.expiresAt && new Date(p.selection.expiresAt).getTime() <= now)
      || !verifySelectivePracticeProof(key, 'grant', p, row.proof)) return null;
    return p;
  } catch { return null; }
}

/** Only a successfully verified grant may reach this closed-field projection.
 * Related records, files, comments and future fields are never copied. */
export function selectivePracticeGrantProjection(practice: Record<string, unknown>, grant: SelectivePracticeGrantPayload) {
  if (practice.id !== grant.selection.practiceId) throw new Error('SELECTIVE_PRACTICE_PROJECTION_CONTEXT');
  return practiceFieldProjection(practice, grant.selection.fields);
}
