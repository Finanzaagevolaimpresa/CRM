import { z } from 'zod';

/** Closed read catalogue; later fields and capabilities require a new selection. */
export const selectiveClientFields = {
  displayName: 'Denominazione', type: 'Tipo cliente', status: 'Stato',
} as const;
export type SelectiveClientField = keyof typeof selectiveClientFields;
const field = z.enum(Object.keys(selectiveClientFields) as [SelectiveClientField, ...SelectiveClientField[]]);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const selectiveClientSelectionSchema = z.object({
  clientId: identifier,
  recipientId: identifier,
  revision: z.number().int().min(0),
  commandId: z.string().uuid(),
  fields: z.array(field).min(1).max(Object.keys(selectiveClientFields).length),
  expiresAt: z.string().datetime().transform(value => new Date(value).toISOString()).nullable(),
}).strict().superRefine((value, context) => {
  if (new Set(value.fields).size !== value.fields.length) {
    context.addIssue({ code: 'custom', message: 'Ogni campo può essere selezionato una sola volta.' });
  }
});
export type SelectiveClientSelection = z.infer<typeof selectiveClientSelectionSchema>;

/** Include every historical recipient perimeter, even when its projection is denied. */
export type SelectiveClientScope = {
  selectiveClientIds?: readonly string[];
  selectiveClientAuditEntityIds?: readonly string[];
  selectiveClientCompanyIds?: readonly string[];
  selectiveClientPersonIds?: readonly string[];
};

type ClientIdentity = { id?: string | null };
type ClientLink = { clientId?: string | null; companyId?: string | null; client?: ClientIdentity | null };
export type SelectiveClientContext = ClientLink & {
  company?: ClientLink | null;
  project?: (ClientLink & { company?: ClientLink | null }) | null;
  clientService?: (ClientLink & { project?: (ClientLink & { company?: ClientLink | null }) | null }) | null;
};

export function isSelectiveClient(scope: SelectiveClientScope, id?: string | null) {
  const ids = scope.selectiveClientIds ?? [];
  // An incomplete record identity must not bypass an existing restriction.
  return ids.length > 0 && (!id || ids.includes(id));
}

export function clientOutsideSelection(scope: SelectiveClientScope) {
  return { id: { notIn: [...new Set(scope.selectiveClientIds ?? [])] } };
}

/** Check every supplied relationship. A conflicting outer identity must never
 * hide a selected client carried by an inner project, service or company.
 * This is an exclusion only: false does not authorize an incomplete context. */
export function hasSelectiveClientContext(scope: SelectiveClientScope, context: SelectiveClientContext) {
  const selected = scope.selectiveClientIds ?? [];
  const links = [context, context.company, context.project, context.project?.company,
    context.clientService, context.clientService?.project, context.clientService?.project?.company];
  return links.some(link => [link?.clientId, link?.client?.id]
    .some(id => typeof id === 'string' && selected.includes(id))
    || Boolean(link?.companyId && scope.selectiveClientCompanyIds?.includes(link.companyId)));
}

/** For models with a nullable, direct clientId. Indirect-only resources require
 * their own joined predicate; this filter alone does not authorize a record. */
export function clientContextOutsideSelection(scope: SelectiveClientScope) {
  return { OR: [{ clientId: null }, { clientId: { notIn: [...new Set(scope.selectiveClientIds ?? [])] } }] };
}

/** Use only on records carrying both nullable clientId and companyId. */
export function companyClientContextOutsideSelection(scope: SelectiveClientScope) {
  return { AND: [clientContextOutsideSelection(scope), {
    OR: [{ companyId: null }, { companyId: { notIn: [...new Set(scope.selectiveClientCompanyIds ?? [])] } }],
  }] };
}

export function selectiveClientAuditAllowed(scope: SelectiveClientScope,
  row: { entityId?: string | null; before?: unknown; after?: unknown }) {
  const ids = [...new Set([...(scope.selectiveClientIds ?? []), ...(scope.selectiveClientAuditEntityIds ?? [])])];
  if (!ids.length) return true;
  const text = JSON.stringify([row.entityId, row.before, row.after]);
  return !ids.some(id => text.includes(id));
}

/** Only chosen scalar values leave this boundary; never spread the source record. */
export function clientFieldProjection(client: Record<string, unknown>, chosen: readonly SelectiveClientField[]) {
  const fields = z.array(field).min(1).max(Object.keys(selectiveClientFields).length).parse(chosen);
  if (new Set(fields).size !== fields.length) throw new Error('SELECTIVE_CLIENT_DUPLICATE_FIELD');
  return fields.map(key => {
    const value = client[key];
    if (value !== null && value !== undefined && typeof value !== 'string') throw new Error('SELECTIVE_CLIENT_INVALID_VALUE');
    return { key, label: selectiveClientFields[key], value: value ?? '—' };
  });
}
