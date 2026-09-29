import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { connect } from 'node:tls';
import { DIRECT_TEST_FROM, DIRECT_TEST_BODY, DIRECT_TEST_SUBJECT, readDirectTestConfig,
  signDirectTestPreview, verifyDirectTestPreview, type DirectTestConfig } from '../src/lib/direct-email-test';
import { directTestMime, sendDirectTestSmtp } from '../src/lib/direct-email-test-smtp';

const settings: DirectTestConfig = { reference: 'SYNTHETIC_TEST', recipient: 'controlled@example.test',
  host: 'smtp.example.test', password: 'synthetic-unusable-password', approvalKey: 'ab'.repeat(32) };
const env = { DIRECT_EMAIL_TEST_MODE: 'enforced', DIRECT_EMAIL_TEST_REFERENCE: settings.reference,
  DIRECT_EMAIL_TEST_RECIPIENT: settings.recipient, DIRECT_EMAIL_TEST_SMTP_HOST: settings.host,
  DIRECT_EMAIL_TEST_SMTP_PASSWORD: settings.password, DIRECT_EMAIL_TEST_APPROVAL_KEY: settings.approvalKey };
const id = `direct_test_${'a'.repeat(64)}`;
const control = () => ({ signal: new AbortController().signal, deadline: performance.now() + 15_000 });

test('direct email diagnostic is disabled unless all protected configuration is valid', () => {
  assert.equal(readDirectTestConfig({}), null);
  assert.deepEqual(readDirectTestConfig(env), settings);
  for (const key of Object.keys(env)) assert.equal(readDirectTestConfig({ ...env, [key]: undefined }), null);
  for (const recipient of ['a@example.test\r\nBcc: b@example.test', 'a@example.test,b@example.test', 'a@example.test>']) {
    assert.equal(readDirectTestConfig({ ...env, DIRECT_EMAIL_TEST_RECIPIENT: recipient }), null);
  }
  assert.equal(readDirectTestConfig({ ...env, DIRECT_EMAIL_TEST_SMTP_HOST: 'http://example.test' }), null);
});

test('approval is authenticated, expires and becomes unusable after configuration-key change', () => {
  const now = Date.now(), preview = { protocol: 'FAI_DIRECT_EMAIL_TEST_V1' as const, reference: settings.reference,
    snapshotHash: 'a'.repeat(64), expiresAt: now + 60_000 };
  const token = signDirectTestPreview(settings, preview);
  assert.deepEqual(verifyDirectTestPreview(settings, token, now), preview);
  assert.throws(() => verifyDirectTestPreview(settings, token, now + 60_000));
  assert.throws(() => verifyDirectTestPreview({ ...settings, approvalKey: 'cd'.repeat(32) }, token, now));
  assert.throws(() => verifyDirectTestPreview(settings, token.replace(/.$/, token.endsWith('a') ? 'b' : 'a'), now));
  assert.throws(() => verifyDirectTestPreview(settings, `${token}.extra`, now));
});

class FakeTls extends EventEmitter {
  authorized = true;
  writes: string[] = [];
  destroyed = false;
  constructor(private behavior: 'accepted' | 'auth-denied' | 'data-denied' | 'ambiguous' | 'invalid-reply') { super(); }
  setEncoding() { return this; }
  write(text: string) {
    this.writes.push(text);
    const code = text.startsWith('EHLO') ? '250-synthetic\r\n250 AUTH PLAIN\r\n'
      : text.startsWith('AUTH') ? (this.behavior === 'auth-denied' ? '535 denied\r\n' : '235 ok\r\n')
        : text.startsWith('MAIL') || text.startsWith('RCPT') ? '250 ok\r\n'
          : text === 'DATA\r\n' ? '354 go\r\n'
            : this.behavior === 'data-denied' ? '550 rejected\r\n' : this.behavior === 'invalid-reply' ? '999 invalid\r\n' : '250 queued\r\n';
    queueMicrotask(() => {
      if (text.startsWith('From:') && this.behavior === 'ambiguous') this.emit('error', new Error('synthetic timeout'));
      else { const middle = Math.floor(code.length / 2); this.emit('data', code.slice(0, middle)); this.emit('data', code.slice(middle)); }
    });
    return true;
  }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}
function transport(behavior: ConstructorParameters<typeof FakeTls>[0]) {
  const socket = new FakeTls(behavior);
  const factory = ((options: unknown) => {
    assert.deepEqual(options, { host: settings.host, port: 465, servername: settings.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    queueMicrotask(() => { socket.emit('secureConnect'); socket.emit('data', '220 synthetic\r\n'); });
    return socket;
  }) as unknown as typeof connect;
  return { socket, factory };
}
for (const [behavior, expected] of [['accepted', 'ACCEPTED'], ['auth-denied', 'NOT_SENT'], ['data-denied', 'NOT_SENT'],
  ['ambiguous', 'UNCERTAIN'], ['invalid-reply', 'UNCERTAIN']] as const) {
  test(`SMTP diagnostic ${behavior}: no retry and bounded single-recipient transport`, async () => {
    const mock = transport(behavior);
    assert.equal(await sendDirectTestSmtp(settings, id, control(), mock.factory), expected);
    assert.equal(mock.socket.writes.filter(row => row.startsWith('RCPT')).length, behavior === 'auth-denied' ? 0 : 1);
    assert.equal(mock.socket.writes.filter(row => row.startsWith('From:')).length, behavior === 'auth-denied' ? 0 : 1);
    assert.ok(mock.socket.destroyed);
    assert.ok(mock.socket.writes.every(row => !row.includes('STARTTLS')));
  });
}
test('fixed MIME message has exact visible content, no CC/BCC, attachment or credential', () => {
  const mime = directTestMime(settings, id);
  assert.ok(mime.includes(`From: ${DIRECT_TEST_FROM}\r\n`));
  assert.ok(mime.includes(`To: ${settings.recipient}\r\n`));
  const encodedSubject = mime.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)![1];
  assert.equal(Buffer.from(encodedSubject, 'base64').toString(), DIRECT_TEST_SUBJECT);
  const encodedBody = mime.split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, '').replaceAll('\r\n', '');
  assert.equal(Buffer.from(encodedBody, 'base64').toString(), DIRECT_TEST_BODY);
  assert.doesNotMatch(mime, /^Cc:|^Bcc:|multipart|Content-Disposition/im);
  assert.ok(!mime.includes(settings.password));
});

test('an unauthorized TLS connection never sends authentication or message bytes', async () => {
  const mock = transport('accepted'); mock.socket.authorized = false;
  assert.equal(await sendDirectTestSmtp(settings, id, control(), mock.factory), 'NOT_SENT');
  assert.equal(mock.socket.writes.length, 0);
});

test('a connection closed during TLS negotiation finishes without sending or retrying', async () => {
  const socket = new FakeTls('accepted');
  const factory = (() => { queueMicrotask(() => socket.emit('close')); return socket; }) as unknown as typeof connect;
  assert.equal(await sendDirectTestSmtp(settings, id, control(), factory), 'NOT_SENT');
  assert.equal(socket.writes.length, 0);
});

test('an already expired or aborted transport never opens a socket', async () => {
  const controller = new AbortController(); controller.abort();
  const factory = (() => { assert.fail('No socket may be opened'); }) as typeof connect;
  assert.equal(await sendDirectTestSmtp(settings, id, { signal: controller.signal, deadline: performance.now() + 1000 }, factory), 'NOT_SENT');
  assert.equal(await sendDirectTestSmtp(settings, id, { ...control(), deadline: performance.now() - 1 }, factory), 'NOT_SENT');
});

for (const cause of ['abort', 'deadline'] as const) test(`SMTP ${cause} closes a slow transport before DATA bytes and rejects late replies`, async () => {
  const mock = transport('accepted'), controller = new AbortController();
  const write = mock.socket.write.bind(mock.socket);
  mock.socket.write = text => {
    if (text !== 'DATA\r\n') return write(text);
    mock.socket.writes.push(text);
    if (cause === 'abort') setTimeout(() => controller.abort(), 10);
    return true;
  };
  const result = await sendDirectTestSmtp(settings, id, { signal: controller.signal,
    deadline: performance.now() + (cause === 'deadline' ? 30 : 1000) }, mock.factory);
  assert.equal(result, 'NOT_SENT'); assert.ok(mock.socket.destroyed);
  mock.socket.emit('data', '354 delayed reply\r\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mock.socket.writes.filter(text => text.startsWith('From:')).length, 0);
});
