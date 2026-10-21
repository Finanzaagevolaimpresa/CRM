import { z } from 'zod';

/** Closed catalogue for an explicitly confirmed client selection.
 * This module is a projection boundary, not an authorization check. Callers
 * must separately lock and recheck the current signed selection and epochs.
 * Historical V1/V2 grants never acquire these fields. */
export const selectiveClientCompanyFields = {
  name: 'Denominazione azienda', vatNumber: 'Partita IVA', taxCode: 'Codice fiscale',
  rea: 'REA', pec: 'PEC', legalAddress: 'Sede legale', operatingAddress: 'Sede operativa',
  region: 'Regione', province: 'Provincia', city: 'Comune', legalForm: 'Forma giuridica',
  atecoCode: 'Codice ATECO', atecoDescription: 'Descrizione ATECO',
} as const;
export type SelectiveClientCompanyField = keyof typeof selectiveClientCompanyFields;
export type ClientCompanyChoice = { companyId: string; fields: SelectiveClientCompanyField[] };
export const maxClientCompanyChoices = 20;
const keys = Object.keys(selectiveClientCompanyFields) as SelectiveClientCompanyField[];
export const clientCompanyChoiceSchema = z.object({
  companyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  fields: z.array(z.enum(keys as [SelectiveClientCompanyField, ...SelectiveClientCompanyField[]])).min(1).max(keys.length)
    .refine(fields => new Set(fields).size === fields.length),
}).strict();
const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value);

export function parseClientCompanyChoices(input: unknown): ClientCompanyChoice[] {
  if (!Array.isArray(input) || input.length > maxClientCompanyChoices) throw new Error('INVALID_COMPANY_CHOICES');
  const seen = new Set<string>();
  return input.map(value => {
    if (!object(value) || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 'companyId') || !Object.hasOwn(value, 'fields')
      || !identifier(value.companyId) || seen.has(value.companyId)
      || !Array.isArray(value.fields) || !value.fields.length || value.fields.length > keys.length
      || !value.fields.every(key => typeof key === 'string' && Object.hasOwn(selectiveClientCompanyFields, key))
      || new Set(value.fields).size !== value.fields.length) throw new Error('INVALID_COMPANY_CHOICES');
    seen.add(value.companyId);
    const chosen = value.fields as SelectiveClientCompanyField[];
    return { companyId: value.companyId, fields: keys.filter(key => chosen.includes(key)) };
  });
}

/** Only explicit company IDs are projected. A new company in the same client
 * never inherits a selection; even its name is absent unless explicitly chosen. */
export function projectSelectedClientCompanies(clientId: string, records: readonly Record<string, unknown>[], input: unknown) {
  if (!identifier(clientId)) throw new Error('COMPANY_CONTEXT_DENIED');
  const choices = parseClientCompanyChoices(input);
  return choices.map(choice => {
    const matches = records.filter(row => row.id === choice.companyId);
    const row = matches[0];
    if (matches.length !== 1 || row.clientId !== clientId || row.deletedAt !== null) throw new Error('COMPANY_CONTEXT_DENIED');
    return { companyId: choice.companyId, fields: choice.fields.map(key => {
      const value = row[key];
      if (!Object.hasOwn(row, key) || (value !== null && typeof value !== 'string')) throw new Error('COMPANY_VALUE_DENIED');
      return { key, label: selectiveClientCompanyFields[key], value: value ?? '—' };
    }) };
  });
}
