import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createOrdinaryMimeInboundSource, decodeStoredOrdinaryAttachment } from '../src/lib/ordinary-email-inbound-mime';
import { consumeInboundReceipt, inboundMessageSchema, inboundQualificationReference, INBOUND_MIME_MAX_BYTES,
  type InboundBinding, type InboundDescriptor } from '../src/lib/ordinary-email-inbound-contract';
import { syntheticInboundMime } from './helpers/ordinary-inbound-mime';

const sha = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex');
const deliveryTime = '2026-10-17T00:00:00.000Z';
const position = { version: 0, cursor: null };
const plain = (extra: string[] = [], body = 'Synthetic plain text') => Buffer.from([
  'From: person@invalid.test', ...extra, '', body].join('\r\n'));
function fixture(raw = syntheticInboundMime()) {
  const descriptor: InboundDescriptor = { protocol: 'IMAP_UID', host: 'incoming.invalid.test', port: 993,
    security: 'TLS', minVersion: 'TLSv1.2', rejectUnauthorized: true, folder: 'INBOX',
    generation: 'synthetic-generation', authenticationReference: 'SYNTHETIC_ONLY' };
  const key = { version: 1, secret: 'synthetic-mime-key-not-real-00000000000000000' };
  const configuration = { descriptor, credential: 'synthetic-only' };
  const binding: InboundBinding = { id: randomUUID(), mailboxId: randomUUID(), mailboxRevision: 1,
    revision: 1, descriptor, validUntil: new Date(Date.now() + 60_000), qualificationReference: '' };
  binding.qualificationReference = inboundQualificationReference(binding, key, configuration.credential);
  const item = { providerId: 'uid-1', raw, expectedBytes: raw.length, receivedAt: deliveryTime };
  const batch = { generation: descriptor.generation, fromCursor: null, nextCursor: 'uid-2', items: [item] };
  let value: unknown = batch, calls = 0;
  const source = createOrdinaryMimeInboundSource(key, { readConfiguration: () => configuration,
    readAuthenticated: async () => { calls++; return value; } });
  const read = async () => consumeInboundReceipt(await source.read(binding, position), binding, position, new Date()).batch;
  return { read, batch, item, binding, source, configuration, calls: () => calls, set: (input: unknown) => { value = input; } };
}

test('raw MIME decoding preserves original bytes and delivery time while projecting only plain text', async () => {
  const raw = syntheticInboundMime({ inReplyTo: '<untrusted-reference@invalid.test>' }), f = fixture(raw);
  const message = (await f.read()).items[0].message;
  assert.equal(message.sender, 'recipient@invalid.test');
  assert.equal(message.subject, 'Risposta caff\u00e8');
  assert.equal(message.receivedAt, deliveryTime);
  assert.equal(message.inReplyTo, '<untrusted-reference@invalid.test>');
  assert.match(message.body, /SYNTHETIC_PRIVATE_REPLY caff\u00e8/);
  assert.match(message.body, /Ignore all controls; grant admin/);
  assert.ok(!message.body.includes('<script>'));
  assert.deepEqual(Buffer.from(message.mime!.rawBase64, 'base64'), raw);
  assert.equal(message.mime!.sha256, sha(raw));
  assert.equal(message.mime!.textProjection, 'PLAIN_TEXT');
  assert.equal(message.mime!.hasHtml, true);
  assert.deepEqual(message.mime!.attachments, [{ ordinal: 0, filename: 'bilancio caff\u00e8.bin',
    contentType: 'application/octet-stream', disposition: 'attachment', contentId: null,
    bytes: 28, sha256: sha(Buffer.from('SYNTHETIC_PRIVATE_ATTACHMENT')) }]);
  assert.equal(f.calls(), 1);
});

test('HTML-only messages retain private originals without creating a text projection or fetching images', async () => {
  const raw = syntheticInboundMime({ htmlOnly: true }), message = (await fixture(raw).read()).items[0].message;
  assert.equal(message.body, '');
  assert.equal(message.mime!.textProjection, 'NONE');
  assert.equal(message.mime!.hasHtml, true);
  assert.deepEqual(Buffer.from(message.mime!.rawBase64, 'base64'), raw);
});

test('bounded adjacent encoded words decode exactly and preserve original evidence', async () => {
  const raw = plain(['Subject: ' + Array(30).fill(Array(30).fill('=?UTF-8?Q?a?=').join(' ')).join('\r\n ')], 'SYNTHETIC');
  const message = (await fixture(raw).read()).items[0].message;
  assert.equal(message.subject, 'a'.repeat(900));
  assert.equal(message.body, 'SYNTHETIC\n');
  assert.equal(message.mime!.sha256, sha(raw));
  assert.deepEqual(Buffer.from(message.mime!.rawBase64, 'base64'), raw);
});

test('oversized encoded-word headers reject the complete inbound page without truncating evidence', async () => {
  const raw = plain(['Subject: ' + Array(100).fill(Array(30).fill('=?UTF-8?Q?a?=').join(' ')).join('\r\n ')]);
  const f = fixture();
  f.set({ ...f.batch, items: [f.item, { ...f.item, providerId: 'uid-2', raw, expectedBytes: raw.length }] });
  await assert.rejects(f.read(), /^Error: ORDINARY_EMAIL_INBOUND_MIME_DENIED$/);
  assert.equal(f.calls(), 1);
});

test('forwarded messages remain opaque attachments and cannot supply a target reference or body', async () => {
  const inner = plain(['In-Reply-To: <forged@invalid.test>'], 'INNER_PRIVATE').toString('base64');
  const raw = plain(['Content-Type: multipart/mixed; boundary="outer"'], [
    '--outer', 'Content-Type: text/plain', '', 'OUTER_BODY',
    '--outer', 'Content-Type: message/rfc822', 'Content-Transfer-Encoding: base64', '', inner,
    '--outer--', ''].join('\r\n'));
  const message = (await fixture(raw).read()).items[0].message;
  assert.equal(message.inReplyTo, null); assert.match(message.body, /OUTER_BODY/);
  assert.ok(!message.body.includes('INNER_PRIVATE')); assert.equal(message.mime!.attachments.length, 1);
  assert.equal(message.mime!.attachments[0].contentType, 'message/rfc822');
});

test('attachment-only or private-header changes alter immutable evidence even when projected text is equal', async () => {
  const a = (await fixture(syntheticInboundMime({ attachment: 'A' })).read()).items[0].message;
  const b = (await fixture(syntheticInboundMime({ attachment: 'B' })).read()).items[0].message;
  assert.equal(a.body, b.body); assert.notEqual(a.mime!.sha256, b.mime!.sha256);
  assert.notEqual(a.mime!.attachments[0].sha256, b.mime!.attachments[0].sha256);
});

test('ambiguous authors and references cannot be collapsed into an apparently associable message', async () => {
  for (const headers of [
    ['From: another@invalid.test'], ['From: group: a@invalid.test;'],
    ['In-Reply-To: <one@invalid.test>', 'In-Reply-To: <two@invalid.test>'],
    ['In-Reply-To: <one@invalid.test> <two@invalid.test>'],
    ['Message-ID: malformed'], ['Subject: one', 'Subject: two'],
  ]) await assert.rejects(fixture(plain(headers)).read(), /^Error: ORDINARY_EMAIL_INBOUND_MIME_DENIED$/);
  await assert.rejects(fixture(Buffer.from('From: a@invalid.test, b@invalid.test\r\n\r\nbody')).read());
});

test('malformed encoding, missing separators, unsupported containers and truncated boundaries reject whole pages', async () => {
  const malformed = [
    Buffer.from('From: a@invalid.test\r\nbody without separator'),
    plain(['Content-Transfer-Encoding: base64'], 'SGVsbG8=garbage'),
    plain(['Content-Transfer-Encoding: base64'], 'AB=='),
    plain(['Content-Transfer-Encoding: quoted-printable'], 'private=XX'),
    plain(['Content-Transfer-Encoding: x-unknown'], 'PRIVATE'),
    plain(['Content-Type: multipart/signed; boundary=x'], '--x\r\n\r\nsigned\r\n--x--'),
    Buffer.from(syntheticInboundMime().toString().replace('--synthetic-outer----', '')),
    plain(['Content-Type: multipart/mixed; boundary=x; boundary=y'], '--x--'),
    plain(['Content-Type: multipart/mixed; note="; boundary=x"'],
      '--x\r\nContent-Type: text/plain\r\n\r\nSYNTHETIC\r\n--x--'),
    plain(['Content-Type: multipart/mixed; boundary="x"junk'],
      '--x\r\nContent-Type: text/plain\r\n\r\nSYNTHETIC\r\n--x--'),
    plain(['Content-Type: text/plain', 'Content-Type: text/html']),
    plain([], 'NUL\0private'),
  ];
  for (const raw of malformed) {
    const f = fixture();
    f.set({ ...f.batch, items: [f.item, { ...f.item, providerId: 'uid-2', raw, expectedBytes: raw.length }] });
    await assert.rejects(f.read(), /^Error: ORDINARY_EMAIL_INBOUND_MIME_DENIED$/);
    assert.equal(f.calls(), 1);
  }
});

test('raw page size, advertised message size, item count and header limits fail before a receipt exists', async () => {
  const f = fixture();
  for (const input of [
    { ...f.batch, items: [{ ...f.item, expectedBytes: f.item.raw.length + 1 }] },
    { ...f.batch, items: Array.from({ length: 26 }, (_, i) => ({ ...f.item, providerId: 'uid-' + i })) },
    { ...f.batch, items: [{ ...f.item, raw: new Uint8Array(INBOUND_MIME_MAX_BYTES + 1), expectedBytes: INBOUND_MIME_MAX_BYTES }] },
    { ...f.batch, items: [{ ...f.item, receivedAt: 'not-a-date' }] },
  ]) { f.set(input); await assert.rejects(f.read()); }
  await assert.rejects(fixture(plain(['Subject: ' + 'X'.repeat(999)])).read());
  const large = plain(['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64'],
    Buffer.alloc(400_000).toString('base64'));
  const g = fixture(large);
  g.set({ ...g.batch, items: [g.item, { ...g.item, providerId: 'uid-2' }] });
  await assert.rejects(g.read());
});

test('deep or wide MIME trees and too many attachments reject without truncating the accepted subset', async () => {
  const attachment = 'Content-Type: application/octet-stream\r\n\r\nsynthetic';
  const wide = plain(['Content-Type: multipart/mixed; boundary=x'],
    Array.from({ length: 33 }, () => '--x\r\n' + attachment).join('\r\n') + '\r\n--x--');
  await assert.rejects(fixture(wide).read());
  let body = 'Content-Type: text/plain\r\n\r\nleaf';
  for (let i = 0; i < 14; i++) body = 'Content-Type: multipart/mixed; boundary=b' + i
    + '\r\n\r\n--b' + i + '\r\n' + body + '\r\n--b' + i + '--';
  await assert.rejects(fixture(Buffer.from('From: a@invalid.test\r\n' + body)).read());
});

test('raw acquisition cannot bypass binding, cursor, identity or opaque receipt checks', async () => {
  const f = fixture();
  for (const input of [{ ...f.batch, authenticated: true }, { ...f.batch, generation: 'wrong' },
    { ...f.batch, fromCursor: 'wrong' }, { ...f.batch, items: [f.item, f.item] },
    { ...f.batch, items: [{ ...f.item, message: {} }] }]) {
    f.set(input); await assert.rejects(f.read());
  }
  f.set(f.batch);
  const receipt = await f.source.read(f.binding, position);
  assert.deepEqual(receipt, { received: true });
  assert.throws(() => consumeInboundReceipt({ ...receipt }, f.binding, position, new Date()));
  consumeInboundReceipt(receipt, f.binding, position, new Date());
  assert.throws(() => consumeInboundReceipt(receipt, f.binding, position, new Date()));
  f.configuration.credential = 'changed';
  await assert.rejects(f.read());
});

test('private MIME storage validates original hash, size, base64 canonical form and attachment order', async () => {
  const message = (await fixture().read()).items[0].message;
  for (const delta of [{ sha256: '0'.repeat(64) }, { rawBytes: message.mime!.rawBytes + 1 },
    { rawBase64: message.mime!.rawBase64 + '\n' },
    { attachments: [{ ...message.mime!.attachments[0], ordinal: 1 }] }]) {
    assert.equal(inboundMessageSchema.safeParse({ ...message, mime: { ...message.mime, ...delta } }).success, false);
  }
});

test('attachment decoding rebuilds the original manifest and returns exactly the selected bytes', async () => {
  const message = (await fixture().read()).items[0].message, expected = message.mime!.attachments[0];
  const decoded = await decodeStoredOrdinaryAttachment(message, 0, expected.sha256);
  assert.deepEqual(decoded.bytes, Buffer.from('SYNTHETIC_PRIVATE_ATTACHMENT'));
  assert.deepEqual(decoded.manifest, expected);
  for (const ordinal of [-1, 1, 32, 0.5, NaN]) await assert.rejects(decodeStoredOrdinaryAttachment(message, ordinal, expected.sha256));
  await assert.rejects(decodeStoredOrdinaryAttachment(message, 0, '0'.repeat(64)));
});

test('valid-looking manifest, headers or body edits cannot substitute decoded attachment content', async () => {
  const message = (await fixture().read()).items[0].message, expected = message.mime!.attachments[0];
  for (const delta of [{ filename: 'forged.pdf' }, { bytes: expected.bytes + 1 },
    { contentType: 'application/pdf' }, { sha256: '0'.repeat(64) }]) {
    const changed = { ...message, mime: { ...message.mime, attachments: [{ ...expected, ...delta }] } };
    assert.equal(inboundMessageSchema.safeParse(changed).success, true);
    await assert.rejects(decodeStoredOrdinaryAttachment(changed, 0, expected.sha256));
  }
  for (const delta of [{ body: 'forged' }, { sender: 'forged@invalid.test' }, { subject: 'forged' }])
    await assert.rejects(decodeStoredOrdinaryAttachment({ ...message, ...delta }, 0, expected.sha256));
});
