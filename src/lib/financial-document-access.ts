import type { Prisma } from '@prisma/client';
import type { FinancialDocumentMetadata } from './financial-privacy-policy';
import { canAccessFinancialDocumentMetadata, financialReadAccess, type FinancialActor } from './financial-access';

type Db = Pick<Prisma.TransactionClient, 'contract' | 'payment' | 'practiceFormalization'>;

/** Misleading classifications must not expose documents bound to financial records. */
export async function filterFinancialDocuments<T extends FinancialDocumentMetadata & { id: string }>(db: Db, actor: FinancialActor, documents: T[]): Promise<T[]> {
  const allowed = financialReadAccess(actor);
  if (allowed.contract && allowed.payment) return documents;
  const candidates = documents.filter(document => canAccessFinancialDocumentMetadata(actor, document));
  const restricted = new Set<string>();
  for (let offset = 0; offset < candidates.length; offset += 200) {
    const ids = candidates.slice(offset, offset + 200).map(document => document.id);
    const [contracts, payments, formalizations] = await Promise.all([
      allowed.contract ? [] : db.contract.findMany({ where: { signedDocumentId: { in: ids } }, select: { signedDocumentId: true } }),
      allowed.payment ? [] : db.payment.findMany({ where: { accountingDocumentId: { in: ids } }, select: { accountingDocumentId: true } }),
      allowed.contract ? [] : db.practiceFormalization.findMany({ where: { signedDocumentId: { in: ids } }, select: { signedDocumentId: true } }),
    ]);
    for (const row of [...contracts, ...formalizations]) if (row.signedDocumentId) restricted.add(row.signedDocumentId);
    for (const row of payments) if (row.accountingDocumentId) restricted.add(row.accountingDocumentId);
  }
  return candidates.filter(document => !restricted.has(document.id));
}

export async function canAccessFinancialDocument(db: Db, actor: FinancialActor, document: FinancialDocumentMetadata & { id: string }) {
  return (await filterFinancialDocuments(db, actor, [document])).length === 1;
}
