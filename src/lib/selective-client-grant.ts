import { z } from 'zod';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { clientFieldProjection, selectiveClientSelectionSchema } from './selective-client-policy';
import { verifySelectiveClientProof } from './selective-client-proof';
import { clientDocumentChoicesMatch, clientDocumentSnapshotSchema, maxClientDocuments } from './selective-client-document-policy';

const generation = z.number().int().positive().safe();
const identifier = z.string().min(1).max(128);
export const selectiveClientGrantPayloadSchema = z.object({
  id: z.string().uuid(), selection: selectiveClientSelectionSchema, revision: generation,
  approvedById: identifier, approvedAt: z.string().datetime(), authorityRevision: generation,
  actorEpoch: generation, recipientEpoch: generation, clientEpoch: generation, keyVersion: generation,
  documents: z.array(clientDocumentSnapshotSchema).max(maxClientDocuments).optional(),
}).strict().superRefine((value, context) => {
  if ((value.selection.version === 2) !== (value.documents !== undefined)
    || !clientDocumentChoicesMatch(value.selection.documents ?? [], value.documents ?? [])) {
    context.addIssue({ code: 'custom', message: 'Le versioni approvate non corrispondono alla selezione.' });
  }
});
export type SelectiveClientGrantPayload = z.infer<typeof selectiveClientGrantPayloadSchema>;

export type SelectiveClientGrantAdmission = {
  clientId: string; recipientId: string; revision: number;
  authority: { enabled: boolean; userId: string; revision: number; actorEpoch: number; actorActive: boolean };
  recipientActive: boolean; recipientEpoch: number; clientEpoch: number; clientOperational: boolean;
};

/** Pure grant verification, never an admission to the ordinary record route.
 * The caller must obtain fresh authority, recipient, client and session state
 * under the same transaction locks as grant mutation. Historical exclusions
 * remain in force when this function denies the selected projection. */
export function readSelectiveClientGrant(raw: unknown, key: PrivilegedStepUpKey,
  current: SelectiveClientGrantAdmission, now: number) {
  try {
    const row = z.object({ payload: selectiveClientGrantPayloadSchema,
      proof: z.string().regex(/^[a-f0-9]{64}$/), revokedAt: z.string().datetime().nullable(),
    }).strict().parse(raw);
    const p = row.payload;
    if (!Number.isSafeInteger(now) || now < 0 || row.revokedAt !== null
      || !current.authority.enabled || !current.authority.actorActive || !current.recipientActive || !current.clientOperational
      || p.selection.clientId !== current.clientId || p.selection.recipientId !== current.recipientId
      || p.approvedById === current.recipientId || p.approvedById !== current.authority.userId
      || p.authorityRevision !== current.authority.revision || p.actorEpoch !== current.authority.actorEpoch
      || p.recipientEpoch !== current.recipientEpoch || p.clientEpoch !== current.clientEpoch
      || p.revision !== current.revision || p.revision !== p.selection.revision + 1
      || p.keyVersion !== key.version || new Date(p.approvedAt).getTime() > now
      || (p.selection.expiresAt && new Date(p.selection.expiresAt).getTime() <= now)
      || !verifySelectiveClientProof(key, 'grant', p, row.proof)) return null;
    return p;
  } catch { return null; }
}

/** Only a successfully verified grant may reach this closed-field projection.
 * Related records, files, comments and future fields are never copied. */
export function selectiveClientGrantProjection(client: Record<string, unknown>, grant: SelectiveClientGrantPayload) {
  if (client.id !== grant.selection.clientId) throw new Error('SELECTIVE_CLIENT_PROJECTION_CONTEXT');
  return clientFieldProjection(client, grant.selection.fields);
}
