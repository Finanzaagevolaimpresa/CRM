import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const historicalPaymentModel = 'PaymentHistoricalAttestation';
export const historicalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '1900-01-01';
}, 'Indica un giorno di calendario valido.');
export const historicalPaymentCommand = z.object({
  commandId: z.string().uuid(), clientId: id, paymentId: id,
  expectedAmount: z.string().regex(/^[0-9]+\.[0-9]{2}$/),
  effectiveDay: historicalDay, attestedOn: historicalDay,
  declarant: z.string().trim().min(2).max(120),
  provenance: z.string().trim().min(10).max(1000),
  reason: z.string().trim().min(10).max(2000),
  expiresAt: z.string().datetime(), confirmed: z.literal(true),
}).strict();
export type HistoricalPaymentCommand = z.infer<typeof historicalPaymentCommand>;
export const historicalPaymentSource = z.object({
  type: z.literal('OWNER_ADMIN_ATTESTATION_V1'), effectiveDay: historicalDay,
  precision: z.literal('DAY'), effectiveTime: z.null(), declaredMethod: z.null(),
  attestedOn: historicalDay, declarant: z.string().min(2).max(120),
  provenance: z.string().min(10).max(1000), bankEvidenceVerified: z.literal(false),
  storageNormalization: z.literal('UTC_MIDNIGHT_NOT_ACTUAL_CREDIT_TIME'),
}).strict();
export type HistoricalPaymentSource = z.infer<typeof historicalPaymentSource>;
export type HistoricalPaymentPreview = {
  digest: string; client: string; contract: string; amount: string;
  effectiveDay: string; attestedOn: string; declarant: string; provenance: string; reason: string;
  previousStatus: string; previousMethod: string | null; expiresAt: string;
};
export type HistoricalPaymentReceipt = {
  commandId: string; paymentId: string; clientId: string; amount: string;
  source: HistoricalPaymentSource; reason: string; recordedAt: string;
  actorId: string; actorName: string; previousStatus: string; currentStatus: string;
};
export class HistoricalPaymentError extends Error {
  constructor(readonly code: 'DENIED' | 'CLOSED' | 'INVALID' | 'STALE' | 'EXPIRED') { super(code); }
}
export function historicalDayLabel(day: string) {
  historicalDay.parse(day);
  return day.slice(8, 10) + '/' + day.slice(5, 7) + '/' + day.slice(0, 4);
}
