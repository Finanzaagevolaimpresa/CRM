import { z } from 'zod';

// Domain preparation only: persistence, fresh admission and routes must be
// integrated before this contract can authorize any operational action.
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const revision = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });

export const technicalAssignmentActions = ['update_fields', 'update_status', 'manage_checklist', 'manage_deadlines', 'request_admin', 'upload_document'] as const;
export const projectTechnicalFields = ['title', 'description', 'status'] as const;
export const practiceTechnicalFields = ['title', 'practiceType', 'status', 'priority', 'dueDate', 'targetEntity', 'targetPortal', 'protocolNumber', 'submittedAt', 'nextClientUpdateAt', 'clientVisibleStatus', 'integrationRequestNote'] as const;
export const projectEditableTechnicalFields = ['title', 'description'] as const;
export const practiceEditableTechnicalFields = ['title', 'practiceType', 'priority', 'dueDate', 'targetEntity', 'targetPortal', 'protocolNumber', 'submittedAt', 'nextClientUpdateAt', 'clientVisibleStatus', 'integrationRequestNote'] as const;

function distinct<T extends z.ZodTypeAny>(schema: T, maximum: number, minimum = 0) {
  return z.array(schema).min(minimum).max(maximum).refine(values => new Set(values).size === values.length, 'Duplicate selections are not admitted');
}
const documentVersion = z.object({
  documentId: id, fileId: id, version: z.number().int().positive().safe(),
  contentSha256: hash, contextSha256: hash, allowDownload: z.boolean(),
}).strict();
const selectionBase = {
  userId: id,
  responsibility: z.enum(['responsabile', 'co_responsabile', 'supporto']),
  actions: distinct(z.enum(technicalAssignmentActions), technicalAssignmentActions.length, 1),
  expiresAt: instant,
  documents: z.array(documentVersion).max(20),
};
const projectScope = z.object({
  ...selectionBase, kind: z.literal('Project'),
  readableFields: distinct(z.enum(projectTechnicalFields), projectTechnicalFields.length, 1),
  editableFields: distinct(z.enum(projectEditableTechnicalFields), projectEditableTechnicalFields.length),
}).strict();
const practiceScope = z.object({
  ...selectionBase, kind: z.literal('TechnicalPractice'),
  readableFields: distinct(z.enum(practiceTechnicalFields), practiceTechnicalFields.length, 1),
  editableFields: distinct(z.enum(practiceEditableTechnicalFields), practiceEditableTechnicalFields.length),
}).strict();
export const technicalAssignmentSelection = z.discriminatedUnion('kind', [projectScope, practiceScope]).superRefine((value, ctx) => {
  if (value.actions.includes('update_fields') !== (value.editableFields.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Editing requires explicit fields and the separate action', path: ['editableFields'] });
  }
  const readable = new Set<string>(value.readableFields);
  if (value.editableFields.some(field => !readable.has(field)) || (value.actions.includes('update_status') && !readable.has('status'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An editable field or status must also be readable', path: ['readableFields'] });
  }
  const versions = value.documents.map(d => `${d.documentId}:${d.version}`);
  if (new Set(versions).size !== versions.length || new Set(value.documents.map(d => d.fileId)).size !== value.documents.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A document version may be selected once', path: ['documents'] });
  }
});
export type TechnicalAssignmentSelection = z.infer<typeof technicalAssignmentSelection>;

export const technicalAssignmentCommand = z.object({
  commandId: z.string().uuid(), targetId: id, expectedRevision: revision,
  expectedContextSha256: hash, expectedRecipientEpoch: revision,
  selection: technicalAssignmentSelection,
  reason: z.string().trim().min(3).max(500),
}).strict();
export const technicalAssignmentRevocation = z.object({
  commandId: z.string().uuid(), assignmentId: id, expectedRevision: revision,
  expectedContextSha256: hash, reason: z.string().trim().min(3).max(500),
}).strict();

export function boundedAssignmentExpiry(value: string, now: Date, maximumDays = 90) {
  const parsed = instant.safeParse(value), current = now.getTime();
  if (!parsed.success || !Number.isFinite(current) || !Number.isInteger(maximumDays) || maximumDays < 1 || maximumDays > 90) return false;
  const expires = Date.parse(parsed.data);
  return expires > current && expires <= current + maximumDays * 86_400_000;
}

// Called only with snapshots freshly locked/read by the future persistence layer.
// A cookie, submitted form or cached row is not evidence of these facts.
export type CurrentTechnicalAssignmentAdmission = {
  userId: string; role: string; active: boolean; sessionLive: boolean;
  targetId: string; kind: 'Project' | 'TechnicalPractice'; targetWorkable: boolean;
  parentContextValid: boolean; selectiveCeilingAllows: boolean;
  currentContextSha256: string; currentRecipientEpoch: number;
  currentRevision: number; assignmentRevision: number;
  assignmentContextSha256: string; assignmentRecipientEpoch: number;
  revoked: boolean;
};
export function admitsTechnicalAssignmentRead(
  current: CurrentTechnicalAssignmentAdmission,
  selection: TechnicalAssignmentSelection,
  requested: { targetId: string; kind: TechnicalAssignmentSelection['kind'] },
  now: Date,
) {
  if (!technicalAssignmentSelection.safeParse(selection).success) return false;
  return ['consulente', 'backoffice'].includes(current.role)
    && current.active && current.sessionLive && !current.revoked
    && current.targetWorkable && current.parentContextValid && current.selectiveCeilingAllows
    && current.userId === selection.userId && current.targetId === requested.targetId
    && current.kind === requested.kind && selection.kind === requested.kind
    && Number.isSafeInteger(current.currentRevision) && current.currentRevision >= 0
    && current.currentRevision === current.assignmentRevision
    && hash.safeParse(current.currentContextSha256).success
    && current.currentContextSha256 === current.assignmentContextSha256
    && Number.isSafeInteger(current.currentRecipientEpoch) && current.currentRecipientEpoch >= 0
    && current.currentRecipientEpoch === current.assignmentRecipientEpoch
    && Number.isFinite(now.getTime()) && Date.parse(selection.expiresAt) > now.getTime();
}

export function admitsTechnicalAssignmentAction(
  current: CurrentTechnicalAssignmentAdmission,
  selection: TechnicalAssignmentSelection,
  requested: { targetId: string; kind: TechnicalAssignmentSelection['kind']; action: typeof technicalAssignmentActions[number] },
  now: Date,
) {
  return admitsTechnicalAssignmentRead(current, selection, requested, now)
    && selection.actions.includes(requested.action);
}

export function technicalFieldPatch(selection: TechnicalAssignmentSelection, input: unknown) {
  if (!technicalAssignmentSelection.safeParse(selection).success || !selection.actions.includes('update_fields')
      || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  const allowed = new Set<string>(selection.editableFields), entries = Object.entries(input);
  if (!entries.length || entries.some(([key]) => !allowed.has(key))) return null;
  // Values still require the canonical field validators in the mutation layer.
  // Owner, client, project and service identifiers are never editable here.
  return Object.fromEntries(entries);
}
