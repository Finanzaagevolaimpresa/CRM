import { z } from 'zod';
import { approvedMessageLabels, type ApprovedMessageState } from './approved-communication-contract';

export const ordinaryReceiptSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['RESERVED','CLAIMED','ACCEPTED','NOT_SENT','UNCERTAIN']), createdAt: z.date(),
  outcome: z.enum(['ACCEPTED','NOT_SENT','UNCERTAIN']).nullable(), recordedAt: z.date().nullable(),
}).strict().refine(row => ['RESERVED','CLAIMED'].includes(row.state)
  ? row.outcome === null && row.recordedAt === null : row.outcome === row.state && row.recordedAt !== null);
export type OrdinaryEmailReceipt = z.infer<typeof ordinaryReceiptSchema>;

export const ordinaryReceiptLabels = {
  RESERVED: 'Invio prenotato · senza ricevuta',
  CLAIMED: 'Esito da riconciliare · senza ricevuta',
  ACCEPTED: 'Accettata dal server',
  NOT_SENT: 'Non inviata',
  UNCERTAIN: 'Esito incerto · non ripetere',
} as const;

export function hasBlockingOrdinaryReceipt(receipts: OrdinaryEmailReceipt[]) {
  return receipts.some(row => row.state !== 'NOT_SENT');
}

/** Receipt history can span older versions and an intervening manual attempt.
 * It must never relabel a newer draft/manual operation as SMTP accepted. */
export function communicationDeliveryLabel(state: string, revision: number, receipts: OrdinaryEmailReceipt[],
  manualAttempts: Array<{ createdAt: Date }>) {
  const latest = receipts[0];
  const manualAt = Math.max(-Infinity, ...manualAttempts.map(row => row.createdAt.getTime()));
  const expected = latest?.state === 'ACCEPTED' ? 'SENT' : latest?.state === 'NOT_SENT' ? 'ERROR'
    : latest?.state === 'UNCERTAIN' ? 'UNCERTAIN' : 'SENDING';
  return latest && latest.revision === revision && latest.createdAt.getTime() > manualAt && state === expected
    ? ordinaryReceiptLabels[latest.state] : approvedMessageLabels[state as ApprovedMessageState];
}
