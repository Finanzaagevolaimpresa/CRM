import type { Prisma } from '@prisma/client';
import { canAccessFinancialDocumentMetadata, hasFinancialRole, type FinancialDocumentMetadata } from './financial-privacy-policy';

type Db = Pick<Prisma.TransactionClient, 'contract' | 'payment' | 'practiceFormalization'>;
type Actor = { role: string; active?: boolean };

/** Misleading classifications must not expose documents bound to financial records. */
export async function filterFinancialDocuments<T extends FinancialDocumentMetadata & { id: string }>(db: Db, actor: Actor, documents: T[]): Promise<T[]> {
  if (hasFinancialRole(actor)) return documents;
  const candidates = documents.filter(document => canAccessFinancialDocumentMetadata(actor, document));
  const restricted = new Set<string>();
  for (let offset = 0; offset < candidates.length; offset += 200) {
    const ids = candidates.slice(offset, offset + 200).map(document => document.id);
    const [contracts, payments, formalizations] = await Promise.all([
      db.contract.findMany({ where: { signedDocumentId: { in: ids } }, select: { signedDocumentId: true } }),
      db.payment.findMany({ where: { accountingDocumentId: { in: ids } }, select: { accountingDocumentId: true } }),
      db.practiceFormalization.findMany({ where: { signedDocumentId: { in: ids } }, select: { signedDocumentId: true } }),
    ]);
    for (const row of [...contracts, ...formalizations]) if (row.signedDocumentId) restricted.add(row.signedDocumentId);
    for (const row of payments) if (row.accountingDocumentId) restricted.add(row.accountingDocumentId);
  }
  return candidates.filter(document => !restricted.has(document.id));
}

export async function canAccessFinancialDocument(db: Db, actor: Actor, document: FinancialDocumentMetadata & { id: string }) {
  return (await filterFinancialDocuments(db, actor, [document])).length === 1;
}
