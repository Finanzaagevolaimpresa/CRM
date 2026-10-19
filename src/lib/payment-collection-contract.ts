import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const paymentCollectionCommand = z.object({
  commandId: z.string().uuid(), clientId: id, paymentId: id,
  documentVersionId: id, collectedAt: z.string().datetime(), confirmed: z.literal(true),
}).strict();
export type PaymentCollectionCommand = z.infer<typeof paymentCollectionCommand>;
export type PaymentCollectionPreview = {
  digest: string; client: string; contract: string; amount: string; collectedAt: string;
  document: string; documentVersion: number; project: string | null;
};
export class PaymentCollectionError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'INVALID' | 'CLOSED' | 'DOCUMENT') { super(code); }
}
