import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { PROPOSED_POLICY, validReadiness, type Readiness } from './marketing-preferences/policy';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({
  protocol: z.literal('FAI_NEWSLETTER_NATIVE_POLICY_V1'), policyVersion: z.literal(PROPOSED_POLICY.version),
  approvalReference: z.string().trim().min(8).max(200), qualificationReference: z.string().trim().min(8).max(200),
  effectiveFrom: z.string().datetime(), effectiveUntil: z.string().datetime(),
  purposeOpen: z.boolean(), epoch: z.string().uuid(), keyFingerprint: hash,
  keyPath: z.string().min(1).max(1024), maxTicketAgeMs: z.number().int().positive().max(60_000),
  approvedEmailNotices: z.array(z.object({ noticeVersionId: z.string().uuid(), contentHash: hash }).strict()).min(1).max(100),
  unsubscribeUrl: z.string().url().max(1024), unsubscribeQualificationReference: z.string().trim().min(8).max(200),
}).strict();
export type NativeNewsletterPolicy = Readonly<{ key: Uint8Array; readiness: Readiness; bindingHash: string;
  qualificationReference: string; unsubscribeUrl: string; policyReference: string }>;
/** Private server dependency only. No action accepts a policy source from a client. */
export type NativeNewsletterPolicySource = (now: Date) => Promise<NativeNewsletterPolicy>;
const denied = () => new Error('NEWSLETTER_POLICY_UNAVAILABLE');

export function parseNativeNewsletterPolicy(raw: unknown, key: Uint8Array, now: Date): NativeNewsletterPolicy {
  const value = manifestSchema.parse(raw), url = new URL(value.unsubscribeUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || key.length !== 32
    || createHash('sha256').update(key).digest('hex') !== value.keyFingerprint) throw denied();
  const { qualificationReference, unsubscribeUrl } = value;
  const readiness: Readiness = { policyVersion: value.policyVersion, approvalReference: value.approvalReference,
    effectiveFrom: value.effectiveFrom, effectiveUntil: value.effectiveUntil, purposeOpen: value.purposeOpen,
    epoch: value.epoch, keyFingerprint: value.keyFingerprint, maxTicketAgeMs: value.maxTicketAgeMs,
    approvedEmailNotices: value.approvedEmailNotices, checkedAt: now.toISOString(), reconciled: true };
  if (!validReadiness(readiness, now.toISOString())) throw denied();
  return { key: Buffer.from(key), readiness, bindingHash: canonicalSha256(value), qualificationReference,
    unsubscribeUrl, policyReference: value.approvalReference };
}

async function privateBytes(path: string, maximum: number) {
  if (!isAbsolute(path) || typeof process.getuid !== 'function' || await realpath(path) !== resolve(path)) throw denied();
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
    || before.uid !== process.getuid() || before.size < 1 || before.size > maximum) throw denied();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await file.stat();
    if (actual.ino !== before.ino || actual.dev !== before.dev || actual.size !== before.size || actual.mtimeMs !== before.mtimeMs) throw denied();
    const bytes = Buffer.alloc(maximum + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (bytesRead !== actual.size || bytesRead > maximum || after.mtimeMs !== actual.mtimeMs || after.size !== actual.size) throw denied();
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

/** Reads an explicitly provisioned, hash-bound policy and dedicated R13 key.
 * It never provisions either file, policy approval, epoch or sender authority.
 * Missing/unreadable/mismatched material fails closed, including on non-POSIX. */
async function readPrivatePolicyCredential() {
  const path = process.env.WORKFLOW_NEWSLETTER_POLICY_FILE, expected = process.env.WORKFLOW_NEWSLETTER_POLICY_SHA256;
  if (!path || !hash.safeParse(expected).success) throw denied();
  const bytes = await privateBytes(path, 65_536);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw denied();
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const encoded = new TextDecoder('utf-8', { fatal: true }).decode(await privateBytes(manifest.keyPath, 128)).trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded
    || createHash('sha256').update(key).digest('hex') !== manifest.keyFingerprint) throw denied();
  const origin = process.env.APP_ORIGIN;
  if (!origin || new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:'
    || manifest.unsubscribeUrl !== origin + '/preferenze-email') throw denied();
  return { manifest, key, publicOrigin: origin };
}

/** Opt-out is a suppression only. It remains usable when sending is disabled
 * or its policy has expired/closed; the credential and explicit withdrawal gate
 * still have to be valid. It grants no sender identity or dispatch authority. */
export async function readNewsletterWithdrawalCredential() {
  try {
    if (process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE !== 'enabled') throw denied();
    const { key, manifest, publicOrigin } = await readPrivatePolicyCredential();
    return { key, publicOrigin, unsubscribeUrl: manifest.unsubscribeUrl, epoch: manifest.epoch, keyFingerprint: manifest.keyFingerprint };
  } catch { throw denied(); }
}

export const readNativeNewsletterPolicy: NativeNewsletterPolicySource = async now => {
  try {
    if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled'
      || process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE !== 'enabled') throw denied();
    const { manifest, key } = await readPrivatePolicyCredential();
    return parseNativeNewsletterPolicy(manifest, key, now);
  } catch { throw denied(); }
};
