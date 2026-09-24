import { z } from 'zod';

const optionalId = z.string().trim().max(128).transform(value => value || null);
export const commercialOriginInput = z.object({
  clientId: z.string().trim().min(1).max(128),
  expectedEntryId: optionalId,
  acquiredById: optionalId,
  contractedById: optionalId,
  sourceReference: z.string().trim().min(3).max(300),
  reason: z.string().trim().min(10).max(1000),
}).strict();

export const commercialOriginSnapshot = z.object({
  protocol: z.literal('R05_COMMERCIAL_ORIGIN_V1'),
  clientId: z.string().min(1).max(128),
  revision: z.number().int().min(1).max(2_147_483_647),
  predecessorId: z.string().min(1).max(128).nullable(),
  acquiredById: z.string().min(1).max(128).nullable(),
  contractedById: z.string().min(1).max(128).nullable(),
  sourceReference: z.string().min(3).max(300),
  reason: z.string().min(10).max(1000),
}).strict();

export const commercialOriginEvents = ['client_commercial_origin_recorded', 'client_commercial_origin_corrected'] as const;
export type CommercialOriginSnapshot = z.infer<typeof commercialOriginSnapshot>;

// AuditLog's existing database sanitizer accepts these metadata keys and still redacts sensitive text.
// Keep the UI contract separate from the persisted audit vocabulary; never relax the shared sanitizer.
export function encodeCommercialOrigin(snapshot: CommercialOriginSnapshot) {
  return { type: snapshot.protocol, clientId: snapshot.clientId, version: snapshot.revision,
    predecessorId: snapshot.predecessorId, acquiredById: snapshot.acquiredById, contractedById: snapshot.contractedById,
    source: snapshot.sourceReference, reason: snapshot.reason };
}
export const commercialOriginStored = z.object({
  type: z.literal('R05_COMMERCIAL_ORIGIN_V1'), clientId: commercialOriginSnapshot.shape.clientId,
  version: commercialOriginSnapshot.shape.revision, predecessorId: commercialOriginSnapshot.shape.predecessorId,
  acquiredById: commercialOriginSnapshot.shape.acquiredById, contractedById: commercialOriginSnapshot.shape.contractedById,
  source: commercialOriginSnapshot.shape.sourceReference, reason: commercialOriginSnapshot.shape.reason,
}).strict().transform(row => ({ protocol: row.type, clientId: row.clientId, revision: row.version,
  predecessorId: row.predecessorId, acquiredById: row.acquiredById, contractedById: row.contractedById,
  sourceReference: row.source, reason: row.reason }));

export function sameCommercialOrigin(a: CommercialOriginSnapshot, b: z.infer<typeof commercialOriginInput>) {
  return a.acquiredById === b.acquiredById && a.contractedById === b.contractedById
    && a.sourceReference === b.sourceReference && a.reason === b.reason;
}
