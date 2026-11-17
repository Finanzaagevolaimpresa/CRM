import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { verifiedOrdinaryAttachmentBytes, ORDINARY_ATTACHMENT_MAX_BYTES } from '../src/lib/ordinary-email-attachment-integrity';
import { INBOUND_MIME_MAX_BYTES } from '../src/lib/ordinary-email-inbound-contract';

const data = new TextEncoder().encode('SYNTHETIC attachment');
const expected = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
const response = (body: Uint8Array = data, headers: Record<string,string> = {}, status = 200) =>
  new Response(body as Uint8Array<ArrayBuffer>, { status, headers: { 'content-type': 'application/octet-stream', ...headers } });

for (const length of [undefined, String(data.length)]) {
  test('verified download accepts exact bytes and digest with Content-Length ' + String(length), async () => {
    const result = await verifiedOrdinaryAttachmentBytes(response(data, length ? { 'content-length': length } : {}), expected);
    assert.deepEqual(result, data);
  });
}

test('streamed download has a bounded accumulator and verifies all chunks', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(data.slice(0, 4)); controller.enqueue(data.slice(4)); controller.close();
  } });
  assert.deepEqual(await verifiedOrdinaryAttachmentBytes(
    new Response(stream, { headers: { 'content-type': 'application/octet-stream' } }), expected), data);
});

test('empty attachment is still checked against its signed empty digest', async () => {
  const empty = new Uint8Array();
  assert.deepEqual(await verifiedOrdinaryAttachmentBytes(response(empty),
    { bytes: 0, sha256: createHash('sha256').update(empty).digest('hex') }), empty);
});

for (const [name, value] of Object.entries({
  truncated: data.slice(1), extended: new Uint8Array(data.length + 1),
  altered: data.map((byte, index) => index === 0 ? byte ^ 1 : byte),
})) {
  test('download rejects ' + name + ' body even without Content-Length', async () => {
    await assert.rejects(verifiedOrdinaryAttachmentBytes(response(value), expected), /INTEGRITY/);
  });
}

test('oversized streamed body is cancelled before buffering additional bytes', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(data.length + 1));
  }, cancel() { cancelled = true; } });
  await assert.rejects(verifiedOrdinaryAttachmentBytes(
    new Response(stream, { headers: { 'content-type': 'application/octet-stream' } }), expected), /INTEGRITY/);
  assert.equal(cancelled, true);
});

for (const [name, value] of Object.entries({
  denied: () => response(data, {}, 404),
  html: () => response(data, { 'content-type': 'text/html' }),
  wrongLength: () => response(data, { 'content-length': String(data.length + 1) }),
  malformedLength: () => response(data, { 'content-length': 'invalid' }),
})) {
  test('download rejects ' + name + ' response before exposing bytes', async () => {
    await assert.rejects(verifiedOrdinaryAttachmentBytes(value(), expected), /UNAVAILABLE/);
  });
}

test('download rejects invalid signed metadata and shares the MIME upper bound', async () => {
  assert.equal(ORDINARY_ATTACHMENT_MAX_BYTES, INBOUND_MIME_MAX_BYTES);
  for (const bytes of [-1, 0.5, Number.NaN, ORDINARY_ATTACHMENT_MAX_BYTES + 1]) {
    await assert.rejects(verifiedOrdinaryAttachmentBytes(response(), { ...expected, bytes }), /INTEGRITY/);
  }
  await assert.rejects(verifiedOrdinaryAttachmentBytes(response(), { ...expected, sha256: 'invalid' }), /INTEGRITY/);
  await assert.rejects(verifiedOrdinaryAttachmentBytes(response(), { ...expected, sha256: '0'.repeat(64) }), /INTEGRITY/);
});
