import { z } from 'zod';
import { selectiveLeadFields, type SelectiveLeadField } from './selective-lead-policy';
import type { SelectiveLeadGrantPayload } from './selective-lead-grant';

/** An explicit operation catalogue, separate from the historical read grant. */
export const selectiveLeadEditableFields = {
  interest: selectiveLeadFields.interest,
  priority: selectiveLeadFields.priority,
} as const;
export type SelectiveLeadEditableField = keyof typeof selectiveLeadEditableFields;
const field = z.enum(['interest', 'priority']);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const generation = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime().transform(value => new Date(value).toISOString());

export const selectiveLeadEditSelectionSchema = z.object({
  protocol: z.literal('SELECTIVE_LEAD_EDIT_SELECTION_V1'),
  leadId: identifier, recipientId: identifier, readGrantId: z.string().uuid(),
  readGrantRevision: generation, readGrantProof: hash,
  revision: z.number().int().min(0).max(2_147_483_646),
  commandId: z.string().uuid(), fields: z.array(field).min(1).max(2),
  expiresAt: instant.nullable(),
}).strict().superRefine((value, context) => {
  if (new Set(value.fields).size !== value.fields.length) {
    context.addIssue({ code: 'custom', message: 'Seleziona ogni campo modificabile una sola volta.' });
  }
});
export type SelectiveLeadEditSelection = z.infer<typeof selectiveLeadEditSelectionSchema>;

/** The caller must first verify the current read grant, its journal and session
 * under locks. This pure check cannot enroll an authority or grant permission. */
export function validateLeadEditSelection(raw: unknown, read: SelectiveLeadGrantPayload,
  readProof: string, now: number) {
  const input = selectiveLeadEditSelectionSchema.parse(raw);
  if (!Number.isSafeInteger(now) || now < 0
    || input.leadId !== read.selection.leadId || input.recipientId !== read.selection.recipientId
    || input.readGrantId !== read.id || input.readGrantRevision !== read.revision
    || input.readGrantProof !== readProof
    || input.fields.some(key => !read.selection.fields.includes(key as SelectiveLeadField))
    || (input.expiresAt && Date.parse(input.expiresAt) <= now)
    || (read.selection.expiresAt && (!input.expiresAt
      || Date.parse(input.expiresAt) > Date.parse(read.selection.expiresAt)))) {
    throw new Error('SELECTIVE_LEAD_EDIT_SELECTION_DENIED');
  }
  return input;
}

const changesSchema = z.object({
  interest: z.string().trim().max(5000).nullable().transform(value => value === '' ? null : value).optional(),
  priority: z.enum(['bassa', 'media', 'alta', 'urgente']).optional(),
}).strict().superRefine((value, context) => {
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([, item]) => item === undefined)) {
    context.addIssue({ code: 'custom', message: 'Indica almeno un campo e il suo valore esplicito.' });
  }
});
export const selectiveLeadEditCommandSchema = z.object({
  protocol: z.literal('SELECTIVE_LEAD_EDIT_COMMAND_V1'),
  commandId: z.string().uuid(), leadId: identifier,
  capabilityId: z.string().uuid(), capabilityRevision: generation,
  readGrantId: z.string().uuid(), readGrantRevision: generation, readGrantProof: hash,
  expectedVersion: instant, changes: changesSchema,
}).strict();
export type SelectiveLeadEditCommand = z.infer<typeof selectiveLeadEditCommandSchema>;

export type LeadEditCommandAdmission = {
  capabilityId: string; capabilityRevision: number; selection: SelectiveLeadEditSelection;
  currentVersion: string;
};

/** No ordinary commercial form, owner, status or unselected values are accepted.
 * Authorization, preview confirmation and atomic persistence are caller duties. */
export function parseBoundLeadEditCommand(raw: unknown, current: LeadEditCommandAdmission) {
  const input = selectiveLeadEditCommandSchema.parse(raw);
  const s = current.selection;
  if (input.leadId !== s.leadId || input.capabilityId !== current.capabilityId
    || input.capabilityRevision !== current.capabilityRevision || input.readGrantId !== s.readGrantId
    || input.readGrantRevision !== s.readGrantRevision || input.readGrantProof !== s.readGrantProof
    || input.expectedVersion !== current.currentVersion
    || Object.keys(input.changes).some(key => !s.fields.includes(key as SelectiveLeadEditableField))) {
    throw new Error('SELECTIVE_LEAD_EDIT_COMMAND_STALE_OR_DENIED');
  }
  return input;
}
