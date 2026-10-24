import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const generation = z.number().int().positive().max(2_147_483_647);
function fields<T extends z.ZodTypeAny>(schema: T, minimum = 0) {
  return z.array(schema).min(minimum).max(5).refine(values => new Set(values).size === values.length);
}
const identity = { itemId: id, generation, scopeGeneration: generation, scopeSha256: z.string().regex(/^[a-f0-9]{64}$/) };
// This optional selection is retained inside the existing personal decision.
// Absence stays absent when old V1 journals are parsed: no changed HMAC payload.
export const technicalWorkItemGrant = z.discriminatedUnion('kind', [
  z.object({ ...identity, kind: z.literal('ChecklistItem'),
    readableFields: fields(z.enum(['title', 'notes', 'status']), 1),
    editableFields: fields(z.enum(['title', 'notes'])) }).strict(),
  z.object({ ...identity, kind: z.literal('Task'),
    readableFields: fields(z.enum(['title', 'description', 'status', 'priority', 'dueAt']), 1),
    editableFields: fields(z.enum(['title', 'description', 'priority', 'dueAt'])) }).strict(),
]).superRefine((item, ctx) => {
  if (item.scopeGeneration > item.generation || item.editableFields.some(field => !item.readableFields.some(read => read === field))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Current item scope and explicit readable fields are required' });
  }
});
export type TechnicalWorkItemGrant = z.infer<typeof technicalWorkItemGrant>;
export const technicalWorkItemGrants = z.array(technicalWorkItemGrant).max(20).refine(items =>
  new Set(items.map(item => `${item.kind}:${item.itemId}`)).size === items.length, 'Duplicate item selection');

export const technicalItemFieldLabels: Record<string, string> = {
  title: 'Titolo', notes: 'Note tecniche', description: 'Descrizione', status: 'Stato', priority: 'Priorità', dueAt: 'Scadenza',
};
export function technicalItemFields(kind: TechnicalWorkItemGrant['kind']) {
  const all = kind === 'Task' ? ['title', 'description', 'status', 'priority', 'dueAt'] : ['title', 'notes', 'status'];
  return all.map(key => ({ key, label: technicalItemFieldLabels[key], editable: key !== 'status' }));
}
