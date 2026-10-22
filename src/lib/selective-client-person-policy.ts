import { z } from 'zod';

/** Each choice addresses one exact company/person relationship. A person's
 * other relationships and unchosen names are never part of the projection. */
export const selectiveClientPersonFields = {
  firstName: 'Nome', lastName: 'Cognome', email: 'Email', phone: 'Telefono',
  taxCode: 'Codice fiscale', role: 'Ruolo nell’azienda', ownershipPercent: 'Quota di partecipazione',
} as const;
export type SelectiveClientPersonField = keyof typeof selectiveClientPersonFields;
export type ClientPersonChoice = {
  membershipId: string; companyId: string; personId: string; fields: SelectiveClientPersonField[];
};
export type ClientPersonOption = {
  membershipId: string; companyId: string; personId: string; personName: string; companyName: string;
};
export const maxClientPersonChoices = 20;
const keys = Object.keys(selectiveClientPersonFields) as SelectiveClientPersonField[];
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const clientPersonChoiceSchema = z.object({
  membershipId: identifier, companyId: identifier, personId: identifier,
  fields: z.array(z.enum(keys as [SelectiveClientPersonField, ...SelectiveClientPersonField[]])).min(1).max(keys.length)
    .refine(fields => new Set(fields).size === fields.length),
}).strict();

export function parseClientPersonChoices(input: unknown): ClientPersonChoice[] {
  const parsed = z.array(clientPersonChoiceSchema).max(maxClientPersonChoices).parse(input);
  if (new Set(parsed.map(row => row.membershipId)).size !== parsed.length) throw new Error('INVALID_PERSON_CHOICES');
  return parsed.map(row => ({ ...row, fields: keys.filter(key => row.fields.includes(key)) }));
}

/** Decimal values arrive as explicit decimal strings from the DB adapter. Never
 * coerce an arbitrary object or convert precision to a JavaScript float. */
function ownership(value: unknown): string {
  if (value === null) return '—';
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,30})?$/.test(value)) throw new Error('PERSON_VALUE_DENIED');
  const [whole, fraction = ''] = value.split('.');
  if (BigInt(whole) > BigInt(100) || (whole === '100' && /[1-9]/.test(fraction))) throw new Error('PERSON_VALUE_DENIED');
  return `${value.replace('.', ',')} %`;
}

export function projectSelectedClientPeople(clientId: string, records: readonly Record<string, unknown>[], input: unknown) {
  identifier.parse(clientId);
  return parseClientPersonChoices(input).map(choice => {
    const matches = records.filter(row => row.membershipId === choice.membershipId), row = matches[0];
    if (matches.length !== 1 || row.clientId !== clientId || row.companyId !== choice.companyId
      || row.personId !== choice.personId || row.companyDeletedAt !== null || row.personDeletedAt !== null) {
      throw new Error('PERSON_CONTEXT_DENIED');
    }
    return { membershipId: choice.membershipId, fields: choice.fields.map(key => {
      if (!Object.hasOwn(row, key)) throw new Error('PERSON_VALUE_DENIED');
      const value = row[key];
      if (key === 'ownershipPercent') return { key, label: selectiveClientPersonFields[key], value: ownership(value) };
      if (value !== null && typeof value !== 'string') throw new Error('PERSON_VALUE_DENIED');
      return { key, label: selectiveClientPersonFields[key], value: value ?? '—' };
    }) };
  });
}
