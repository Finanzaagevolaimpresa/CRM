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

export function sameCommercialOrigin(a: CommercialOriginSnapshot, b: z.infer<typeof commercialOriginInput>) {
  return a.acquiredById === b.acquiredById && a.contractedById === b.contractedById
    && a.sourceReference === b.sourceReference && a.reason === b.reason;
}
