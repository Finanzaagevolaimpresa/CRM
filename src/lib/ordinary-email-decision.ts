import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { ApprovedMessageSnapshot } from './approved-communication-contract';
import { prepareOrdinaryEmail, type OrdinaryChannel } from './ordinary-email-candidate';
import { verifyPrivilegedStepUpToken, type PrivilegedStepUpKey } from './privileged-step-up-token';

/** Candidate contract only: no route, DB binding, reservation or transport.
 * The future service must load/lock this state itself in the same transaction
 * that uniquely consumes decisionId and commits its reservation plus audit.
 * A signed preview or returned decision alone never authorizes a socket. */
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(2_147_483_647);
const authoritySchema = z.object({
  id: z.literal('ordinary-email'), purpose: z.literal('ORDINARY_EMAIL'),
  userId: id, mailboxId: z.string().uuid(), revision, enabled: z.boolean(),
}).strict();
export type OrdinaryEmailAuthorityCandidate = z.infer<typeof authoritySchema>;
export type OrdinaryDecisionCurrentState = {
  actor: { userId: string; sessionId: string; role: string; active: boolean; expiresAt: Date; registryExpiresAt: Date };
  authority: OrdinaryEmailAuthorityCandidate;
  /** Hash of the currently locked ABAC/lifecycle context, never from a form. */
  contextHash: string;
};
type Material = { snapshot: ApprovedMessageSnapshot; channel: OrdinaryChannel; materials: Map<string, Buffer> };
const previewSchema = z.object({
  protocol: z.literal('FAI_ORDINARY_EMAIL_PREVIEW_V1'), decisionId: z.string().uuid(),
  intentHash: hash, mimeHash: hash, contextHash: hash,
  authorityId: z.literal('ordinary-email'), authorityRevision: revision,
  userId: id, sessionId: z.string().uuid(), mailboxId: z.string().uuid(), keyVersion: revision,
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();
type Preview = z.infer<typeof previewSchema>;
const ttl = 5 * 60_000;
export class OrdinaryDecisionError extends Error {
  constructor() { super('ORDINARY_PERSONAL_DECISION_DENIED'); }
}
function deny(): never { throw new OrdinaryDecisionError(); }
function requireKey(key: PrivilegedStepUpKey) {
  if (!Number.isSafeInteger(key.version) || key.version < 1 || key.version > 2_147_483_647 || key.secret.length < 32) deny();
}
function sign(key: PrivilegedStepUpKey, domain: 'preview' | 'decision', value: unknown) {
  requireKey(key);
  return createHmac('sha256', key.secret).update(`fai.ordinary-email.${domain}.v1\n${canonicalJson(value)}`).digest('hex');
}
function assertCurrent(state: OrdinaryDecisionCurrentState, channel: OrdinaryChannel, now: Date) {
  const binding = authoritySchema.safeParse(state.authority);
  if (!binding.success || !binding.data.enabled || !hash.safeParse(state.contextHash).success
    || !Number.isFinite(now.getTime()) || state.actor.role !== 'admin' || !state.actor.active
    || binding.data.userId !== state.actor.userId || binding.data.mailboxId !== channel.mailboxId
    || !z.string().uuid().safeParse(state.actor.sessionId).success
    || !Number.isFinite(state.actor.expiresAt.getTime()) || state.actor.expiresAt <= now
    || !Number.isFinite(state.actor.registryExpiresAt.getTime()) || state.actor.registryExpiresAt <= now) deny();
  return binding.data;
}
function parsePreview(token: string, key: PrivilegedStepUpKey) {
  if (token.length > 4096) deny();
  const match = /^oe1\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(token);
  if (!match) deny();
  try {
    const decoded = Buffer.from(match[1], 'base64url');
    if (decoded.toString('base64url') !== match[1]) deny();
    const payload = previewSchema.parse(JSON.parse(decoded.toString('utf8')));
    // Reject alternate serializations and duplicate JSON keys as well as fields.
    if (canonicalJson(payload) !== decoded.toString('utf8')) deny();
    const actual = Buffer.from(match[2], 'hex'), expected = Buffer.from(sign(key, 'preview', payload), 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || payload.keyVersion !== key.version) deny();
    return payload;
  } catch { return deny(); }
}

export function previewOrdinaryDecision(material: Material, current: OrdinaryDecisionCurrentState, key: PrivilegedStepUpKey, now: Date) {
  const authority = assertCurrent(current, material.channel, now);
  const prepared = prepareOrdinaryEmail(material.snapshot, material.channel, material.materials, now);
  const expiresAt = new Date(Math.min(now.getTime() + ttl, current.actor.expiresAt.getTime(), current.actor.registryExpiresAt.getTime()));
  const payload: Preview = previewSchema.parse({ protocol: 'FAI_ORDINARY_EMAIL_PREVIEW_V1', decisionId: randomUUID(),
    intentHash: prepared.intentHash, mimeHash: prepared.mimeHash, contextHash: current.contextHash,
    authorityId: authority.id, authorityRevision: authority.revision, userId: current.actor.userId,
    sessionId: current.actor.sessionId, mailboxId: material.channel.mailboxId, keyVersion: key.version,
    issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
  const token = `oe1.${Buffer.from(canonicalJson(payload)).toString('base64url')}.${sign(key, 'preview', payload)}`;
  return { token, summary: prepared.summary, expiresAt: payload.expiresAt };
}

export function confirmOrdinaryDecision(
  token: string, material: Material, current: OrdinaryDecisionCurrentState, key: PrivilegedStepUpKey,
  credentials: { sessionToken: string; stepUpToken: string | undefined }, now: Date,
) {
  const authority = assertCurrent(current, material.channel, now), preview = parsePreview(token, key);
  const issuedAt = new Date(preview.issuedAt), expiresAt = new Date(preview.expiresAt);
  if (issuedAt > now || expiresAt <= now || expiresAt.getTime() - issuedAt.getTime() > ttl || expiresAt <= issuedAt
    || preview.authorityId !== authority.id || preview.authorityRevision !== authority.revision
    || preview.userId !== current.actor.userId || preview.sessionId !== current.actor.sessionId
    || preview.mailboxId !== material.channel.mailboxId || preview.contextHash !== current.contextHash) deny();
  if (!verifyPrivilegedStepUpToken({ key, expectedUserId: current.actor.userId, sessionToken: credentials.sessionToken,
    token: credentials.stepUpToken, nowSeconds: Math.floor(now.getTime() / 1000) })) deny();
  const prepared = prepareOrdinaryEmail(material.snapshot, material.channel, material.materials, issuedAt);
  if (prepared.intentHash !== preview.intentHash || prepared.mimeHash !== preview.mimeHash) deny();
  const decision = Object.freeze({ protocol: 'FAI_ORDINARY_EMAIL_PERSONAL_DECISION_V1' as const,
    decisionId: preview.decisionId, intentHash: prepared.intentHash, mimeHash: prepared.mimeHash,
    messageId: material.snapshot.messageId, draftRevision: material.snapshot.revision, draftHash: prepared.intent.draftHash,
    preparedAt: preview.issuedAt, validUntil: preview.expiresAt,
    previewHash: createHash('sha256').update(token).digest('hex'), contextHash: current.contextHash,
    authorityId: authority.id, authorityRevision: authority.revision, actorId: current.actor.userId,
    sessionId: current.actor.sessionId, mailboxId: material.channel.mailboxId, mailboxRevision: material.channel.mailboxRevision,
    channelRevision: material.channel.channelRevision, keyVersion: key.version, approvedAt: now.toISOString() });
  return { decision, decisionHash: canonicalSha256(decision), proof: sign(key, 'decision', decision), prepared };
}
