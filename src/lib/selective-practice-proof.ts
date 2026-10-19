import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';

type Purpose = 'preview' | 'grant' | 'receipt';
const purposes: readonly string[] = ['preview', 'grant', 'receipt'];

/** Same approved key registry, distinct protocol: no project/email authority is inherited. */
export function selectivePracticeProof(key: PrivilegedStepUpKey, purpose: Purpose, value: unknown) {
  if (!Number.isSafeInteger(key.version) || key.version < 1 || key.secret.length < 32 || !purposes.includes(purpose)) {
    throw new TypeError('SELECTIVE_PRACTICE_PROOF_KEY_OR_PURPOSE_INVALID');
  }
  return createHmac('sha256', key.secret)
    .update(`FAI_SELECTIVE_PRACTICE_READ_V1:${purpose}:${key.version}:`)
    .update(canonicalJson(value)).digest('hex');
}

export function verifySelectivePracticeProof(key: PrivilegedStepUpKey, purpose: Purpose, value: unknown, proof: string) {
  if (!/^[a-f0-9]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(selectivePracticeProof(key, purpose, value), 'hex'));
}
