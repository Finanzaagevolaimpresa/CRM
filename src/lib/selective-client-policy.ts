import { z } from 'zod';
import { clientDocumentChoiceSchema, maxClientDocuments } from './selective-client-document-policy';
import { clientCompanyChoiceSchema, maxClientCompanyChoices } from './selective-client-company-policy';

/** Closed read catalogue; later fields and capabilities require a new selection. */
export const selectiveClientFields = {
  displayName: 'Denominazione', type: 'Tipo cliente', status: 'Stato',
} as const;
export type SelectiveClientField = keyof typeof selectiveClientFields;
const field = z.enum(Object.keys(selectiveClientFields) as [SelectiveClientField, ...SelectiveClientField[]]);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const selectiveClientSelectionSchema = z.object({
  version: z.union([z.literal(2), z.literal(3)]).optional(),
  clientId: identifier,
  recipientId: identifier,
  revision: z.number().int().min(0),
  commandId: z.string().uuid(),
  fields: z.array(field).max(Object.keys(selectiveClientFields).length),
  documents: z.array(clientDocumentChoiceSchema).max(maxClientDocuments).optional(),
  companies: z.array(clientCompanyChoiceSchema).max(maxClientCompanyChoices).optional(),
  expiresAt: z.string().datetime().transform(value => new Date(value).toISOString()).nullable(),
}).strict().superRefine((value, context) => {
  // Historical signed payloads remain byte-for-byte canonical: no defaults are
  // inserted. Only explicit V2/V3 carry documents; only V3 carries companies.
  if ((value.version !== undefined) !== (value.documents !== undefined)
    || (value.version === 3) !== (value.companies !== undefined)
    || new Set(value.companies?.map(row => row.companyId)).size !== (value.companies?.length ?? 0)
    || (!value.fields.length && !value.documents?.length && !value.companies?.length)
    || new Set(value.documents?.map(row => row.versionId)).size !== (value.documents?.length ?? 0)) {
    context.addIssue({ code: 'custom', message: 'Scegli campi o singole versioni, senza duplicati.' });
  }
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
  const fields = z.array(field).max(Object.keys(selectiveClientFields).length).parse(chosen);
  if (new Set(fields).size !== fields.length) throw new Error('SELECTIVE_CLIENT_DUPLICATE_FIELD');
  return fields.map(key => {
    const value = client[key];
    if (value !== null && value !== undefined && typeof value !== 'string') throw new Error('SELECTIVE_CLIENT_INVALID_VALUE');
    return { key, label: selectiveClientFields[key], value: value ?? '—' };
  });
}
