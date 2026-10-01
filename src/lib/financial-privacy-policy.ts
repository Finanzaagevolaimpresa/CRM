/** Mandatory role ceiling: assignments and permission overrides cannot widen it. */
export const financialRoles = ['admin', 'amministrazione', 'direzione'] as const;
export function hasFinancialRole(actor: { role: string; active?: boolean }) {
  return actor.active !== false && (financialRoles as readonly string[]).includes(actor.role);
}

// Audit payloads can contain complete contract/payment snapshots.
export const financialPermissions = ['contract.read', 'contract.write', 'payment.read', 'payment.write', 'audit.read'] as const;
export function isFinancialPermission(permission: string) {
  return (financialPermissions as readonly string[]).includes(permission);
}

export type FinancialDocumentMetadata = {
  serviceArea?: string | null; documentCategory?: string | null; type?: string | null;
  title?: string | null; fileName?: string | null; mimeType?: string | null;
};

/** Include legacy free-text classifications; canonical DB bindings are checked separately. */
export function isFinancialDocument(document: FinancialDocumentMetadata) {
  const text = [document.serviceArea, document.documentCategory, document.type, document.title, document.fileName]
    .filter(Boolean).join(' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\.zip$/i.test(document.fileName?.trim() ?? '')
    || [document.mimeType, document.type].some(value => /^(application\/(zip|x-zip-compressed))$/i.test(value ?? ''))
    || document.documentCategory === 'archivio_riservato'
    || /contratt|contract|incaric|pagament|payment|bonific|incass|fattur[ae]|invoice/.test(text)
    || [document.documentCategory, document.type].some(value => /^contabil[ei]$/i.test(value?.trim() ?? ''));
}

export function canAccessFinancialDocumentMetadata(actor: { role: string; active?: boolean }, document: FinancialDocumentMetadata) {
  return hasFinancialRole(actor) || !isFinancialDocument(document);
}

export function operationalServiceStatus(actor: { role: string; active?: boolean }, status: string) {
  return !hasFinancialRole(actor) && status === 'pagato' ? 'disponibile' : status;
}
