import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { selectiveLeadEditProof } from './selective-lead-edit-grant';
import { selectiveLeadEditCommandSchema, selectiveLeadEditSelectionSchema } from './selective-lead-edit-policy';

const generation = z.number().int().positive().max(2_147_483_647);
const kindSchema = z.enum(['selection', 'change']);
const admissionSchema = z.object({
  actorId: z.string().min(1).max(128), sessionId: z.string().uuid(),
  actorEpoch: generation, recipientEpoch: generation, leadEpoch: generation,
  authorityRevision: generation, readGrantRevision: generation,
  capabilityRevision: z.number().int().nonnegative().max(2_147_483_647),
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  validUntil: z.number().int().positive().safe(),
}).strict();
const payloadSchema = z.object({
  kind: kindSchema, input: z.union([selectiveLeadEditSelectionSchema, selectiveLeadEditCommandSchema]),
  admission: admissionSchema, keyVersion: generation,
  issuedAt: z.number().int().nonnegative().safe(), expires: z.number().int().positive().safe(),
}).strict();
const envelopeSchema = z.object({
  payload: payloadSchema, proof: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type LeadEditPreviewAdmission = z.infer<typeof admissionSchema>;
export type LeadEditPreviewKind = z.infer<typeof kindSchema>;
const lifetime = 5 * 60_000;
const maxTokenLength = 32_000;

function matchedInput(kind: LeadEditPreviewKind, raw: unknown, admission: LeadEditPreviewAdmission) {
  const input = kind === 'selection' ? selectiveLeadEditSelectionSchema.parse(raw) : selectiveLeadEditCommandSchema.parse(raw);
  const revision = input.protocol === 'SELECTIVE_LEAD_EDIT_SELECTION_V1' ? input.revision : input.capabilityRevision;
  if (revision !== admission.capabilityRevision || input.readGrantRevision !== admission.readGrantRevision) {
    throw new Error('SELECTIVE_LEAD_EDIT_PREVIEW_CONTEXT');
  }
  return input;
}

/** Caller supplies fresh locked session/authority/grant/data facts. validUntil is
 * the earliest applicable session, grant or capability expiry, never user input. */
export function createLeadEditPreview(kind: LeadEditPreviewKind, key: PrivilegedStepUpKey,
  raw: unknown, current: LeadEditPreviewAdmission, now: number) {
  const checkedKind = kindSchema.parse(kind), admission = admissionSchema.parse(current);
  if (!Number.isSafeInteger(now) || now < 0 || admission.validUntil <= now) throw new Error('SELECTIVE_LEAD_EDIT_PREVIEW_EXPIRED');
  const payload = payloadSchema.parse({ kind: checkedKind, input: matchedInput(checkedKind, raw, admission),
    admission, keyVersion: key.version, issuedAt: now, expires: Math.min(now + lifetime, admission.validUntil) });
  const purpose = checkedKind === 'selection' ? 'preview' : 'command-preview';
  const token = Buffer.from(canonicalJson({ payload, proof: selectiveLeadEditProof(key, purpose, payload) })).toString('base64url');
  if (token.length > maxTokenLength) throw new Error('SELECTIVE_LEAD_EDIT_PREVIEW_SIZE');
  return token;
}

export function readLeadEditPreview(kind: LeadEditPreviewKind, key: PrivilegedStepUpKey,
  token: string, current: LeadEditPreviewAdmission, now: number) {
  try {
    const checkedKind = kindSchema.parse(kind), admission = admissionSchema.parse(current);
    if (!Number.isSafeInteger(now) || now < 0 || token.length > maxTokenLength || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const raw = Buffer.from(token, 'base64url').toString('utf-8');
    if (Buffer.from(raw).toString('base64url') !== token) return null;
    const row = envelopeSchema.parse(JSON.parse(raw)), p = row.payload;
    if (canonicalJson(row) !== raw || p.kind !== checkedKind || p.keyVersion !== key.version
      || p.issuedAt > now || p.expires <= now || p.expires !== Math.min(p.issuedAt + lifetime, p.admission.validUntil)
      || canonicalJson(p.admission) !== canonicalJson(admission)) return null;
    const input = matchedInput(checkedKind, p.input, admission);
    const purpose = checkedKind === 'selection' ? 'preview' : 'command-preview';
    if (!timingSafeEqual(Buffer.from(row.proof, 'hex'), Buffer.from(selectiveLeadEditProof(key, purpose, p), 'hex'))) return null;
    return input;
  } catch { return null; }
}
