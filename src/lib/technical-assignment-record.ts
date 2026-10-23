import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { technicalAssignmentPayload } from './technical-assignment-proof';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const storedSchema = z.object({
  id: z.string().uuid(), kind: z.enum(['Project', 'TechnicalPractice']),
  projectId: id.nullable(), practiceId: id.nullable(), recipientId: id,
  revision: z.number().int().positive().max(2_147_483_647),
  payload: technicalAssignmentPayload, proof: z.string().regex(/^[a-f0-9]{64}$/),
  revokedAt: z.date().nullable(),
}).strict();

/** Decode an actual DB row, never an HTTP selection. Matching relational and
 * signed-payload identities is only structural validation, not authorization.
 * Current registry/session, authority, scope and retained journal are mandatory. */
export function decodeTechnicalAssignmentRecord(raw: unknown) {
  const parsed = storedSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data, p = row.payload;
  const targetId = row.kind === 'Project' ? row.projectId : row.practiceId;
  if (!targetId || (row.kind === 'Project' ? row.practiceId !== null : row.projectId !== null)
    || p.id !== row.id || p.revision !== row.revision || p.targetId !== targetId
    || p.selection.kind !== row.kind || p.selection.userId !== row.recipientId) return null;
  const revokedAt = row.revokedAt?.toISOString() ?? null;
  const record = { id: row.id, kind: row.kind, targetId, recipientId: row.recipientId,
    revision: row.revision, payload: p, proof: row.proof, revokedAt };
  return { ...record, stateSha256: canonicalSha256(record) };
}

export type StoredTechnicalAssignment = NonNullable<ReturnType<typeof decodeTechnicalAssignmentRecord>>;
