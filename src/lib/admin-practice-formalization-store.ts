import type { Prisma, PracticeFormalization, PracticeReadiness } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { operationalLinkModel, OperationalLinkError } from './admin-operational-link-contract';
type Tx = Prisma.TransactionClient;
export const formalizationBindingKeys = ['currentFormalizationId', 'acceptedOfferRevisionId', 'contractId', 'signedDocumentId', 'signedDocumentVersionId'] as const;
type Binding = Record<typeof formalizationBindingKeys[number], string>;
const hash = (v: unknown) => canonicalSha256(JSON.parse(JSON.stringify(v)));
function binding(snapshot: unknown, id: string): Binding {
  const data = snapshot as { id?: unknown; changes?: { model: string; id: string; values: Record<string, unknown> }[] } | null;
  const rows = data && Array.isArray(data.changes) ? data.changes.filter(c => c.model === 'PracticeReadiness' && c.id === id) : [];
  if (rows.length !== 1 || formalizationBindingKeys.some(key => typeof rows[0].values[key] !== 'string' || !rows[0].values[key]))
    throw new OperationalLinkError('CONTEXT');
  return Object.fromEntries(formalizationBindingKeys.map(key => [key, rows[0].values[key]])) as Binding;
}
/** An administrative correction replaces current operational references only.
 * The original formalization, acceptance, signer and start evidence remain facts.
 * Readers validate the whole correction chain for the current original anchor. */
export async function currentPracticeFormalization(tx: Tx, practice: Pick<PracticeReadiness,
  'id' | 'currentFormalizationId' | 'acceptedOfferRevisionId' | 'contractId' | 'signedDocumentId' | 'signedDocumentVersionId'>,
  original: PracticeFormalization | null) {
  if (!practice.currentFormalizationId || !original) return null;
  if (original.id !== practice.currentFormalizationId || original.practiceId !== practice.id) throw new OperationalLinkError('CONTEXT');
  const rows = await tx.adminRecordRevision.findMany({ where: { model: operationalLinkModel, recordId: 'PracticeReadiness:' + practice.id, operation: 'UPDATE' },
    orderBy: [{ createdAt: 'asc' }, { transactionId: 'asc' }, { commandId: 'asc' }] });
  let expected: Binding = { currentFormalizationId: original.id, acceptedOfferRevisionId: original.offerRevisionId, contractId: original.contractId,
    signedDocumentId: original.signedDocumentId, signedDocumentVersionId: original.signedDocumentVersionId };
  let correction: { commandId: string; at: string; actorId: string } | null = null;
  for (const row of rows) {
    if (hash(row.before) !== row.beforeHash || hash(row.after) !== row.afterHash) throw new OperationalLinkError('CONTEXT');
    const before = binding(row.before, practice.id), after = binding(row.after, practice.id);
    if (before.currentFormalizationId !== after.currentFormalizationId) throw new OperationalLinkError('CONTEXT');
    if (after.currentFormalizationId !== original.id) continue;
    if (hash(before) !== hash(expected)) throw new OperationalLinkError('CONTEXT');
    expected = after; correction = { commandId: row.commandId, at: row.createdAt.toISOString(), actorId: row.actorId };
  }
  // Do not attach the original signed payload hash or original author's
  // formalization date to substituted references. Keep that evidence as an
  // explicitly separate immutable source, alongside the current binding.
  const source = { id: original.id, practiceId: original.practiceId, originalFormalization: original };
  if (!correction) return { ...source, offerRevisionId: original.offerRevisionId, offerAcceptanceId: original.offerAcceptanceId,
    contractId: original.contractId, signedDocumentId: original.signedDocumentId, signedDocumentVersionId: original.signedDocumentVersionId,
    administrativeCorrection: null };
  if (formalizationBindingKeys.some(key => practice[key] !== expected[key])) throw new OperationalLinkError('CONTEXT');
  const accepted = await tx.practiceOfferAcceptance.findUnique({ where: { offerRevisionId: expected.acceptedOfferRevisionId } });
  if (!accepted) throw new OperationalLinkError('CONTEXT');
  return { ...source, offerRevisionId: expected.acceptedOfferRevisionId, offerAcceptanceId: accepted.id, contractId: expected.contractId,
    signedDocumentId: expected.signedDocumentId, signedDocumentVersionId: expected.signedDocumentVersionId, administrativeCorrection: correction };
}
