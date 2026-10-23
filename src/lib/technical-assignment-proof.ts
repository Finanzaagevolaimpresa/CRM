import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { admitsTechnicalAssignmentRead, boundedAssignmentExpiry, technicalAssignmentSelection, type CurrentTechnicalAssignmentAdmission } from './technical-assignment-contract';

const generation = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const technicalAssignmentPayload = z.object({
  protocol: z.literal('TECHNICAL_ASSIGNMENT_V1'),
  id: z.string().uuid(), revision: generation, commandId: z.string().uuid(),
  targetId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  selection: technicalAssignmentSelection,
  approvedById: z.string().min(1).max(128), approvedAt: z.string().datetime(),
  authorityRevision: generation, actorEpoch: generation, recipientEpoch: generation,
  contextSha256: hash, keyVersion: generation,
}).strict();
export type TechnicalAssignmentPayload = z.infer<typeof technicalAssignmentPayload>;
type Purpose = 'assignment' | 'preview' | 'receipt' | 'work-preview' | 'work-receipt';

/** Separate domain from sharing, email approval and the legacy responsibility
 * history. A valid signature from another function cannot authorize an action. */
export function technicalAssignmentProof(key: PrivilegedStepUpKey, purpose: Purpose, value: unknown) {
  if (!Number.isSafeInteger(key.version) || key.version < 1 || key.secret.length < 32
      || !['assignment', 'preview', 'receipt', 'work-preview', 'work-receipt'].includes(purpose)) throw new Error('TECHNICAL_ASSIGNMENT_PROOF_INVALID');
  return createHmac('sha256', key.secret).update(`FAI_TECHNICAL_ASSIGNMENT_V1:${purpose}:${key.version}:`)
    .update(canonicalJson(value)).digest('hex');
}

export type CurrentTechnicalAssignmentProof = CurrentTechnicalAssignmentAdmission & {
  assignmentId: string; recordReadAllowed: boolean;
  authority: { purpose: 'technical-assignment'; userId: string; enabled: boolean;
    revision: number; actorEpoch: number; actorActive: boolean; actorRole: string; assignmentWriteAllowed: boolean };
};

/** Pure verifier only. Persistence, registry session locks, current permissions,
 * canonical parent scope and the personal authority must be read under the same
 * transaction before using it. This module creates no authority or assignment. */
export function readTechnicalAssignmentProof(raw: unknown, key: PrivilegedStepUpKey,
  current: CurrentTechnicalAssignmentProof, now: Date): TechnicalAssignmentPayload | null {
  try {
    const row = z.object({ payload: technicalAssignmentPayload, proof: hash,
      revokedAt: z.string().datetime().nullable() }).strict().parse(raw);
    const p = row.payload, a = current.authority;
    if (row.revokedAt !== null || !current.recordReadAllowed
        || a.purpose !== 'technical-assignment' || !a.enabled || !a.actorActive
        || a.actorRole !== 'admin' || !a.assignmentWriteAllowed
        || p.approvedById !== a.userId || p.approvedById === p.selection.userId
        || p.authorityRevision !== a.revision || p.actorEpoch !== a.actorEpoch
        || p.id !== current.assignmentId || p.revision !== current.currentRevision
        || p.recipientEpoch !== current.currentRecipientEpoch
        || p.contextSha256 !== current.currentContextSha256 || p.keyVersion !== key.version
        || Date.parse(p.approvedAt) > now.getTime()
        || !boundedAssignmentExpiry(p.selection.expiresAt, new Date(p.approvedAt))
        || !admitsTechnicalAssignmentRead(current, p.selection, { targetId:p.targetId, kind:p.selection.kind }, now)) return null;
    const expected = technicalAssignmentProof(key, 'assignment', p);
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(row.proof, 'hex')) ? p : null;
  } catch { return null; }
}
