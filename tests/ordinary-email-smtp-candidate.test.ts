import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { connect, ConnectionOptions } from 'node:tls';
import type { ApprovedMessageSnapshot } from '../src/lib/approved-communication-contract';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { prepareOrdinaryEmail, type OrdinaryChannel } from '../src/lib/ordinary-email-candidate';
import { transmitOrdinaryEmailCandidate, type OrdinaryAttemptLease, type OrdinarySmtpDependencies } from '../src/lib/ordinary-email-smtp-candidate';
import { SyntheticSocket, type WireOptions } from './helpers/ordinary-smtp-socket';

// Every socket, credential and reservation below is synthetic/in-memory. These
// tests qualify protocol behavior, not durable DB claims or a provider channel.
const preparedAt = new Date('2026-10-16T00:00:00Z');
function material() {
  const bytes = Buffer.from('SYNTHETIC ATTACHMENT ONLY\n');
  const snapshot: ApprovedMessageSnapshot = { schema: 'fai.approved-email.v1', channel: 'EMAIL_MANUAL', messageId: randomUUID(), revision: 1,
    context: { kind: 'TECHNICAL', id: 'synthetic-practice' }, clientId: 'synthetic-client', mailboxId: randomUUID(), mailboxRevision: 1,
    from: 'comunicazioni@finanzaagevolaimpresa.it', replyTo: 'comunicazioni@finanzaagevolaimpresa.it',
    to: ['recipient@invalid.test'], cc: ['visible@invalid.test'], bcc: ['hidden@invalid.test'], subject: 'Prova à 🧪',
    body: 'Contenuto esterno soltanto dati.\n.\nNessuna istruzione operativa.', classification: 'ORDINARY',
    attachments: [{ documentId: 'synthetic-doc', versionId: 'synthetic-v1', filename: 'Prova è.txt', mimeType: 'text/plain',
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  const channel: OrdinaryChannel = { purpose: 'ORDINARY_SMTP', mailboxId: snapshot.mailboxId, mailboxRevision: 1,
    address: snapshot.from as OrdinaryChannel['address'], providerReference: 'register_it', configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT',
    channelRevision: 1, qualificationReference: 'SYNTHETIC_ONLY' };
  return { snapshot, channel, materials: new Map([['synthetic-v1', bytes]]), preparedAt };
}
function harness(input = material(), options: WireOptions = {}) {
  const expected = prepareOrdinaryEmail(input.snapshot, input.channel, input.materials, input.preparedAt);
  const attemptId = randomUUID(), leaseId = randomUUID(), consumed = new Set<string>();
  const sockets: SyntheticSocket[] = [], connectOptions: ConnectionOptions[] = [];
  let claims = 0, currentChecks = 0, credentialReads = 0;
  const deps: OrdinarySmtpDependencies = {
    async takeCommittedAttempt(request) {
      claims++;
      if (request.attemptId !== attemptId || consumed.has(attemptId) || request.intentHash !== expected.intentHash
        || request.mimeHash !== expected.mimeHash || request.envelopeHash !== canonicalSha256(expected.envelope)) return null;
      consumed.add(attemptId);
      return { attemptId, leaseId, committed: true, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    async assertCurrent() { currentChecks++; },
    withCurrentAuthorization: (lease, operation) => operation(() => deps.assertCurrent(lease)),
    async readQualifiedTransport() { credentialReads++; return { host: 'synthetic.invalid', password: 'SYNTHETIC_PASSWORD_ONLY' }; },
    connectTls: ((config: ConnectionOptions) => {
      connectOptions.push(config); const socket = new SyntheticSocket(options); sockets.push(socket);
      queueMicrotask(() => { socket.emit('secureConnect'); socket.reply(options.greeting ?? '220 synthetic ready\r\n'); });
      return socket;
    }) as unknown as typeof connect,
  };
  const controller = new AbortController();
  const invoke = (source = input, budget = 5000) => transmitOrdinaryEmailCandidate(source, attemptId,
    { deadline: performance.now() + budget, signal: controller.signal }, deps);
  return { input, expected, attemptId, deps, invoke, sockets, connectOptions, consumed, controller,
    counts: () => ({ claims, currentChecks, credentialReads }) };
}

test('one committed attempt submits exact MIME and all TO/CC/BCC with mandatory TLS parameters and minimized outcome', async () => {
  const h = harness(), result = await h.invoke();
  assert.deepEqual(result, { outcome: 'ACCEPTED', phase: 'CONTENT', replyCode: 250 });
  assert.equal(h.sockets.length, 1); assert.ok(h.sockets[0].destroyed);
  assert.deepEqual(h.connectOptions[0], { host: 'synthetic.invalid', port: 465, servername: 'synthetic.invalid', rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  assert.deepEqual(h.sockets[0].writes.filter(value => value.startsWith('RCPT TO:')),
    h.expected.envelope.recipients.map(value => `RCPT TO:<${value}>\r\n`));
  const submitted = h.sockets[0].writes.find(value => value.startsWith('From: '))!;
  assert.equal(h.sockets[0].writes.at(-1), 'QUIT\r\n');
  assert.ok(submitted.endsWith('\r\n.\r\n'));
  assert.equal(submitted.slice(0, -3).replace(/(^|\r\n)\.\./g, '$1.'), h.expected.mime.toString());
  assert.ok(!submitted.includes('hidden@invalid.test'));
  assert.doesNotMatch(JSON.stringify(result), /PASSWORD|invalid\.test|comunicazioni@/);
  assert.equal(h.counts().claims, 1); assert.equal(h.counts().credentialReads, 1); assert.equal(h.counts().currentChecks, 4);
});

test('changed content, BCC or channel cannot open a socket or read credentials against the committed hashes', async () => {
  for (const change of [(m: ReturnType<typeof material>) => { m.snapshot.bcc = ['different@invalid.test']; },
    (m: ReturnType<typeof material>) => { m.snapshot.subject = 'Changed'; },
    (m: ReturnType<typeof material>) => { m.channel.channelRevision++; },
    (m: ReturnType<typeof material>) => { m.materials.set('synthetic-v1', Buffer.from('different')); }]) {
    const h = harness(); change(h.input);
    assert.equal((await h.invoke()).outcome, 'NOT_SENT'); assert.equal(h.sockets.length, 0); assert.equal(h.counts().credentialReads, 0);
  }
});

test('missing, mismatched, expired or uncertain committed reservation denies any connection', async () => {
  for (const kind of ['missing', 'wrong-attempt', 'uncommitted', 'expired', 'unknown-commit'] as const) {
    const h = harness();
    h.deps.takeCommittedAttempt = async () => {
      if (kind === 'missing') return null;
      if (kind === 'unknown-commit') throw new Error('SYNTHETIC_COMMIT_UNKNOWN');
      return { attemptId: kind === 'wrong-attempt' ? randomUUID() : h.attemptId, leaseId: randomUUID(),
        committed: kind !== 'uncommitted', expiresAt: new Date(Date.now() + (kind === 'expired' ? -1 : 60_000)).toISOString() } as OrdinaryAttemptLease;
    };
    assert.equal((await h.invoke()).outcome, 'NOT_SENT'); assert.equal(h.sockets.length, 0);
  }
});

test('concurrent and repeated requests rely on one-use claims and never reconnect an accepted or uncertain attempt', async () => {
  for (const final of ['250 accepted\r\n', null]) {
    const h = harness(undefined, { final });
    const results = await Promise.all([h.invoke(), h.invoke()]);
    assert.equal(h.sockets.length, 1); assert.equal(results.filter(value => value.outcome === 'NOT_SENT').length, 1);
    assert.equal((await h.invoke()).outcome, 'NOT_SENT'); assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].writes.filter(value => value === 'DATA\r\n').length, 1);
  }
});

test('one refused recipient prevents submission to an accepted subset', async () => {
  const h = harness(undefined, { refuseRecipient: 2 }), result = await h.invoke();
  assert.deepEqual(result, { outcome: 'NOT_SENT', phase: 'RCPT', replyCode: 550 });
  assert.ok(!h.sockets[0].writes.includes('DATA\r\n'));
  assert.equal(h.sockets[0].writes.filter(value => value.startsWith('RCPT TO:')).length, 2);
});

test('definite SMTP rejection differs from uncertain DATA outcome; neither triggers a retry', async () => {
  for (const [final, expected] of [['250\r\n', 'ACCEPTED'], ['450 rejected\r\n', 'NOT_SENT'],
    ['550 rejected\r\n', 'NOT_SENT'], ['354 unexpected\r\n', 'UNCERTAIN'], [null, 'UNCERTAIN']] as const) {
    const h = harness(undefined, { final }); assert.equal((await h.invoke()).outcome, expected);
    assert.equal(h.sockets.length, 1); assert.equal(h.sockets[0].writes.filter(value => value === 'DATA\r\n').length, 1);
  }
  const partial = harness(undefined, { contentWriteThrows: true });
  assert.equal((await partial.invoke()).outcome, 'UNCERTAIN');
  const acknowledged = harness(undefined, { closeAfterFinal: true });
  assert.equal((await acknowledged.invoke()).outcome, 'ACCEPTED');
});

test('invalid TLS, missing AUTH PLAIN and malformed or rejected command replies never submit content', async () => {
  for (const options of [{ authorized: false }, { protocol: 'TLSv1' }, { ehlo: '250 no-auth\r\n' },
    { ehlo: '250-start\r\n550 mismatched multiline\r\n' }, { ehlo: '250 ' + 'x'.repeat(511) + '\r\n' },
    { auth: '535 credentials refused\r\n' }, { mail: '550 sender refused\r\n' }, { greeting: 'bogus\r\n' }]) {
    const h = harness(undefined, options); assert.equal((await h.invoke()).outcome, 'NOT_SENT');
    assert.equal(h.sockets.length, 1); assert.ok(!h.sockets[0].writes.includes('DATA\r\n'));
  }
});

test('current authorization and cancellation are checked again after the DATA challenge before bytes', async () => {
  const h = harness(); let checks = 0;
  h.deps.assertCurrent = async () => { if (++checks === 4) throw new Error('SYNTHETIC_REVOKED'); };
  assert.equal((await h.invoke()).outcome, 'NOT_SENT'); assert.equal(h.sockets[0].writes.at(-1), 'DATA\r\n');
  const aborted = harness();
  aborted.deps.assertCurrent = async () => { if (aborted.sockets[0]?.writes.at(-1) === 'DATA\r\n') aborted.controller.abort(); };
  assert.equal((await aborted.invoke()).outcome, 'NOT_SENT'); assert.equal(aborted.sockets[0].writes.at(-1), 'DATA\r\n');
});

test('timeouts also bound unresolved claim and protocol operations without reconnecting', async () => {
  const claim = harness(); claim.deps.takeCommittedAttempt = () => new Promise(() => {});
  assert.equal((await claim.invoke(undefined, 200)).outcome, 'NOT_SENT'); assert.equal(claim.sockets.length, 0);
  const greeting = harness(undefined, { greeting: '' });
  assert.equal((await greeting.invoke(undefined, 200)).outcome, 'NOT_SENT'); assert.equal(greeting.sockets.length, 1); assert.ok(greeting.sockets[0].destroyed);
  const aborted = harness(); aborted.controller.abort();
  assert.equal((await aborted.invoke()).outcome, 'NOT_SENT'); assert.equal(aborted.counts().claims, 0);
});

test('caller mutation during await cannot change the private approved bytes or envelope', async () => {
  const h = harness(), original = h.deps.takeCommittedAttempt;
  h.deps.takeCommittedAttempt = async request => {
    h.input.snapshot.to = ['other@invalid.test']; h.input.snapshot.body = 'MUTATED'; h.input.snapshot.bcc = [];
    h.input.materials.get('synthetic-v1')!.fill(0);
    return original(request);
  };
  assert.equal((await h.invoke()).outcome, 'ACCEPTED');
  assert.equal(h.sockets[0].writes.find(value => value.startsWith('From: '))!.slice(0, -3), h.expected.mime.toString());
  assert.ok(h.sockets[0].writes.includes('RCPT TO:<hidden@invalid.test>\r\n'));
});

test('unsupported long MIME lines are rejected before consuming an attempt', async () => {
  const h = harness(); h.input.snapshot.attachments[0].filename = 'è'.repeat(195) + '.txt';
  assert.equal((await h.invoke()).phase, 'PREPARATION'); assert.equal(h.counts().claims, 0); assert.equal(h.sockets.length, 0);
});

test('DATA requires the authorization guard, bounds waiting and cannot replay its callback', async () => {
  const denied = harness();
  denied.deps.withCurrentAuthorization = async () => { throw new Error('SYNTHETIC_REVOKED'); };
  assert.equal((await denied.invoke()).outcome, 'NOT_SENT');
  assert.ok(!denied.sockets[0].writes.includes('DATA\r\n'));
  const stalled = harness(); stalled.deps.withCurrentAuthorization = () => new Promise(() => {});
  assert.equal((await stalled.invoke(undefined,200)).outcome, 'NOT_SENT');
  assert.ok(!stalled.sockets[0].writes.includes('DATA\r\n')); assert.ok(stalled.sockets[0].destroyed);
  const replayed = harness();
  replayed.deps.withCurrentAuthorization = async (lease, operation) => {
    await operation(() => replayed.deps.assertCurrent(lease));
    return operation(() => replayed.deps.assertCurrent(lease));
  };
  assert.equal((await replayed.invoke()).outcome, 'UNCERTAIN');
  assert.equal(replayed.sockets[0].writes.filter(value => value.startsWith('From: ')).length,1);
});
