import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';

type Purpose = 'preview' | 'grant';
export function selectiveProof(key: PrivilegedStepUpKey, purpose: Purpose, value: unknown) {
  return createHmac('sha256', key.secret).update(`FAI_SELECTIVE_PROJECT_V1:${purpose}:${key.version}:`).update(canonicalJson(value)).digest('hex');
}
export function verifySelectiveProof(key: PrivilegedStepUpKey, purpose: Purpose, value: unknown, proof: string) {
  return /^[a-f0-9]{64}$/.test(proof) && timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(selectiveProof(key, purpose, value), 'hex'));
}
