/** Browser-safe presentation only. Authoritative validation remains on the
 * server. An explicit event offset avoids silent browser/DST assumptions. */
export const historicalSourceLabels = { EMAIL: 'Email già intercorsa', PHONE: 'Telefonata già avvenuta',
  MEETING: 'Incontro già avvenuto', EXISTING_DOCUMENT: 'Documento esistente' } as const;
export const historicalOffsetLabels = { '+01:00': 'UTC+01:00 · ora solare italiana',
  '+02:00': 'UTC+02:00 · ora legale italiana', '+00:00': 'UTC' } as const;

export function historicalEventInstant(local: string, offset: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(local) || !(offset in historicalOffsetLabels)) return null;
  const raw = `${local}:00.000${offset}`;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return null;
  const offsetMinutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6));
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  if (shifted.toISOString().slice(0, 16) !== local) return null;
  return date.toISOString();
}
export type HistoricalContactViewInput = Readonly<{
  protocol: 'N14_HISTORICAL_CONTACT_V1'; commandId: string; leadId: string; expectedInboxVersion: number;
  expectedAssignmentId: string; occurredAt: string; source: keyof typeof historicalSourceLabels;
  evidenceReference: string; attested: true;
}>;
export type HistoricalContactViewPreview = Readonly<{ token: string; input: HistoricalContactViewInput;
  initializedAt: string; previewedAt: string; expiresAt: string; slaEffect: 'NO_REWRITE' }>;
export type HistoricalContactViewReceipt = Readonly<{ id: string; input: HistoricalContactViewInput;
  recordedAt: string; inboxVersionAfter: number }>;

export type HistoricalContactViewResult =
  | { state: 'PREVIEW'; preview: HistoricalContactViewPreview }
  | { state: 'RECORDED'; receipt: HistoricalContactViewReceipt }
  | { state: 'NOT_OBSERVED' | 'DENIED'; message: string };
