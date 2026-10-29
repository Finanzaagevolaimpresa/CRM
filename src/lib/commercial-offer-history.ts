import { Prisma } from '@prisma/client';

const terms = ['leadId', 'clientId', 'title', 'description', 'services', 'includedActivities',
  'taxableAmount', 'vatAmount', 'totalAmount', 'validUntil', 'operationalConditions', 'commercialProposal'];
/** Follow-up and declared outcomes remain possible; issued commercial terms
 * must be replaced by a new draft rather than silently rewritten in place. */
export function assertCommercialOfferTermsPreserved(before: Record<string, unknown>, after: Record<string, unknown>, hasRevision: boolean) {
  if (before.status === 'bozza' && !hasRevision) return;
  const canonical = (key: string, value: unknown) => value == null || value === '' ? ''
    : key.endsWith('Amount') ? new Prisma.Decimal(String(value)).toFixed(2)
      : key === 'validUntil' ? new Date(String(value)).toISOString() : String(value);
  if ((after.status === 'bozza' && before.status !== 'bozza') || terms.some(key => canonical(key, before[key]) !== canonical(key, after[key])))
    throw new Error('Le condizioni di questa offerta sono già storiche. Crea una nuova bozza; note e seguito commerciale restano modificabili.');
}
