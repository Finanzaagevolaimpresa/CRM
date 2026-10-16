import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { connect } from 'node:tls';
import type { OrdinaryChannel } from '../src/lib/ordinary-email-candidate';
import { createOrdinaryTransportResolver, ordinaryTransportQualificationReference } from '../src/lib/ordinary-email-transport-binding';

const key = { version: 7, secret: 'SYNTHETIC_ORDINARY_TRANSPORT_KEY_0000000000000' };
const environment = () => ({ DIRECT_EMAIL_TEST_MODE: 'enforced', DIRECT_EMAIL_TEST_REFERENCE: 'R49_EMAIL_DIRECT_20260930_01',
  DIRECT_EMAIL_TEST_SMTP_HOST: 'authsmtp.securemail.pro', DIRECT_EMAIL_TEST_SMTP_PASSWORD: 'SYNTHETIC_TRANSPORT_PASSWORD_ONLY' });
function channel(): OrdinaryChannel {
  return { purpose: 'ORDINARY_SMTP', mailboxId: randomUUID(), mailboxRevision: 2, channelRevision: 3,
    address: 'comunicazioni@finanzaagevolaimpresa.it', providerReference: 'register_it',
    configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT', qualificationReference: 'SYNTHETIC_UNQUALIFIED' };
}
const lease = () => ({ committed: true as const, attemptId: randomUUID(), leaseId: randomUUID(),
  expiresAt: new Date(Date.now() + 10_000).toISOString() });
function harness() {
  const env: Record<string, string | undefined> = environment(), box = channel();
  box.qualificationReference = ordinaryTransportQualificationReference(box, key, env);
  let connections = 0;
  const resolver = createOrdinaryTransportResolver(key, { readEnvironment: () => env,
    connectTls: (() => { connections++; throw new Error('NO_NETWORK_IN_UNIT_TEST'); }) as typeof connect });
  return { box, env, resolver, connections: () => connections };
}

test('diagnostic and manual qualification alone never expose credentials or open a socket', async () => {
  const h = harness(), box = channel();
  for (const qualificationReference of ['SYNTHETIC_ORDINARY_ONLY', 'MANUAL_EXTERNAL', 'ACCEPTED', 'R49_EMAIL_DIRECT_20260930_01']) {
    assert.throws(() => h.resolver.assertChannel({ ...box, qualificationReference }), /TRANSPORT_UNAVAILABLE/);
    await assert.rejects(h.resolver.readQualifiedTransport(lease()), /TRANSPORT_UNAVAILABLE/);
  }
  assert.equal(h.connections(), 0);
});

test('exact qualification reconciles both configuration references and only returns private transport once', async () => {
  const h = harness();
  for (const forbidden of ['DIRECT_EMAIL_TEST_RECIPIENT', 'DIRECT_EMAIL_TEST_APPROVAL_KEY']) {
    Object.defineProperty(h.env, forbidden, { get() { throw new Error('DIAGNOSTIC_VALUE_MUST_NOT_BE_READ'); } });
  }
  h.resolver.assertChannel(h.box);
  assert.deepEqual(await h.resolver.readQualifiedTransport(lease()),
    { host: 'authsmtp.securemail.pro', password: h.env.DIRECT_EMAIL_TEST_SMTP_PASSWORD });
  await assert.rejects(h.resolver.readQualifiedTransport(lease()), /TRANSPORT_UNAVAILABLE/);
  assert.equal(h.connections(), 0);
  assert.ok(!JSON.stringify(h.resolver).includes('SYNTHETIC_TRANSPORT_PASSWORD'));
  assert.ok(h.box.qualificationReference.length <= 128);
  assert.ok(!h.box.qualificationReference.includes(h.env.DIRECT_EMAIL_TEST_SMTP_PASSWORD!));
});

test('credential rotation or absent source invalidates a persisted qualification without fallback', async () => {
  for (const change of ['password', 'host', 'reference', 'mode', 'absent'] as const) {
    const h = harness(); h.resolver.assertChannel(h.box);
    if (change === 'password') h.env.DIRECT_EMAIL_TEST_SMTP_PASSWORD = 'SYNTHETIC_CHANGED_PASSWORD';
    if (change === 'host') h.env.DIRECT_EMAIL_TEST_SMTP_HOST = 'other.invalid';
    if (change === 'reference') h.env.DIRECT_EMAIL_TEST_REFERENCE = 'OTHER_REFERENCE';
    if (change === 'mode') h.env.DIRECT_EMAIL_TEST_MODE = 'disabled';
    if (change === 'absent') delete h.env.DIRECT_EMAIL_TEST_SMTP_PASSWORD;
    assert.throws(() => h.resolver.assertChannel(h.box), /TRANSPORT_UNAVAILABLE/);
    await assert.rejects(h.resolver.readQualifiedTransport(lease()), /TRANSPORT_UNAVAILABLE/);
    assert.equal(h.connections(), 0);
  }
});

test('qualification binds mailbox, both revisions, native key and exact source credential', () => {
  const h = harness(), reference = h.box.qualificationReference;
  for (const box of [{ ...h.box, mailboxId: randomUUID() }, { ...h.box, mailboxRevision: 3 }, { ...h.box, channelRevision: 4 }]) {
    assert.notEqual(ordinaryTransportQualificationReference(box, key, h.env), reference);
    assert.throws(() => h.resolver.assertChannel(box), /TRANSPORT_UNAVAILABLE/);
  }
  assert.notEqual(ordinaryTransportQualificationReference(h.box, { ...key, version: 8 }, h.env), reference);
  assert.notEqual(ordinaryTransportQualificationReference(h.box, { ...key, secret: key.secret + 'x' }, h.env), reference);
});

test('resolver cannot widen to another newly qualified channel within the same invocation', () => {
  const h = harness(); h.resolver.assertChannel(h.box);
  const changed = { ...h.box, channelRevision: h.box.channelRevision + 1 };
  changed.qualificationReference = ordinaryTransportQualificationReference(changed, key, h.env);
  assert.throws(() => h.resolver.assertChannel(changed), /TRANSPORT_UNAVAILABLE/);
  h.resolver.assertChannel(h.box);
});

test('invalid source and key errors are minimized and never contain credential input', () => {
  for (const password of ['', 'SYNTHETIC_PRIVATE\0PASSWORD', 'x'.repeat(1025)]) {
    assert.throws(() => ordinaryTransportQualificationReference(channel(), key,
      { ...environment(), DIRECT_EMAIL_TEST_SMTP_PASSWORD: password }), error => {
      assert.equal((error as Error).message, 'ORDINARY_EMAIL_TRANSPORT_UNAVAILABLE'); return true;
    });
  }
  assert.throws(() => ordinaryTransportQualificationReference(channel(), { version: 0, secret: 'short' }, environment()), /TRANSPORT_UNAVAILABLE/);
});

test('uncommitted, expired or malformed leases never release private transport', async () => {
  for (const invalid of [{ ...lease(), committed: false }, { ...lease(), expiresAt: 'invalid' },
    { ...lease(), expiresAt: new Date(0).toISOString() }, { ...lease(), attemptId: 'wrong' }]) {
    const h = harness(); h.resolver.assertChannel(h.box);
    await assert.rejects(h.resolver.readQualifiedTransport(invalid as ReturnType<typeof lease>), /TRANSPORT_UNAVAILABLE/);
    assert.equal(h.connections(), 0);
  }
});
