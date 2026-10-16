import { createHash } from 'node:crypto';
import { z } from 'zod';
import { approvedMessageHash, approvedMessageSnapshotSchema, type ApprovedMessageSnapshot } from './approved-communication-contract';
import { canonicalSha256 } from './canonical-json';

/** Preparation only. No route, provider, worker or permission is enabled here.
 * M4 supplies versioned draft content; its manual approval cannot authorize SMTP.
 * A future transaction must bind the canonical personal actor, exact intent,
 * current context/attachments and a committed unique attempt before transport. */
const channelSchema = z.object({
  purpose: z.literal('ORDINARY_SMTP'), mailboxId: z.string().uuid(), mailboxRevision: z.number().int().positive(),
  address: z.literal('comunicazioni@finanzaagevolaimpresa.it'),
  channelRevision: z.number().int().positive(), qualificationReference: z.string().min(1).max(128),
}).strict();
export type OrdinaryChannel = z.infer<typeof channelSchema>;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const b64 = (bytes: Buffer) => bytes.toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';

function encodedHeader(text: string) {
  const chunks: string[] = []; let chunk = '';
  for (const point of text) {
    if (Buffer.byteLength(chunk + point) > 42) { chunks.push(chunk); chunk = ''; }
    chunk += point;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(value => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ');
}

export function prepareOrdinaryEmail(raw: ApprovedMessageSnapshot, channelInput: OrdinaryChannel, materials: Map<string, Buffer>, preparedAt: Date) {
  const message = approvedMessageSnapshotSchema.parse(raw), channel = channelSchema.parse(channelInput);
  if (!Number.isFinite(preparedAt.getTime()) || channel.mailboxId !== message.mailboxId || channel.mailboxRevision !== message.mailboxRevision
    || message.from !== channel.address || message.replyTo !== channel.address || message.classification !== 'ORDINARY') throw new Error('ORDINARY_CHANNEL_MISMATCH');
  const exactFiles = message.attachments.map(item => {
    const bytes = materials.get(item.versionId);
    if (!bytes || bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw new Error('ORDINARY_ATTACHMENT_MISMATCH');
    return { item, bytes: Buffer.from(bytes) };
  });
  const messageReference = `<fai-smtp-${message.messageId}-v${message.revision}@crm.finanzaagevolaimpresa.it>`;
  const intent = { protocol: 'FAI_PERSONAL_ORDINARY_SMTP_V1', draftHash: approvedMessageHash(message), channel,
    messageReference, preparedAt: preparedAt.toISOString() };
  const intentHash = canonicalSha256(intent), boundary = `fai_${intentHash}`;
  const lines = [
    `From: ${message.from}`, `Reply-To: ${message.replyTo}`, `To: ${message.to.join(',\r\n ')}`,
    ...(message.cc.length ? [`Cc: ${message.cc.join(',\r\n ')}`] : []),
    `Subject: ${encodedHeader(message.subject)}`, `Message-ID: ${messageReference}`, `Date: ${preparedAt.toUTCString()}`,
    'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(message.body)),
  ];
  for (const { item, bytes } of exactFiles) lines.push(
    `--${boundary}`, `Content-Type: ${item.mimeType}`, 'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment;\r\n filename*=UTF-8''${encodeURIComponent(item.filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    '', b64(bytes),
  );
  lines.push(`--${boundary}--`, '');
  const mime = Buffer.from(lines.join('\r\n'));
  return { intent, intentHash, mime, mimeHash: digest(mime),
    envelope: { from: message.from, recipients: [...message.to, ...message.cc, ...message.bcc] },
    summary: { from: message.from, replyTo: message.replyTo, to: message.to, cc: message.cc, bcc: message.bcc,
      subject: message.subject, body: message.body, attachments: message.attachments } };
}

export type TransmissionState = 'APPROVED' | 'RESERVED' | 'ACCEPTED' | 'NOT_SENT' | 'UNCERTAIN';
/** A reservation is durable before opening the socket. Neither an uncertain
 * result nor a new request ID is permission to repeat DATA. ACCEPTED is SMTP
 * acceptance only, never proof of delivery or reading. */
export function nextTransmission(state: TransmissionState, event: 'RESERVE' | 'SMTP_ACCEPTED' | 'DEFINITE_NOT_SENT' | 'LOST_RESULT' | 'RETRY') {
  if (event === 'RESERVE' && state === 'APPROVED') return 'RESERVED' as const;
  if (state === 'RESERVED') {
    if (event === 'SMTP_ACCEPTED') return 'ACCEPTED' as const;
    if (event === 'DEFINITE_NOT_SENT') return 'NOT_SENT' as const;
    if (event === 'LOST_RESULT') return 'UNCERTAIN' as const;
  }
  throw new Error('ORDINARY_RECONCILIATION_OR_NEW_PERSONAL_APPROVAL_REQUIRED');
}

export type ReceivedReference = { canonicalMailboxId: string; externalMessageId: string; inReplyTo: string | null; sender: string; contentHash: string };
export type SentReference = { messageId: string; canonicalMailboxId: string; messageReference: string; recipients: readonly string[]; accepted: boolean; contextCurrentlyReadable: boolean };
/** This is only a link proposal over already authorized metadata. Content is
 * opaque data; matching a customer address or quoting a CRM ID in the body
 * never creates an association. The receiver must authenticate its own channel,
 * persist the unique provider identity and recheck scope in its transaction. */
export function associateReceivedReply(input: ReceivedReference, sent: readonly SentReference[], prior: ReceivedReference | null) {
  const received = z.object({ canonicalMailboxId: z.string().uuid(), externalMessageId: z.string().min(1).max(255).regex(/^[^\r\n\u0000]+$/),
    inReplyTo: z.string().max(255).nullable(), sender: z.string().email().max(254), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input);
  if (prior && prior.canonicalMailboxId === received.canonicalMailboxId && prior.externalMessageId === received.externalMessageId) {
    if (canonicalSha256(prior) !== canonicalSha256(received)) throw new Error('ORDINARY_INBOUND_IDENTITY_CONFLICT');
    return { outcome: 'DUPLICATE' as const, messageId: null };
  }
  const matches = sent.filter(row => row.accepted && row.contextCurrentlyReadable && row.canonicalMailboxId === received.canonicalMailboxId
    && row.messageReference === received.inReplyTo && row.recipients.some(address => address.toLowerCase() === received.sender.toLowerCase()));
  return matches.length === 1 ? { outcome: 'LINKED' as const, messageId: matches[0].messageId }
    : { outcome: 'QUARANTINE' as const, messageId: null };
}
