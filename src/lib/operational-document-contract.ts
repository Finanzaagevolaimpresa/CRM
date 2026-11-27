import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { isTechnicalAccount } from './technical-confidentiality';
import type { OrdinaryEmailReceipt } from './ordinary-email-receipt';

export function attestedProformaReceipts(revision: number, receipts: readonly Pick<OrdinaryEmailReceipt, 'revision' | 'outcome' | 'recordedAt'>[]) {
  return receipts.flatMap(row => row.revision === revision && row.outcome && row.recordedAt
    ? [{ outcome: row.outcome, recordedAt: row.recordedAt.toISOString() }] : []);
}

export const documentTemplateModel = 'OperationalDocumentTemplate';
export const documentFields = ['denominazione', 'indirizzo', 'partita_iva', 'codice_fiscale', 'email', 'telefono',
  'firmatario', 'servizio', 'attivita', 'imponibile', 'iva', 'totale', 'rate', 'scadenza'] as const;
export type DocumentField = typeof documentFields[number];
export const documentFieldLabels: Record<DocumentField, string> = { denominazione: 'Denominazione', indirizzo: 'Indirizzo',
  partita_iva: 'Partita IVA', codice_fiscale: 'Codice fiscale', email: 'Email', telefono: 'Telefono', firmatario: 'Firmatario',
  servizio: 'Servizio', attivita: 'Attività', imponibile: 'Imponibile', iva: 'Importo IVA', totale: 'Totale', rate: 'Rate', scadenza: 'Scadenza' };
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const documentKind = z.enum(['CONTRACT', 'QUOTE', 'PROPOSAL', 'PROFORMA']);
export const documentKindLabels = { CONTRACT: 'Contratto', QUOTE: 'Preventivo', PROPOSAL: 'Proposta', PROFORMA: 'Proforma' };
export class OperationalDocumentError extends Error {
  constructor(public readonly code: 'DENIED' | 'STALE' | 'MISSING' | 'CONFLICT' | 'TEMPLATE' | 'UNCONFIRMED' | 'INVALID_AMOUNT' | 'PDF_CHARACTER') {
    super('OPERATIONAL_DOCUMENT_' + code);
  }
}
export function canUseOperationalDocuments(actor: { role: string; active?: boolean; technicalRestricted?: boolean; permissionOverrides?: readonly { permission: string; allowed: boolean }[] }) {
  return actor.active !== false && !isTechnicalAccount(actor) && ['admin', 'commerciale', 'amministrazione'].includes(actor.role)
    && !actor.permissionOverrides?.some(row => ['contract.read', 'contract.write'].includes(row.permission) && !row.allowed);
}
export function templateTokens(body: string): DocumentField[] {
  const tokens = [...body.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1]);
  if (tokens.some(token => !documentFields.includes(token as DocumentField)) || /[{}]/.test(body.replace(/\{\{[^{}]+\}\}/g, ''))) {
    throw new OperationalDocumentError('TEMPLATE');
  }
  return [...new Set(tokens)] as DocumentField[];
}
export function normalizeTemplateLineEndings(body: string): string {
  return body.replace(/\r\n?/g, '\n');
}
export const documentTemplateSnapshot = z.object({ id: z.string().uuid(), revision: z.number().int().positive(),
  title: z.string().trim().min(3).max(160), kind: documentKind, body: z.string().trim().min(10).max(16000),
  required: z.array(z.enum(documentFields)).max(documentFields.length), state: z.enum(['DRAFT', 'PUBLISHED']),
  copiedFrom: z.string().uuid().nullable(), updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  try { templateTokens(value.body); } catch { context.addIssue({ code: 'custom', message: 'Il modello contiene campi non riconosciuti.' }); }
  if (new Set(value.required).size !== value.required.length) context.addIssue({ code: 'custom', message: 'Campo richiesto ripetuto.' });
});
export type DocumentTemplate = z.infer<typeof documentTemplateSnapshot>;
export const templateCommand = z.object({ commandId: z.string().uuid(), templateId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(),
  operation: z.enum(['SAVE', 'PUBLISH', 'DUPLICATE']), title: z.string().trim().min(3).max(160), kind: documentKind,
  body: z.string().transform(normalizeTemplateLineEndings).pipe(z.string().trim().min(10).max(16000)), required: z.array(z.enum(documentFields)).max(documentFields.length),
  sourceTemplateId: z.string().uuid().optional(), approved: z.boolean(),
}).strict();
export const documentContextInput = z.object({ leadId: id.optional(), clientId: id.optional() }).strict()
  .refine(value => Boolean(value.leadId) !== Boolean(value.clientId));
export type DocumentContextInput = z.infer<typeof documentContextInput>;
export const draftDocumentCommand = z.object({ commandId: z.string().uuid(), context: documentContextInput,
  templateCommandId: z.string().uuid(), serviceRevisionId: z.string().uuid().optional(), contractId: id.optional(),
  sourceHash: digest, choices: z.record(z.enum(documentFields), z.string().max(5000)), termsConfirmed: z.boolean(),
}).strict().refine(value => Boolean(value.serviceRevisionId) !== Boolean(value.contractId));
export type DraftDocumentCommand = z.infer<typeof draftDocumentCommand>;
export const documentDecisionCommand = z.object({ commandId: z.string().uuid(), documentId: z.string().uuid(), contentHash: digest,
  confirmed: z.literal(true) }).strict();
export const proformaCommand = documentDecisionCommand.extend({ templateCommandId: z.string().uuid(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
export type FieldCandidate = { value: string; source: string };
export type DocumentCandidates = Record<DocumentField, FieldCandidate[]>;
export function emptyDocumentCandidates(): DocumentCandidates {
  return Object.fromEntries(documentFields.map(field => [field, [] as FieldCandidate[]])) as DocumentCandidates;
}
export function addDocumentCandidate(candidates: DocumentCandidates, field: DocumentField, value: unknown, source: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text && !candidates[field].some(item => item.value === text)) candidates[field].push({ value: text, source });
}
export function resolveDocumentFields(candidates: DocumentCandidates, choices: Partial<Record<DocumentField, string>>) {
  const values = {} as Record<DocumentField, string>, sources = {} as Record<DocumentField, string>, conflicts: DocumentField[] = [];
  for (const field of documentFields) {
    const options = candidates[field], chosen = choices[field]?.trim() ?? '';
    if (options.length > 1 && !chosen) { values[field] = ''; sources[field] = 'Scelta richiesta'; conflicts.push(field); continue; }
    if (chosen && options.length && !options.some(option => option.value === chosen)) throw new OperationalDocumentError('CONFLICT');
    const selected = options.find(option => option.value === chosen) ?? (options.length === 1 ? options[0] : null);
    values[field] = selected?.value ?? chosen;
    sources[field] = selected?.source ?? (chosen ? 'Integrato dall’operatore sul caso' : 'Dato mancante');
  }
  return { values, sources, conflicts };
}
export const storedDocumentSnapshot = z.object({ version: z.literal(1), templateTitle: z.string(), templateRevision: z.number().int().positive(),
  templateBody: z.string(), fields: z.record(z.enum(documentFields), z.string()), sources: z.record(z.enum(documentFields), z.string()),
  missing: z.array(z.enum(documentFields)), conflicts: z.array(z.enum(documentFields)), termsConfirmed: z.boolean(),
  serviceRevisionId: z.string().nullable(), contractId: z.string().nullable(), sourceDocumentId: z.string().nullable(),
  companySourceIds: z.array(id).optional(), signerSourceIds: z.array(id).optional(), usesPaymentSchedule: z.boolean().optional(),
  taxStatus: z.enum(['REVIEW_REQUIRED', 'OPERATOR_REVIEWED']), fiscalStatus: z.literal('NOT_ISSUED'), deliveryStatus: z.literal('NOT_SENT'),
}).strict();
export type StoredDocumentSnapshot = z.infer<typeof storedDocumentSnapshot>;
export function renderDocumentTemplate(body: string, fields: Record<DocumentField, string>) {
  templateTokens(body);
  return body.replace(/\{\{([^{}]+)\}\}/g, (_, field: DocumentField) => fields[field] || `[MANCANTE: ${documentFieldLabels[field]}]`);
}
export function missingDocumentFields(template: Pick<DocumentTemplate, 'required'> & Partial<Pick<DocumentTemplate, 'body'>>, fields: Record<DocumentField, string>) {
  const required = [...new Set([...template.required, ...(template.body ? templateTokens(template.body) : []), ...(['denominazione', 'indirizzo', 'servizio', 'imponibile', 'iva', 'totale', 'rate'] as const)])];
  if (!fields.partita_iva?.trim() && !fields.codice_fiscale?.trim()) required.push('codice_fiscale');
  return required
    .filter(field => !fields[field]?.trim());
}
export function moneyCents(value: string) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) throw new OperationalDocumentError('INVALID_AMOUNT');
  const [whole, decimals = ''] = value.split('.');
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
}
export const moneyText = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
export function catalogAmounts(net: string, vatRateBps: number) {
  if (!Number.isSafeInteger(vatRateBps) || vatRateBps < 0 || vatRateBps > 10000) throw new OperationalDocumentError('INVALID_AMOUNT');
  const taxable = moneyCents(net), vat = Math.round(taxable * vatRateBps / 10000);
  return { taxable: moneyText(taxable), vat: moneyText(vat), total: moneyText(taxable + vat) };
}
export function validateDocumentAmounts(fields: Record<DocumentField, string>) {
  if (moneyCents(fields.imponibile) + moneyCents(fields.iva) !== moneyCents(fields.totale)) throw new OperationalDocumentError('INVALID_AMOUNT');
}
export function proformaDedupKey(documentId: string, contentHash: string, dueDate: string) {
  const day = new Date(dueDate + 'T00:00:00.000Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== dueDate) throw new OperationalDocumentError('MISSING');
  return canonicalSha256({ type: 'OPERATIONAL_PROFORMA_V1', documentId, contentHash, dueDate });
}
