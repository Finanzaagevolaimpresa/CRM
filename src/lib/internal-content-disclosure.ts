import { z } from 'zod';
import type { ApprovedMessageSnapshot } from './approved-communication-contract';

const participant = z.object({ userId: z.string().min(1).max(128),
  version: z.number().int().positive(), epoch: z.number().int().positive(), role: z.string().min(1).max(40) }).strict();
/** Additive v2 snapshot extension, hashed with the exact message and approval.
 * Absence is private/unclassified, never inferred from an existing role/grant. */
export const internalDisclosureSchema = z.object({
  protocol: z.literal('SELECTED_INTERNAL_TEXT_V1'), reviewerUserId: z.string().min(1).max(128),
  threadVersion: z.number().int().positive(), participants: z.array(participant).min(1).max(100),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.participants.map(item => item.userId)).size !== value.participants.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'DUPLICATE_INTERNAL_READER' });
});
export type InternalDisclosure = z.infer<typeof internalDisclosureSchema>;
export function selectedInternalDisclosure(snapshot: ApprovedMessageSnapshot) {
  return snapshot.schema === 'fai.approved-email.v2' && snapshot.context.kind === 'INTERNAL'
    && snapshot.classification === 'ORDINARY' && snapshot.attachments.length === 0 ? snapshot.internalDisclosure : undefined;
}
export function internalDisclosureReader(disclosure: InternalDisclosure, current: {
  userId: string; participantVersion: number; epoch: number; role: string; threadVersion: number; canRead: boolean;
}, now: Date) {
  return Number.isFinite(now.getTime()) && current.canRead && current.threadVersion === disclosure.threadVersion
    && (!disclosure.expiresAt || new Date(disclosure.expiresAt).getTime() > now.getTime())
    && disclosure.participants.some(person => person.userId === current.userId && person.version === current.participantVersion
      && person.epoch === current.epoch && person.role === current.role);
}
