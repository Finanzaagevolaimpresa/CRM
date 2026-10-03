import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';

export class RecordProfileError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'SHARED_PERSON' | 'DUPLICATE_LEAD') { super(code); }
}
const id = z.string().min(1).max(128);
const text = (max = 200) => z.string().trim().max(max).transform(value => value || null);
const required = z.string().trim().min(1).max(200);
const email = text(254).refine(value => !value || z.string().email().safeParse(value).success, 'Indirizzo email non valido');
const date = text(10).refine(value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value), 'Data non valida')
  .transform(value => value ? new Date(`${value}T00:00:00.000Z`) : null);
const amount = text(18).refine(value => !value || /^\d{1,14}(\.\d{1,2})?$/.test(value), 'Inserire un importo non negativo con massimo due decimali');
export const clientTypes = ['persona_fisica', 'ditta_individuale', 'societa', 'professionista', 'soggetto_da_costituire', 'associazione', 'altro'] as const;
export const clientProfileSchema = z.object({ displayName: required, type: z.enum(clientTypes), notes: text(5000) }).strict();
export const leadProfileSchema = z.object({ firstName: z.string().trim().max(200), lastName: z.string().trim().max(200), companyName: text(), contactPerson: text(),
  email, phone: text(64), region: text(100), province: text(100), city: text(100) }).strict();
export const companyProfileSchema = z.object({ name: required, vatNumber: text(32), taxCode: text(32), rea: text(64), pec: email,
  legalAddress: text(500), operatingAddress: text(500), region: text(100), province: text(100), city: text(100), legalForm: text(100),
  atecoCode: text(32), atecoDescription: text(500), incorporationDate: date, activityStartDate: date, activityStatus: text(100),
  employees: text(10).refine(value => !value || (/^\d+$/.test(value) && Number(value) <= 2147483647), 'Numero intero non negativo richiesto')
    .transform(value => value === null ? null : Number(value)),
  annualRevenue: amount, durcStatus: text(100), taxRegime: text(100), notes: text(5000) }).strict();
export const personProfileSchema = z.object({ firstName: required, lastName: required, email, phone: text(64), taxCode: text(32), notes: text(5000),
  role: required, ownershipPercent: amount.refine(value => value === null || Number(value) <= 100, 'La quota deve essere tra 0 e 100') }).strict();
const record = z.object({ id, expectedVersion: z.string().datetime() });
export const profileCommandSchema = z.discriminatedUnion('kind', [
  record.extend({ kind: z.literal('lead'), data: leadProfileSchema }).strict(),
  record.extend({ kind: z.literal('client'), data: clientProfileSchema }).strict(),
  record.extend({ kind: z.literal('company'), data: companyProfileSchema }).strict(),
  z.object({ kind: z.literal('new-company'), id: z.string().uuid(), clientId: id, data: companyProfileSchema }).strict(),
  z.object({ kind: z.literal('new-person'), id: z.string().uuid(), companyId: id, data: personProfileSchema }).strict(),
  z.object({ kind: z.literal('person'), id, companyId: id, expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), data: personProfileSchema }).strict(),
]);
export function personProfileVersion(person: object, membership: object) {
  return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify({ person, membership })))).digest('hex');
}
