import { z } from 'zod';
import { maxPracticeDocuments, practiceDocumentChoiceSchema } from './selective-practice-document-policy';

/** Closed catalogue. Neither parent records nor future fields are included. */
export const selectivePracticeFields = {
  title: 'Titolo', practiceType: 'Tipo pratica', status: 'Stato', priority: 'Priorità',
  dueDate: 'Scadenza', clientVisibleStatus: 'Stato visibile al cliente',
} as const;
export type SelectivePracticeField = keyof typeof selectivePracticeFields;
const field = z.enum(Object.keys(selectivePracticeFields) as [SelectivePracticeField, ...SelectivePracticeField[]]);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const selectivePracticeSelectionSchema = z.object({
  version: z.literal(2).optional(),
  practiceId: identifier, recipientId: identifier, revision: z.number().int().min(0),
  commandId: z.string().uuid(), fields: z.array(field).max(Object.keys(selectivePracticeFields).length),
  documents: z.array(practiceDocumentChoiceSchema).max(maxPracticeDocuments).optional(),
  expiresAt: z.string().datetime().transform(value => new Date(value).toISOString()).nullable(),
}).strict().superRefine((value, context) => {
  // Do not add defaults to historical HMAC payloads. V1 cannot gain documents.
  if ((value.version === 2) !== (value.documents !== undefined)
    || (!value.fields.length && !value.documents?.length)
    || new Set(value.documents?.map(row => row.versionId)).size !== (value.documents?.length ?? 0)) {
    context.addIssue({ code: 'custom', message: 'Scegli campi o singole versioni, senza duplicati.' });
  }
  if (new Set(value.fields).size !== value.fields.length) {
    context.addIssue({ code: 'custom', message: 'Ogni campo può essere selezionato una sola volta.' });
  }
});
export type SelectivePracticeSelection = z.infer<typeof selectivePracticeSelectionSchema>;
export type SelectivePracticeScope = {
  selectivePracticeIds?: readonly string[];
  selectivePracticeAuditEntityIds?: readonly string[];
};

/** Historical recipient restrictions survive a revoked or expired projection. */
export function isSelectivePractice(scope: SelectivePracticeScope, id?: string | null) {
  const ids = scope.selectivePracticeIds ?? [];
  return ids.length > 0 && (!id || ids.includes(id));
}
export function practiceOutsideSelection(scope: SelectivePracticeScope) {
  return { id: { notIn: [...new Set(scope.selectivePracticeIds ?? [])] } };
}
export function practiceContextOutsideSelection(scope: SelectivePracticeScope) {
  return { OR: [{ technicalPracticeId: null }, { technicalPracticeId: { notIn: [...new Set(scope.selectivePracticeIds ?? [])] } }] };
}

/** Project only the selected scalar values. Date formatting remains deterministic. */
export function practiceFieldProjection(practice: Record<string, unknown>, chosen: readonly SelectivePracticeField[]) {
  const fields = z.array(field).max(Object.keys(selectivePracticeFields).length).parse(chosen);
  if (new Set(fields).size !== fields.length) throw new Error('SELECTIVE_PRACTICE_DUPLICATE_FIELD');
  return fields.map(key => {
    let value = practice[key];
    if (key === 'dueDate' && value != null) {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('SELECTIVE_PRACTICE_INVALID_DATE');
      value = value.toISOString().slice(0, 10);
    }
    if (value != null && typeof value !== 'string') throw new Error('SELECTIVE_PRACTICE_INVALID_VALUE');
    return { key, label: selectivePracticeFields[key], value: value ?? '—' };
  });
}
