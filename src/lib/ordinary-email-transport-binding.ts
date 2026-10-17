import { createHmac, timingSafeEqual } from 'node:crypto';
import type { connect } from 'node:tls';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { ordinaryChannelSchema, type OrdinaryChannel } from './ordinary-email-candidate';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { OrdinaryAttemptLease } from './ordinary-email-smtp-candidate';

type Environment = Readonly<Record<string, string | undefined>>;
export type OrdinaryTransportSource = { readEnvironment(): Environment; connectTls: typeof connect };
const unavailable = () => new Error('ORDINARY_EMAIL_TRANSPORT_UNAVAILABLE');
const runtimeSchema = z.object({
  mode: z.literal('enforced'),
  reference: z.literal('R49_EMAIL_DIRECT_20260930_01'),
  host: z.literal('authsmtp.securemail.pro'),
  password: z.string().min(1).max(1024).refine(value => !value.includes('\0')),
}).strict();
const keySchema = z.object({ version: z.number().int().positive().max(2_147_483_647), secret: z.string().min(32) }).strict();

function material(channelInput: OrdinaryChannel, keyInput: PrivilegedStepUpKey, environment: Environment) {
  const channel = ordinaryChannelSchema.safeParse(channelInput), key = keySchema.safeParse(keyInput);
  // Read only the existing transport inputs. The diagnostic recipient, approval
  // key and previous ACCEPTED result are deliberately unrelated to this gate.
  const source = runtimeSchema.safeParse({ mode: environment.DIRECT_EMAIL_TEST_MODE,
    reference: environment.DIRECT_EMAIL_TEST_REFERENCE, host: environment.DIRECT_EMAIL_TEST_SMTP_HOST,
    password: environment.DIRECT_EMAIL_TEST_SMTP_PASSWORD });
  if (!channel.success || !key.success || !source.success) throw unavailable();
  const value = { protocol: 'FAI_ORDINARY_SMTP_TRANSPORT_V1', keyVersion: key.data.version,
    mailboxId: channel.data.mailboxId, mailboxRevision: channel.data.mailboxRevision,
    channelRevision: channel.data.channelRevision, purpose: channel.data.purpose,
    address: channel.data.address, providerReference: channel.data.providerReference,
    configurationReference: channel.data.configurationReference, sourceReference: source.data.reference,
    sourceMode: source.data.mode, host: source.data.host, port: 465, minVersion: 'TLSv1.2',
    rejectUnauthorized: true, credentialReference: 'DIRECT_EMAIL_TEST_SMTP_PASSWORD', password: source.data.password };
  const reference = 'ordinary-smtp-v1:' + key.data.version + ':' + createHmac('sha256', key.data.secret)
    .update('fai.ordinary-email.transport.v1\n' + canonicalJson(value)).digest('hex');
  return { channel: channel.data, reference, host: source.data.host, password: source.data.password };
}

/** Fingerprint preparation only, never qualification or activation. A distinct
 * authorized, audited operation must persist this value for the exact channel
 * revision after qualification. No writer, default row or automatic upgrade is
 * provided. The HMAC binds the credential without persisting an unkeyed hash. */
export function ordinaryTransportQualificationReference(channel: OrdinaryChannel, key: PrivilegedStepUpKey, environment: Environment) {
  try { return material(channel, key, environment).reference; } catch { throw unavailable(); }
}

/** Per-invocation server resolver. It can open no socket by itself. Each native
 * admission calls assertChannel under the current key/channel/context locks,
 * including the final reservation check and both sides of the DATA challenge.
 * The private SMTP service alone receives credential bytes after its claim. */
export function createOrdinaryTransportResolver(keyInput: PrivilegedStepUpKey, source: OrdinaryTransportSource) {
  const key = Object.freeze({ ...keyInput });
  let bound: Readonly<OrdinaryChannel> | undefined, bindingHash: string | undefined, credentialRead = false;
  function current(channel: OrdinaryChannel) {
    const value = material(channel, key, source.readEnvironment());
    const actual = Buffer.from(value.channel.qualificationReference), expected = Buffer.from(value.reference);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw unavailable();
    const hash = canonicalSha256(value.channel);
    if (bindingHash && bindingHash !== hash) throw unavailable();
    bound = Object.freeze({ ...value.channel }); bindingHash = hash;
    return value;
  }
  return {
    assertChannel(channel: OrdinaryChannel) {
      try { current(channel); } catch { throw unavailable(); }
    },
    async readQualifiedTransport(lease: OrdinaryAttemptLease) {
      if (!bound || credentialRead || !lease.committed || !z.string().uuid().safeParse(lease.attemptId).success
        || !z.string().uuid().safeParse(lease.leaseId).success || !Number.isFinite(Date.parse(lease.expiresAt))
        || Date.parse(lease.expiresAt) <= Date.now()) throw unavailable();
      credentialRead = true;
      try { const value = current(bound); return { host: value.host, password: value.password }; }
      catch { throw unavailable(); }
    },
    connectTls: source.connectTls,
  };
}
