/** Canonical technical acquisitions must remain outside ordinary document
 * access, including global-role and dossier-review fallbacks. An explicit
 * current personal or selective admission is a separate service decision.
 * Unknown future technical markers also fail closed for legacy readers. */
export const technicalDocumentPrivateVisibility = 'technical_admin_private_v1' as const;

export function ordinaryDocumentVisibilityAllows(visibilityLevel: unknown): boolean {
  return typeof visibilityLevel === 'string' && visibilityLevel.length > 0
    && !visibilityLevel.startsWith('technical_');
}

/** Group on visibility as well as client in SQL, then apply the same admission
 * rule as ordinary readers. SQL LIKE wildcards must not reinterpret the marker. */
export function ordinaryDocumentCountsByClient(groups: ReadonlyArray<{
  clientId: string | null; visibilityLevel: string; _count: { _all: number };
}>): Map<string, number> {
  const result = new Map<string, number>();
  for (const group of groups) {
    if (group.clientId && ordinaryDocumentVisibilityAllows(group.visibilityLevel)) {
      result.set(group.clientId, (result.get(group.clientId) ?? 0) + group._count._all);
    }
  }
  return result;
}
