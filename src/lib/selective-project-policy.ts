import { z } from 'zod';

/** Closed catalogue. Adding a field here never adds it to an existing grant. */
export const selectiveProjectFields = {
  title: 'Titolo', description: 'Descrizione', totalInvestment: 'Investimento',
  requestedAmount: 'Importo richiesto', startTiming: 'Tempi di avvio', region: 'Regione',
  province: 'Provincia', sector: 'Settore', status: 'Stato', priority: 'Priorità',
  technicalOwnerName: 'Responsabile tecnico · nome', commercialOwnerName: 'Referente commerciale · nome',
} as const;
export type SelectiveProjectField = keyof typeof selectiveProjectFields;
const field = z.enum(Object.keys(selectiveProjectFields) as [SelectiveProjectField, ...SelectiveProjectField[]]);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const selectiveSelectionSchema = z.object({
  projectId: identifier,
  recipientId: identifier,
  revision: z.number().int().min(0),
  fields: z.array(field).max(Object.keys(selectiveProjectFields).length),
  documents: z.array(z.object({ versionId: identifier, download: z.boolean() }).strict()).max(50),
  expiresAt: z.string().datetime().transform(value => new Date(value).toISOString()).nullable(),
}).strict().superRefine((value, context) => {
  if (!value.fields.length && !value.documents.length) context.addIssue({ code: 'custom', message: 'Seleziona almeno un elemento.' });
  if (new Set(value.fields).size !== value.fields.length || new Set(value.documents.map(row => row.versionId)).size !== value.documents.length) {
    context.addIssue({ code: 'custom', message: 'Selezione duplicata.' });
  }
});
export type SelectiveSelection = z.infer<typeof selectiveSelectionSchema>;

/** A restriction remains after revocation/expiry; legacy access must not return. */
export type SelectiveProjectScope = {
  technicalTaskIds?: readonly string[];
  technicalChecklistIds?: readonly string[];
  selectiveProjectIds?: readonly string[];
  selectiveServiceIds?: readonly string[];
  selectiveDocumentIds?: readonly string[];
  selectiveContractIds?: readonly string[];
  selectiveOfferIds?: readonly string[];
  selectiveAuditEntityIds?: readonly string[];
};
type Context = {
  projectId?: string | null; clientServiceId?: string | null;
  project?: { id?: string } | null;
  clientService?: { id?: string; projectId?: string | null; project?: { id?: string } | null } | null;
};
export function isSelectiveProject(scope: SelectiveProjectScope, projectId?: string | null) {
  return Boolean(projectId && scope.selectiveProjectIds?.includes(projectId));
}
export function hasSelectiveContext(scope: SelectiveProjectScope, context: Context) {
  return [context.projectId, context.project?.id, context.clientService?.projectId, context.clientService?.project?.id]
    .some(id => isSelectiveProject(scope, id))
    || [context.clientServiceId, context.clientService?.id].some(id => Boolean(id && scope.selectiveServiceIds?.includes(id)));
}
export function projectOutsideSelection(scope: SelectiveProjectScope) {
  return { id: { notIn: [...(scope.selectiveProjectIds ?? [])] } };
}
export function serviceOutsideSelection(scope: SelectiveProjectScope) {
  return { id: { notIn: [...(scope.selectiveServiceIds ?? [])] } };
}
export function documentOutsideSelection(scope: SelectiveProjectScope) {
  return { id: { notIn: [...(scope.selectiveDocumentIds ?? [])] } };
}
export function contextOutsideSelection(scope: SelectiveProjectScope) {
  return { AND: [
    { OR: [{ projectId: null }, { projectId: { notIn: [...(scope.selectiveProjectIds ?? [])] } }] },
    { OR: [{ clientServiceId: null }, { clientServiceId: { notIn: [...(scope.selectiveServiceIds ?? [])] } }] },
  ] };
}

export function selectiveAuditAllowed(scope: SelectiveProjectScope, row: { entityId?: string | null; before?: unknown; after?: unknown }) {
  const ids = scope.selectiveAuditEntityIds ?? scope.selectiveProjectIds ?? [];
  if (!ids.length) return true;
  const text = JSON.stringify([row.entityId, row.before, row.after]);
  return !ids.some(id => text.includes(id));
}

export function projectFieldProjection(project: Record<string, unknown>, fields: readonly SelectiveProjectField[]) {
  return fields.map(key => ({ key, label: selectiveProjectFields[key], value: project[key] == null ? '—' : String(project[key]) }));
}
