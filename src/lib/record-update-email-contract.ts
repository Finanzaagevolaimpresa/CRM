import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { emptyCommunicationRecipientSelection } from './communication-recipient-policy';
import { parseRecordUpdateSummary } from './record-update-contract';
import { recordUpdateChangedLabels, recordUpdateEventLabels, recordUpdateKinds } from './record-update-labels';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().positive().max(2_147_483_647);
const sourceSchema = z.object({
  deliveryId: z.string().uuid(), eventId: z.string().uuid(),
  kind: z.enum(recordUpdateKinds), recordId: id,
  recipientId: id, recipientEpoch: epoch, authorId: id, authorEpoch: epoch,
  ruleId: z.string().uuid().nullable(), ruleVersion: epoch.nullable(), commandId: z.string().uuid().nullable(),
  scopeHash: hash, directoryHash: hash, occurredAt: z.string().datetime({ offset: true }),
  recordVersion: z.string().datetime({ offset: true }),
  authorityRevision: epoch,
}).strict().superRefine((value, ctx) => {
  const fromRule = value.ruleId !== null && value.ruleVersion !== null && value.commandId === null;
  const fromCommand = value.commandId !== null && value.ruleId === null && value.ruleVersion === null;
  if (!fromRule && !fromCommand) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'UPDATE_EMAIL_SOURCE_INVALID' });
});
const proposalSchema = z.object({
  source: sourceSchema,
  mode: z.enum(['EMAIL_DRAFT', 'CRM_AND_EMAIL_DRAFT']),
  label: z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  recipient: z.object({ id, email: z.string().trim().max(254).email() }).strict(),
  summary: z.unknown(),
}).strict();

// Pure preparation only. The caller must obtain this projection from current
// transactional admission. These fields, including the digest, confer neither
// record access nor email authority. No mailbox or approval is selected here.
export function prepareRecordUpdateEmailProposal(raw: unknown) {
  const input = proposalSchema.parse(raw);
  const summary = parseRecordUpdateSummary(input.summary);
  if (input.source.recipientId !== input.recipient.id) throw new Error('UPDATE_EMAIL_RECIPIENT_MISMATCH');
  const separator = input.recipient.email.lastIndexOf('@');
  const address = input.recipient.email.slice(0, separator + 1) + input.recipient.email.slice(separator + 1).toLowerCase();
  const eventLabel = recordUpdateEventLabels[summary.event];
  const subject = `${eventLabel}: ${input.label}`;
  const body = `È disponibile un aggiornamento per ${input.label}.\n\n`
    + `Tipo di aggiornamento: ${eventLabel}.\n`
    + `Campi interessati: ${summary.changed.map(field => recordUpdateChangedLabels[field]).join(', ')}.\n\n`
    + 'Consulta il CRM per i dettagli consentiti dal tuo accesso attuale.';
  const provenance = { protocol: 'FAI_RECORD_UPDATE_EMAIL_PROPOSAL_V1' as const,
    ...input.source, mode: input.mode, summary, recordLabel: input.label, recipientAddress: address };
  const recipientSelection = emptyCommunicationRecipientSelection();
  recipientSelection.to.userIds = [input.recipient.id];
  return { source: provenance, sourceHash: canonicalSha256(provenance), subject, body,
    recipientSelection,
    externalRecipients: { to: [], cc: [], bcc: [] }, attachments: [],
    state: 'DRAFT' as const, requiresPersonalApproval: true as const, sendApproved: false as const };
}

// The current input must come from the same locked admission used by the
// transaction, never from a submitted snapshot. This comparison is only a
// stale-preview check; it does not replace current access or personal approval.
export function revalidateRecordUpdateEmailProposal(current: unknown, expectedSourceHash: string) {
  const proposal = prepareRecordUpdateEmailProposal(current);
  if (!hash.safeParse(expectedSourceHash).success || proposal.sourceHash !== expectedSourceHash)
    throw new Error('UPDATE_EMAIL_SOURCE_CHANGED');
  return proposal;
}
