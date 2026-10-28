import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const projectHandoffInput = z.object({
  commandId: z.string().uuid(), projectId: id, expectedHash: hash,
  title: z.string().trim().min(1).max(240), practiceType: z.string().trim().min(1).max(120),
  targetEntity: z.string().trim().min(1).max(240),
  commercialOwnerId: id.nullable(), technicalOwnerId: id.nullable(),
}).strict();
export type ProjectHandoffInput = z.infer<typeof projectHandoffInput>;
export const projectHandoffPreview = z.object({ digest: hash, expiresAt: z.string().datetime(), proof: hash }).strict();
export type ProjectHandoffPreview = z.infer<typeof projectHandoffPreview>;
export const projectHandoffReceipt = z.object({
  type: z.literal('PROJECT_PRACTICE_PREPARATION_V1'), version: z.literal(1),
  sessionId: z.string().uuid(), clientId: id, projectId: id, technicalPracticeId: id,
  decisionId: id, fingerprint: hash,
}).strict();
export class ProjectHandoffError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'EXISTS' | 'EXPIRED') { super(`PROJECT_HANDOFF_${code}`); }
}
export function handoffProof(key: PrivilegedStepUpKey, value: unknown) {
  if (!Number.isSafeInteger(key.version) || key.version < 1 || key.secret.length < 32) throw new ProjectHandoffError('DENIED');
  return createHmac('sha256', key.secret).update(`FAI_PROJECT_PRACTICE_PREPARATION_V1:${key.version}:`).update(canonicalJson(value)).digest('hex');
}
export function verifyHandoffProof(key: PrivilegedStepUpKey, value: unknown, proof: string) {
  return hash.safeParse(proof).success && timingSafeEqual(Buffer.from(handoffProof(key, value), 'hex'), Buffer.from(proof, 'hex'));
}
