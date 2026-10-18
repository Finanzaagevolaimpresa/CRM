import { z } from 'zod';

/** Closed read catalogue; later fields and capabilities require a new selection. */
export const selectiveLeadFields = {
  firstName: 'Nome', lastName: 'Cognome', companyName: 'Azienda', contactPerson: 'Referente',
  email: 'Email', phone: 'Telefono', region: 'Regione', province: 'Provincia', city: 'Comune',
  interest: 'Interesse dichiarato', status: 'Stato', priority: 'Priorità',
} as const;
export type SelectiveLeadField = keyof typeof selectiveLeadFields;
const field = z.enum(Object.keys(selectiveLeadFields) as [SelectiveLeadField, ...SelectiveLeadField[]]);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const selectiveLeadSelectionSchema = z.object({
  leadId: identifier,
  recipientId: identifier,
  revision: z.number().int().min(0),
  commandId: z.string().uuid(),
  fields: z.array(field).min(1).max(Object.keys(selectiveLeadFields).length),
  expiresAt: z.string().datetime().transform(value => new Date(value).toISOString()).nullable(),
}).strict().superRefine((value, context) => {
  if (new Set(value.fields).size !== value.fields.length) {
    context.addIssue({ code: 'custom', message: 'Ogni campo può essere selezionato una sola volta.' });
  }
});
export type SelectiveLeadSelection = z.infer<typeof selectiveLeadSelectionSchema>;

/** Include every historical recipient perimeter, even when its projection is denied. */
export type SelectiveLeadScope = {
  selectiveLeadIds?: readonly string[];
  selectiveLeadAuditEntityIds?: readonly string[];
  selectiveLeadIntakeIds?: readonly string[];
  selectiveLeadInboxEventIds?: readonly string[];
};

export function isSelectiveLead(scope: SelectiveLeadScope, id?: string | null) {
  const ids = scope.selectiveLeadIds ?? [];
  // An incomplete record identity must not bypass an existing restriction.
  return ids.length > 0 && (!id || ids.includes(id));
}

export function leadOutsideSelection(scope: SelectiveLeadScope) {
  return { id: { notIn: [...new Set(scope.selectiveLeadIds ?? [])] } };
}

/** Only chosen scalar values leave this boundary; never spread the source record. */
export function leadFieldProjection(lead: Record<string, unknown>, chosen: readonly SelectiveLeadField[]) {
  const fields = z.array(field).min(1).max(Object.keys(selectiveLeadFields).length).parse(chosen);
  if (new Set(fields).size !== fields.length) throw new Error('SELECTIVE_LEAD_DUPLICATE_FIELD');
  return fields.map(key => {
    const value = lead[key];
    if (value !== null && value !== undefined && typeof value !== 'string') throw new Error('SELECTIVE_LEAD_INVALID_VALUE');
    return { key, label: selectiveLeadFields[key], value: value ?? '—' };
  });
}
