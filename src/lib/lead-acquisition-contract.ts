import { calculateBusinessInboxRecordHash } from './business-event-backbone';
import { MAX_LEAD_EVENT_BYTES, parseLeadSubmittedEventV1 } from './lead-event-contract';

export type AcquisitionState = 'RECEIVED' | 'PROCESSING' | 'RETRY' | 'ERROR' | 'AMBIGUOUS' | 'LINKED';
export const acquisitionLabels: Record<AcquisitionState, string> = {
  RECEIVED: 'Ricevuta CRM · da elaborare', PROCESSING: 'In elaborazione', RETRY: 'Tentativo successivo previsto',
  ERROR: 'Errore · da riconciliare', AMBIGUOUS: 'Identità da verificare', LINKED: 'Richiesta collegata',
};

export function acquisitionState(state: string, failures: number, projection: string | null): AcquisitionState {
  if (projection === 'REVIEW_REQUIRED') return 'AMBIGUOUS';
  if (['PROJECTED_NEW', 'RESOLVED_NEW', 'RESOLVED_EXISTING'].includes(projection ?? '')) return 'LINKED';
  if (state === 'LEASED') return 'PROCESSING';
  if (state === 'AVAILABLE') return failures > 0 ? 'RETRY' : 'RECEIVED';
  return 'ERROR';
}

export function verifiedAcquisitionEvent(row: { id: string; envelopeJson: string; recordHash: string; createdAt: Date }) {
  if (Buffer.byteLength(row.envelopeJson, 'utf8') > MAX_LEAD_EVENT_BYTES) return null;
  try {
    const event = parseLeadSubmittedEventV1(JSON.parse(row.envelopeJson));
    return calculateBusinessInboxRecordHash(row.id, event, row.createdAt) === row.recordHash ? event : null;
  } catch { return null; }
}
