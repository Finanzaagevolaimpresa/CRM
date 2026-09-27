import { z } from 'zod';
import { canonicalJson, sha256 } from './canonical-json';

export const DECLARED_FAI_MAILBOXES = Object.freeze([
  { address: 'info@finanzaagevolaimpresa.it', purpose: 'Primo contatto e commerciale', restricted: false },
  { address: 'amministrazione@finanzaagevolaimpresa.it', purpose: 'Incarichi, fatture e pagamenti', restricted: false },
  { address: 'assistenza@finanzaagevolaimpresa.it', purpose: 'Dialogo tecnico', restricted: false },
  { address: 'comunicazioni@finanzaagevolaimpresa.it', purpose: 'Avanzamenti e report approvati', restricted: false },
  { address: 'documenti@finanzaagevolaimpresa.it', purpose: 'Documenti della pratica', restricted: false },
  { address: 'reclami@finanzaagevolaimpresa.it', purpose: 'Reclami riservati', restricted: true },
  { address: 'admin@finanzaagevolaimpresa.it', purpose: 'Gestione interna', restricted: true },
] as const);

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive().max(2_147_483_647);
const email = z.string().trim().max(254).email().transform((value) => {
  const separator = value.lastIndexOf('@');
  return value.slice(0, separator + 1) + value.slice(separator + 1).toLowerCase();
});
const header = z.string().trim().min(1).max(998).refine((s) => !/[\u0000-\u001f\u007f]/.test(s));
const body = z.string().min(1).max(200_000).transform((s) => s.replace(/\r\n/g, '\n'))
  .refine((s) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s));
const timestamp = z.string().datetime({ offset: true });

export const approvedMessageStates = ['DRAFT', 'PENDING', 'APPROVED', 'SENDING', 'SENT', 'ERROR', 'UNCERTAIN'] as const;
export type ApprovedMessageState = typeof approvedMessageStates[number];
export const approvedMessageLabels: Record<ApprovedMessageState, string> = {
  DRAFT: 'Bozza', PENDING: 'In approvazione', APPROVED: 'Approvata', SENDING: 'Invio manuale in corso',
  SENT: 'Invio dichiarato', ERROR: 'Non inviata', UNCERTAIN: 'Esito incerto · da riconciliare',
};

export const mailboxQualificationSchema = z.object({
  id: z.string().uuid(), address: email, revision: version,
  configuredRevision: version.nullable(), configurationReference: id.nullable(),
  testedRevision: version.nullable(), testReference: id.nullable(), testedAt: timestamp.nullable(),
  enabled: z.boolean(), method: z.literal('MANUAL_EXTERNAL'),
  responsibleUserId: id.nullable(), restricted: z.boolean(),
}).strict();
export type MailboxQualification = z.infer<typeof mailboxQualificationSchema>;

export function mailboxQualification(input: unknown) {
  const row = mailboxQualificationSchema.parse(input);
  const declared = DECLARED_FAI_MAILBOXES.find((box) => box.address === row.address);
  const registered = !!declared;
  const configured = registered && row.configuredRevision === row.revision
    && !!row.configurationReference && !!row.responsibleUserId && (!declared.restricted || row.restricted);
  const tested = configured && row.testedRevision === row.revision && !!row.testReference && !!row.testedAt;
  return Object.freeze({ registered, configured, tested, enabled: tested && row.enabled });
}

export const approvedAttachmentSchema = z.object({
  documentId: id, versionId: id, sha256: hash,
  filename: z.string().min(1).max(200).refine((s) => !/[\u0000-\u001f\u007f/\\<>:"|?*]/.test(s)
    && s !== '.' && s !== '..' && !/[. ]$/.test(s) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s)),
  mimeType: z.string().min(3).max(120).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/),
  bytes: z.number().int().nonnegative().max(20 * 1024 * 1024),
}).strict();

export const communicationContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('READINESS'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('TECHNICAL'), id }).strict(),
]);
export type CommunicationContext = z.infer<typeof communicationContextSchema>;

export const approvedMessageSnapshotSchema = z.object({
  schema: z.literal('fai.approved-email.v1'),
  messageId: z.string().uuid(), revision: version,
  context: communicationContextSchema, clientId: id,
  channel: z.literal('EMAIL_MANUAL'),
  mailboxId: z.string().uuid(), mailboxRevision: version,
  from: email, replyTo: email,
  to: z.array(email).min(1).max(20), cc: z.array(email).max(20), bcc: z.array(email).max(20),
  subject: header, body,
  attachments: z.array(approvedAttachmentSchema).max(20),
  classification: z.enum(['ORDINARY', 'SENSITIVE', 'COMPLAINT']),
}).strict().superRefine((value, ctx) => {
  const recipients = [...value.to, ...value.cc, ...value.bcc];
  if (recipients.length > 20 || new Set(recipients.map((s) => s.toLowerCase())).size !== recipients.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MESSAGE_RECIPIENT_SET_INVALID' });
  if (new Set(value.attachments.map((a) => a.documentId)).size !== value.attachments.length
    || value.attachments.reduce((total, a) => total + a.bytes, 0) > 20 * 1024 * 1024)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MESSAGE_ATTACHMENT_SET_INVALID' });
});
export type ApprovedMessageSnapshot = z.infer<typeof approvedMessageSnapshotSchema>;

export function approvedMessageHash(input: unknown) {
  return sha256(`fai.approved-email.snapshot.v1\n${canonicalJson(approvedMessageSnapshotSchema.parse(input))}`);
}

export const exactMessageApprovalSchema = z.object({
  approvalId: z.string().uuid(), messageId: z.string().uuid(), revision: version,
  snapshotHash: hash, mailboxId: z.string().uuid(), mailboxRevision: version,
  approverUserId: id, approverSessionId: z.string().uuid(), approvedAt: timestamp,
}).strict();
export type ExactMessageApproval = z.infer<typeof exactMessageApprovalSchema>;

export class ApprovedCommunicationError extends Error {
  constructor(readonly code: 'INVALID' | 'DENIED' | 'CONFLICT' | 'SENDER_NOT_READY' | 'RECONCILIATION_REQUIRED') { super(code); }
}

// Authority, practice/attachment access and suspension checks belong to the calling
// database transaction. An approval object alone is never authority to send.
export function assertExactMessageApproval(snapshotInput: unknown, approvalInput: unknown, mailboxInput: unknown) {
  const snapshot = approvedMessageSnapshotSchema.parse(snapshotInput);
  const approval = exactMessageApprovalSchema.parse(approvalInput);
  const mailbox = mailboxQualificationSchema.parse(mailboxInput);
  if (!mailboxQualification(mailbox).enabled) throw new ApprovedCommunicationError('SENDER_NOT_READY');
  const declared = DECLARED_FAI_MAILBOXES.find((box) => box.address === mailbox.address);
  if (!declared || (declared.restricted && !mailbox.restricted)) throw new ApprovedCommunicationError('SENDER_NOT_READY');
  if (snapshot.messageId !== approval.messageId || snapshot.revision !== approval.revision
    || snapshot.mailboxId !== approval.mailboxId || snapshot.mailboxId !== mailbox.id
    || snapshot.mailboxRevision !== approval.mailboxRevision || snapshot.mailboxRevision !== mailbox.revision
    || snapshot.from !== mailbox.address || approval.snapshotHash !== approvedMessageHash(snapshot))
    throw new ApprovedCommunicationError('CONFLICT');
  return Object.freeze({ snapshot, approval, mailbox });
}

export const manualMessageEvidenceSchema = z.object({
  method: z.literal('MANUAL_DECLARATION'),
  outcome: z.enum(['SENT', 'NOT_SENT', 'UNCERTAIN']),
  occurredAt: timestamp,
  reference: z.string().trim().min(1).max(500).refine((s) => !/[\u0000-\u001f\u007f]/.test(s)),
  note: z.string().trim().max(2000).optional(),
}).strict();

export function nextManualMessageState(current: ApprovedMessageState, outcome: z.infer<typeof manualMessageEvidenceSchema>['outcome'], reconciliation: boolean): ApprovedMessageState {
  if (current === 'UNCERTAIN' && !reconciliation) throw new ApprovedCommunicationError('RECONCILIATION_REQUIRED');
  if ((reconciliation && current !== 'UNCERTAIN') || (!reconciliation && current !== 'SENDING')) throw new ApprovedCommunicationError('CONFLICT');
  return outcome === 'SENT' ? 'SENT' : outcome === 'NOT_SENT' ? 'ERROR' : 'UNCERTAIN';
}

export function assertCanBeginManualMessage(state: ApprovedMessageState) {
  if (state === 'UNCERTAIN' || state === 'SENDING') throw new ApprovedCommunicationError('RECONCILIATION_REQUIRED');
  if (state !== 'APPROVED' && state !== 'ERROR') throw new ApprovedCommunicationError('CONFLICT');
}
