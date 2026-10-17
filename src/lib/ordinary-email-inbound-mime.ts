import { createHash } from 'node:crypto';
import PostalMime, { addressParser } from 'postal-mime';
import { z } from 'zod';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { createOrdinaryInboundSource, inboundBatchSchema, inboundMessageSchema,
  INBOUND_MIME_MAX_BYTES, type InboundAdapter } from './ordinary-email-inbound-contract';

function deny(): never { throw new Error('ORDINARY_EMAIL_INBOUND_MIME_DENIED'); }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const rawItemSchema = z.object({
  providerId: inboundBatchSchema.shape.items.element.shape.providerId,
  raw: z.instanceof(Uint8Array),
  // The protocol adapter must supply the server's full-message size and stable
  // delivery time, not the untrusted Date header or the current fetch time.
  expectedBytes: z.number().int().positive().max(INBOUND_MIME_MAX_BYTES),
  receivedAt: inboundMessageSchema.shape.receivedAt,
}).strict();
const rawBatchSchema = inboundBatchSchema.omit({ items: true }).extend({
  items: z.array(rawItemSchema).max(25),
}).strict();

// Consume complete parameters, rather than searching for boundary= inside
// comments or another quoted value. This deliberately rejects unsupported
// structural syntax instead of letting validation and decoding disagree.
function contentTypeParts(value: string) {
  const [mediaType, ...tail] = value.split(';');
  const type = mediaType.trim().toLowerCase(), params = new Map<string, string>();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) deny();
  let rest = tail.length ? ';' + tail.join(';') : '';
  while (rest) {
    const parameter = /^[ \t]*;[ \t]*([!#$%&'*+\-.0-9A-Z^_\x60a-z{|}~]+)[ \t]*=[ \t]*(?:"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*)"|([!#$%&'*+\-.0-9A-Z^_\x60a-z{|}~]+))[ \t]*/.exec(rest);
    if (!parameter) deny();
    const name = parameter[1].toLowerCase();
    if (params.has(name) || /^boundary\*/.test(name)) deny();
    params.set(name, parameter[2] === undefined ? parameter[3] : parameter[2].replace(/\\([\x20-\x7e])/g, '$1'));
    rest = rest.slice(parameter[0].length);
  }
  return { type, params };
}

/** Strict bounded framing before the tolerant RFC decoder. Unsupported transfer
 * encodings, truncated multipart bodies and ambiguous structural headers reject
 * the entire page. The original bytes are never rewritten or silently clipped. */
function assertFraming(raw: Buffer) {
  let parts = 0, headerBytes = 0;
  const boundaries = new Set<string>();
  function entity(wire: string, depth: number) {
    if (++parts > 64 || depth > 12 || /\r(?!\n)/.test(wire)) deny();
    const separator = /\r?\n\r?\n/.exec(wire);
    if (!separator || separator.index > 32 * 1024) deny();
    const head = wire.slice(0, separator.index), body = wire.slice(separator.index + separator[0].length);
    headerBytes += head.length;
    if (headerBytes > 64 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(head)) deny();
    const lines = head.split(/\r?\n/), headers = new Map<string, string[]>();
    let current = '';
    for (const line of lines) {
      if (line.length > 998) deny();
      if (/^[ \t]/.test(line)) {
        const values = headers.get(current);
        if (!values) deny();
        values[values.length - 1] += ' ' + line.trim();
      } else {
        const match = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
        if (!match) deny();
        current = match[1].toLowerCase();
        headers.set(current, [...(headers.get(current) ?? []), match[2]]);
      }
    }
    const single = (name: string) => {
      const values = headers.get(name) ?? [];
      if (values.length > 1) deny();
      return values[0];
    };
    const contentType = single('content-type') ?? 'text/plain';
    const { type, params } = contentTypeParts(contentType);
    single('content-disposition');
    single('content-id');
    const encoding = (single('content-transfer-encoding') ?? '7bit').trim().toLowerCase();
    if (!['7bit', '8bit', 'base64', 'quoted-printable'].includes(encoding)) deny();
    if (type.startsWith('multipart/')) {
      if (!['multipart/mixed', 'multipart/alternative', 'multipart/related'].includes(type)
        || !['7bit', '8bit'].includes(encoding)) deny();
      const boundary = params.get('boundary') ?? '';
      if (!/^[0-9A-Za-z'()+_,./:=? -]{1,70}$/.test(boundary)
        || boundary.endsWith(' ') || boundaries.has(boundary)) deny();
      boundaries.add(boundary);
      let section: string[] | null = null, closed = false, children = 0;
      for (const line of body.split(/\r?\n/)) {
        const marker = line.replace(/[ \t]+$/, '');
        if (marker === '--' + boundary || marker === '--' + boundary + '--') {
          if (closed) deny();
          if (section !== null) { entity(section.join('\n'), depth + 1); children++; }
          closed = marker === '--' + boundary + '--';
          section = closed ? null : [];
        } else if (section !== null) section.push(line);
      }
      if (!closed || children === 0) deny();
    } else {
      if (encoding === 'base64') {
        const encoded = body.replace(/[ \t\r\n]/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
          || Buffer.from(encoded, 'base64').toString('base64') !== encoded) deny();
      } else if (encoding === 'quoted-printable') {
        if (/=(?![0-9a-fA-F]{2}|\r?\n)/.test(body)) deny();
      } else if (body.includes('\0') || (encoding === '7bit' && /[\u0080-\u00ff]/.test(body))) deny();
    }
  }
  entity(raw.toString('latin1'), 0);
}

async function normalize(item: z.infer<typeof rawItemSchema>) {
  // Snapshot adapter-owned bytes before the first await.
  const raw = Buffer.from(item.raw);
  if (raw.length !== item.expectedBytes || raw.length > INBOUND_MIME_MAX_BYTES) deny();
  assertFraming(raw);
  const parsed = await PostalMime.parse(raw, {
    forceRfc822Attachments: true, rfc822Attachments: true, attachmentEncoding: 'arraybuffer',
    maxNestingDepth: 12, maxHeadersSize: 64 * 1024, maxPartCount: 64, maxRfc822NestingDepth: 0,
  });
  const single = (name: string) => {
    const headers = parsed.headers.filter(header => header.key === name);
    if (headers.length > 1) deny();
    return headers[0]?.value;
  };
  const from = single('from');
  if (!from) deny();
  const addresses = addressParser(from);
  if (addresses.length !== 1 || addresses[0].group || !addresses[0].address) deny();
  single('subject');
  const messageId = single('message-id'), inReplyTo = single('in-reply-to');
  // Multiple or malformed references must never be reduced to one CRM target.
  const reference = (value: string | undefined) => {
    if (value === undefined) return null;
    if (!/^<[^<>\s\u0000-\u001f\u007f]+>$/.test(value.trim())) deny();
    return value.trim();
  };
  if (parsed.attachments.length > 32) deny();
  const attachments = parsed.attachments.map((attachment, ordinal) => {
    if (typeof attachment.content === 'string' || attachment.rfc822DepthExceeded
      || (attachment.disposition !== null && !['inline', 'attachment'].includes(attachment.disposition))) deny();
    const bytes = Buffer.from(attachment.content instanceof Uint8Array
      ? attachment.content : new Uint8Array(attachment.content));
    return { ordinal, filename: attachment.filename, contentType: attachment.mimeType,
      disposition: attachment.disposition as 'inline' | 'attachment' | null,
      contentId: attachment.contentId ?? null, bytes: bytes.length, sha256: hash(bytes) };
  });
  return inboundMessageSchema.parse({
    externalMessageId: reference(messageId), inReplyTo: reference(inReplyTo),
    sender: addresses[0].address, subject: parsed.subject ?? '', body: parsed.text ?? '',
    receivedAt: item.receivedAt,
    mime: { format: 'RFC822_V1', rawBase64: raw.toString('base64'), rawBytes: raw.length, sha256: hash(raw),
      textProjection: parsed.text === undefined ? 'NONE' : 'PLAIN_TEXT', hasHtml: parsed.html !== undefined, attachments },
  });
}

/** An adapter boundary for authenticated raw messages, not a protocol connector.
 * The existing binding, timeout, one-use receipt and cursor transaction remain
 * authoritative. No fetch, file access, HTML rendering or attachment execution. */
export function createOrdinaryMimeInboundSource(key: PrivilegedStepUpKey, adapter: InboundAdapter) {
  return createOrdinaryInboundSource(key, {
    readConfiguration: () => adapter.readConfiguration(),
    async readAuthenticated(configuration, position, signal) {
      try {
        const batch = rawBatchSchema.parse(await adapter.readAuthenticated(configuration, position, signal));
        if (signal.aborted || batch.generation !== configuration.descriptor.generation
          || batch.fromCursor !== position.cursor || batch.nextCursor === position.cursor
          || new Set(batch.items.map(item => item.providerId)).size !== batch.items.length
          || batch.items.reduce((total, item) => total + item.raw.byteLength, 0) > INBOUND_MIME_MAX_BYTES) deny();
        // Copy the entire page now; an adapter cannot mutate a later item while
        // an earlier item is awaiting decoding.
        const snapshot = batch.items.map(item => ({ ...item, raw: Buffer.from(item.raw) }));
        const items = [];
        for (const item of snapshot) {
          if (signal.aborted) deny();
          items.push({ providerId: item.providerId, message: await normalize(item) });
        }
        if (signal.aborted) deny();
        return { ...batch, items };
      } catch { deny(); }
    },
  });
}
