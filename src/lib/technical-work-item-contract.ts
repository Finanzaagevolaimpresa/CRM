import { z } from 'zod';
import { admitsTechnicalAssignmentAction, type CurrentTechnicalAssignmentAdmission,
  type TechnicalAssignmentSelection } from './technical-assignment-contract';
import { technicalTargetReference } from './technical-assignment-display';

// Pure authorization and projection rules used by the item persistence service.
// These pure checks consume freshly locked, journal-verified server snapshots;
// form values cannot establish an assignment, item binding or financial scope.
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const checklistFields = ['title', 'notes', 'status'] as const;
const taskFields = ['title', 'description', 'status', 'priority', 'dueAt'] as const;
function fields<T extends z.ZodTypeAny>(schema: T, min = 0) {
  return z.array(schema).min(min).max(5).refine(values => new Set(values).size === values.length);
}
const identity = { itemId: id, target: technicalTargetReference, contextSha256: hash };
export const technicalWorkItemSelection = z.discriminatedUnion('kind', [
  z.object({ ...identity, recipientId: id, kind: z.literal('ChecklistItem'),
    readableFields: fields(z.enum(checklistFields), 1), editableFields: fields(z.enum(['title', 'notes'])) }).strict(),
  z.object({ ...identity, recipientId: id, kind: z.literal('Task'),
    readableFields: fields(z.enum(taskFields), 1), editableFields: fields(z.enum(['title', 'description', 'priority', 'dueAt'])) }).strict(),
]).superRefine((value, ctx) => {
  const readable = new Set<string>(value.readableFields);
  if (value.editableFields.some(field => !readable.has(field))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Editing requires an explicit readable field' });
  }
});
export type TechnicalWorkItemSelection = z.infer<typeof technicalWorkItemSelection>;
export const technicalWorkItemSelections = z.array(technicalWorkItemSelection).max(20).superRefine((items, ctx) => {
  if (new Set(items.map(item => `${item.kind}:${item.itemId}`)).size !== items.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate item selection' });
  }
});
const bindingSchema = z.object({ ...identity, kind: z.enum(['ChecklistItem', 'Task']),
  active: z.boolean(), archived: z.boolean(), financialRestricted: z.boolean() }).strict();
export type TechnicalWorkItemBinding = z.infer<typeof bindingSchema>;
const title = z.string().trim().min(1).max(200);
const text = z.string().trim().max(5000).nullable();
const dueAt = z.string().datetime({ offset: true }).nullable()
  .transform(value => value === null ? null : new Date(value).toISOString());
const checklistValues = { title, notes: text,
  status: z.enum(['da_richiedere', 'richiesto', 'ricevuto', 'validato', 'non_necessario']) };
const taskValues = { title, description: text, status: z.enum(['aperta', 'in_lavorazione', 'completata', 'annullata']),
  priority: z.enum(['bassa', 'media', 'alta', 'urgente']), dueAt };

function admitted(current: CurrentTechnicalAssignmentAdmission, assignment: TechnicalAssignmentSelection,
  selection: TechnicalWorkItemSelection, binding: TechnicalWorkItemBinding, now: Date) {
  if (!technicalWorkItemSelection.safeParse(selection).success || !bindingSchema.safeParse(binding).success) return false;
  const sameTarget = selection.target.kind === binding.target.kind && selection.target.targetId === binding.target.targetId;
  return sameTarget && selection.recipientId === current.userId && selection.kind === binding.kind && selection.itemId === binding.itemId
    && selection.contextSha256 === binding.contextSha256 && binding.active && !binding.archived && !binding.financialRestricted
    && admitsTechnicalAssignmentAction(current, assignment, { ...selection.target,
      action: selection.kind === 'ChecklistItem' ? 'manage_checklist' : 'manage_deadlines' }, now);
}

/** Exact selected fields only. Parent IDs, assignees, documents and unselected
 * descriptions never enter this projection, even when present in the DB row. */
export function projectTechnicalWorkItem(current: CurrentTechnicalAssignmentAdmission, assignment: TechnicalAssignmentSelection,
  selection: TechnicalWorkItemSelection, binding: TechnicalWorkItemBinding, row: Readonly<Record<string, unknown>>, now: Date) {
  if (!admitted(current, assignment, selection, binding, now)) return null;
  const validators: Record<string, z.ZodTypeAny> = selection.kind === 'ChecklistItem' ? checklistValues : taskValues;
  const result: Record<string, string | null> = {};
  for (const field of selection.readableFields) {
    if (!Object.hasOwn(row, field)) return null;
    const parsed = validators[field].safeParse(row[field]);
    if (!parsed.success) return null;
    result[field] = parsed.data as string | null;
  }
  return result;
}

/** No lifecycle, state transition or document linking in this initial contract.
 * Those commands require separately qualified evidence and atomic persistence. */
export function technicalWorkItemPatch(current: CurrentTechnicalAssignmentAdmission, assignment: TechnicalAssignmentSelection,
  selection: TechnicalWorkItemSelection, binding: TechnicalWorkItemBinding, raw: unknown, now: Date) {
  if (!admitted(current, assignment, selection, binding, now) || !raw || typeof raw !== 'object'
    || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return null;
  const entries = Object.entries(raw), allowed = new Set<string>(selection.editableFields);
  if (entries.length < 1 || entries.length > 4 || Reflect.ownKeys(raw).length !== entries.length
    || entries.some(([field]) => !allowed.has(field))) return null;
  const validators: Record<string, z.ZodTypeAny> = selection.kind === 'ChecklistItem' ? checklistValues : taskValues;
  const result: Record<string, string | null> = {};
  for (const [field, value] of entries) {
    const parsed = validators[field].safeParse(value);
    if (!parsed.success) return null;
    result[field] = parsed.data as string | null;
  }
  return result;
}
