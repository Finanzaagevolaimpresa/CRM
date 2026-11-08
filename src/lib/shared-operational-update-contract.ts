import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { technicalPracticeStatusSchema } from './validation';
import { technicalProjectStatuses } from './technical-work-contract';
import { clientOperationalStates } from './shared-operational-display';
export { clientOperationalStates, clientOperationalStateLabels } from './shared-operational-display';

export const sharedUpdateKinds = ['CLIENT', 'PROJECT', 'PRACTICE'] as const;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sharedUpdateTarget = z.object({ kind: z.enum(sharedUpdateKinds), id }).strict();
export type SharedUpdateTarget = z.infer<typeof sharedUpdateTarget>;
const optionalText = z.string().trim().max(500).nullable().transform(value => value || null);
export const operationalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Inserire una data valida');
export const sharedUpdateCommand = z.object({
  commandId: z.string().uuid(), target: sharedUpdateTarget,
  expectedContext: hash, expectedVersion: z.string().datetime(),
  text: z.string().trim().min(1, 'Scrivi l’aggiornamento operativo').max(4000),
  state: z.string().min(1).max(24).nullable(),
  nextAction: optionalText, nextActionDueOn: operationalDay.nullable(),
  correctionOfId: z.string().uuid().nullable(),
  // This is a new typed operational message, never a classification of old notes.
  classification: z.literal('SHARED_OPERATIONAL'),
}).strict().superRefine((input, ctx) => {
  if (input.state !== null && !sharedUpdateStates(input.target.kind).includes(input.state))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['state'], message: 'Stato operativo non valido per questa scheda' });
  // A correction rectifies the retained text; it cannot silently reapply a state.
  if (input.correctionOfId && input.state !== null)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['state'], message: 'La rettifica non modifica lo stato della scheda' });
});
export type SharedUpdateCommand = z.infer<typeof sharedUpdateCommand>;
export function sharedUpdateStates(kind: SharedUpdateTarget['kind']): readonly string[] {
  if (kind === 'CLIENT') return clientOperationalStates;
  if (kind === 'PROJECT') return technicalProjectStatuses;
  return technicalPracticeStatusSchema.options.filter(value => value !== 'archiviata');
}
/** Explicit administrative/assigned correction inside the same operating domain.
 * No lifecycle/archive, Lead, contract, payment or other-practice transition. */
export function sharedUpdateTransition(kind: SharedUpdateTarget['kind'], before: string | null, after: string | null) {
  if (after === null) return { changed: false, before, after: before };
  if (!sharedUpdateStates(kind).includes(after)) throw new SharedOperationalUpdateError('INVALID');
  return { changed: before !== after, before, after };
}
export function sharedUpdateRequestDigest(raw: SharedUpdateCommand) {
  return canonicalSha256({ protocol: 'FAI_SHARED_OPERATIONAL_UPDATE_V1', command: sharedUpdateCommand.parse(raw) });
}
export class SharedOperationalUpdateError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'INVALID' | 'NOT_AVAILABLE' | 'CONFLICT') { super(code); }
}

export const sharedUpdateReceipt = z.object({ commandId: z.string().uuid(), updateId: z.string().uuid(),
  eventId: z.string().uuid(), recordedAt: z.string().datetime(), replayed: z.boolean() }).strict();
export type SharedUpdateReceipt = z.infer<typeof sharedUpdateReceipt>;
