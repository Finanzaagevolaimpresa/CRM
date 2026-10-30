import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { VideoCommand } from './video-input';

const lifetimeSeconds = 300;
const claimsSchema = z.object({ protocol: z.literal('VIDEO_DECISION_V2'), keyVersion: z.number().int().positive(),
  actorId: z.string().min(1).max(128), sessionId: z.string().uuid(), actorEpoch: z.number().int().positive(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), decisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive() }).strict();
type Identity = { actorId: string; sessionId: string; actorEpoch: number };
function sign(key: PrivilegedStepUpKey, payload: string) {
  return createHmac('sha256', key.secret).update('FAI_VIDEO_DECISION_V2.' + payload).digest();
}
export function createVideoDecision(key: PrivilegedStepUpKey, identity: Identity, command: VideoCommand,
  decisionHash: string, now: Date) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const claims = claimsSchema.parse({ protocol: 'VIDEO_DECISION_V2', keyVersion: key.version, ...identity,
    requestHash: canonicalSha256(command), decisionHash, issuedAt, expiresAt: issuedAt + lifetimeSeconds });
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return payload + '.' + sign(key, payload).toString('base64url');
}
export function verifyVideoDecision(key: PrivilegedStepUpKey, identity: Identity, command: VideoCommand,
  token: string, now: Date, options: { closing?: boolean } = {}) {
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('VIDEO_DECISION_INVALID');
  const [payload, signature] = token.split('.'), supplied = Buffer.from(signature, 'base64url'), expected = sign(key, payload);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('VIDEO_DECISION_INVALID');
  const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  const second = Math.floor(now.getTime() / 1000);
  if (claims.keyVersion !== key.version || claims.actorId !== identity.actorId || claims.sessionId !== identity.sessionId
    || claims.actorEpoch !== identity.actorEpoch || claims.requestHash !== canonicalSha256(command)
    || claims.expiresAt !== claims.issuedAt + lifetimeSeconds || claims.issuedAt > second
    || (!options.closing && second >= claims.expiresAt)) throw new Error('VIDEO_DECISION_INVALID');
  return claims;
}
