import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';

const identifier = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/);
const cursor = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
export const inboundDescriptorSchema = z.object({
  protocol: z.enum(['IMAP_UID', 'PROVIDER_CURSOR']),
  host: z.string().min(1).max(253).regex(/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])$/),
  port: z.number().int().min(1).max(65535), security: z.literal('TLS'),
  minVersion: z.literal('TLSv1.2'), rejectUnauthorized: z.literal(true),
  folder: identifier, generation: identifier,
  authenticationReference: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export type InboundDescriptor = z.infer<typeof inboundDescriptorSchema>;
export const INBOUND_MIME_MAX_BYTES = 1024 * 1024;
const privateMimeSchema = z.object({
  format: z.literal('RFC822_V1'),
  rawBase64: z.string().min(4).max(4 * Math.ceil(INBOUND_MIME_MAX_BYTES / 3)),
  rawBytes: z.number().int().positive().max(INBOUND_MIME_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  textProjection: z.enum(['PLAIN_TEXT', 'NONE']),
  hasHtml: z.boolean(),
  attachments: z.array(z.object({
    ordinal: z.number().int().nonnegative().max(31),
    filename: z.string().max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).nullable(),
    contentType: z.string().max(127).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
    disposition: z.enum(['inline', 'attachment']).nullable(),
    contentId: z.string().max(998).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).nullable(),
    bytes: z.number().int().nonnegative().max(INBOUND_MIME_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(32),
}).strict().superRefine((value, ctx) => {
  if (value.rawBase64.length > 4 * Math.ceil(INBOUND_MIME_MAX_BYTES / 3)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ORDINARY_EMAIL_INBOUND_MIME_DENIED' });
    return;
  }
  const bytes = Buffer.from(value.rawBase64, 'base64');
  if (bytes.toString('base64') !== value.rawBase64 || bytes.length !== value.rawBytes
    || createHash('sha256').update(bytes).digest('hex') !== value.sha256
    || value.attachments.some((attachment, index) => attachment.ordinal !== index)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ORDINARY_EMAIL_INBOUND_MIME_DENIED' });
  }
});
export const inboundMessageSchema = z.object({
  externalMessageId: identifier.nullable(), inReplyTo: identifier.nullable(),
  sender: z.string().email().max(254),
  subject: z.string().max(998).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  body: z.string().max(200_000).refine(value => !value.includes('\0')),
  receivedAt: z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  mime: privateMimeSchema.optional(),
}).strict();
export const inboundBatchSchema = z.object({
  generation: identifier, fromCursor: cursor.nullable(), nextCursor: cursor,
  items: z.array(z.object({ providerId: identifier, message: inboundMessageSchema }).strict()).max(25),
}).strict();
export type InboundBatch = z.infer<typeof inboundBatchSchema>;
export type InboundBinding = { id: string; mailboxId: string; mailboxRevision: number; revision: number;
  descriptor: InboundDescriptor; qualificationReference: string; validUntil: Date };
export type InboundPosition = { version: number; cursor: string | null };
export function inboundDenied(): never { throw new Error('ORDINARY_EMAIL_INBOUND_DENIED'); }
const bindingHash = (binding: InboundBinding) => canonicalSha256({ ...binding, validUntil: binding.validUntil.toISOString() });

/** No SMTP/M4 fallback. This prepares a fingerprint, not an activation. The
 * credential is read only inside a private source and never persisted/logged. */
export function inboundQualificationReference(binding: Omit<InboundBinding, 'qualificationReference'>,
  key: PrivilegedStepUpKey, credential: string) {
  if (!z.string().uuid().safeParse(binding.id).success || !z.string().uuid().safeParse(binding.mailboxId).success
    || ![binding.mailboxRevision,binding.revision,key.version].every(n => Number.isSafeInteger(n) && n > 0)
    || !Number.isFinite(binding.validUntil.getTime()) || key.secret.length < 32 || !credential || credential.length > 4096) inboundDenied();
  const descriptor = inboundDescriptorSchema.parse(binding.descriptor);
  return `ordinary-inbound-v1:${key.version}:` + createHmac('sha256',key.secret)
    .update('fai.ordinary-email.inbound.qualification.v1\n' + canonicalJson({ id: binding.id,
      mailboxId: binding.mailboxId, mailboxRevision: binding.mailboxRevision, revision: binding.revision,
      descriptor, validUntil: binding.validUntil.toISOString(), credential })).digest('hex');
}

type Receipt = Readonly<{ received: true }>;
const receipts = new WeakMap<Receipt, { bindingHash: string; positionHash: string; batch: InboundBatch; deadline: number }>();
const sources = new WeakSet<object>();
export type InboundSource = ReturnType<typeof createOrdinaryInboundSource>;
export type InboundAdapter = {
  readConfiguration(): { descriptor: InboundDescriptor; credential: string };
  readAuthenticated(configuration: { descriptor: InboundDescriptor; credential: string },
    position: InboundPosition, signal: AbortSignal): Promise<unknown>;
};
/** Private server adapter boundary, deliberately without a default connector,
 * environment reader, route or worker. readAuthenticated must verify TLS/SNI,
 * authenticate the configured mailbox and read without marking/deleting mail.
 * Its real protocol implementation is a separate qualification prerequisite.
 * A payload's authenticated=true is never accepted as authentication evidence. */
export function createOrdinaryInboundSource(keyInput: PrivilegedStepUpKey, adapter: InboundAdapter) {
  const key = { ...keyInput };
  function assertBinding(binding: InboundBinding) {
    const configuration = adapter.readConfiguration();
    if (canonicalSha256(inboundDescriptorSchema.parse(configuration.descriptor)) !== canonicalSha256(binding.descriptor)) inboundDenied();
    const expected = Buffer.from(inboundQualificationReference(binding,key,configuration.credential));
    const actual = Buffer.from(binding.qualificationReference);
    if (expected.length !== actual.length || !timingSafeEqual(expected,actual)) inboundDenied();
    return configuration;
  }
  const source = {
    assertKey(expected: PrivilegedStepUpKey) {
      const actualBytes=Buffer.from(key.secret), expectedBytes=Buffer.from(expected.secret);
      if (key.version!==expected.version || actualBytes.length!==expectedBytes.length || !timingSafeEqual(actualBytes,expectedBytes)) inboundDenied();
    },
    assertBinding(binding: InboundBinding) { assertBinding(binding); },
    async read(binding: InboundBinding, position: InboundPosition): Promise<Receipt> {
      if (binding.validUntil.getTime() <= Date.now()) inboundDenied();
      const configuration = assertBinding(binding), controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([adapter.readAuthenticated(configuration, { ...position }, controller.signal),
          new Promise<never>((_,reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('ORDINARY_EMAIL_INBOUND_TIMEOUT')); },15_000); })]);
        const batch = inboundBatchSchema.parse(raw);
        if (batch.generation !== binding.descriptor.generation || batch.fromCursor !== position.cursor
          || batch.nextCursor === position.cursor || new Set(batch.items.map(item => item.providerId)).size !== batch.items.length
          || Buffer.byteLength(canonicalJson(batch)) > 2 * 1024 * 1024) inboundDenied();
        assertBinding(binding);
        batch.items.sort((a,b) => a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0);
        const receipt = Object.freeze({ received: true as const });
        receipts.set(receipt, { bindingHash: bindingHash(binding), positionHash: canonicalSha256(position), batch,
          deadline: Math.min(Date.now()+15_000,binding.validUntil.getTime()) });
        return receipt;
      } finally { clearTimeout(timer); controller.abort(); }
    },
  };
  sources.add(source);
  return Object.freeze(source);
}
export function assertInboundSource(source: InboundSource) { if (!sources.has(source)) inboundDenied(); }
/** The capability is one-use and local to this process; JSON, copied objects
 * and replay cannot turn an unauthenticated external payload into a batch. */
export function consumeInboundReceipt(receipt: Receipt, binding: InboundBinding, position: InboundPosition, now: Date) {
  const stored = receipts.get(receipt); receipts.delete(receipt);
  if (!stored || stored.deadline <= now.getTime() || stored.bindingHash !== bindingHash(binding)
    || stored.positionHash !== canonicalSha256(position)) inboundDenied();
  return { batch: stored.batch, deadline: stored.deadline };
}
