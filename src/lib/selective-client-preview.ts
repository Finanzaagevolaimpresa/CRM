import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { selectiveClientSelectionSchema } from './selective-client-policy';
import { selectiveClientProof, verifySelectiveClientProof } from './selective-client-proof';

const identifier = z.string().min(1).max(128);
const generation = z.number().int().positive().safe();
const admissionSchema = z.object({
  actorId: identifier, sessionId: z.string().uuid(), authorityRevision: generation,
  actorEpoch: generation, recipientEpoch: generation, clientEpoch: generation,
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const payloadSchema = z.object({
  input: selectiveClientSelectionSchema, admission: admissionSchema, keyVersion: generation,
  issuedAt: z.number().int().nonnegative().safe(), expires: z.number().int().positive().safe(),
}).strict();
const envelopeSchema = z.object({ payload: payloadSchema, proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type SelectiveClientPreviewAdmission = z.infer<typeof admissionSchema>;
const lifetime = 5 * 60_000;

/** Pure evidence only. The caller must establish current personal authority and
 * session admission under database locks; a preview never creates a grant. */
export function createSelectiveClientPreview(key: PrivilegedStepUpKey, input: unknown,
  admission: SelectiveClientPreviewAdmission, now: number) {
  const payload = payloadSchema.parse({ input, admission, keyVersion: key.version, issuedAt: now, expires: now + lifetime });
  if (payload.input.expiresAt && new Date(payload.input.expiresAt).getTime() <= now) throw new Error('SELECTIVE_CLIENT_PREVIEW_EXPIRED');
  return Buffer.from(canonicalJson({ payload, proof: selectiveClientProof(key, 'preview', payload) })).toString('base64url');
}

/** Re-evaluate after any lock wait, using fresh epochs/state from the database.
 * There is deliberately no fallback to a project/email authority or old scope. */
export function readSelectiveClientPreview(token: string, key: PrivilegedStepUpKey,
  current: SelectiveClientPreviewAdmission, now: number) {
  try {
    if (!Number.isSafeInteger(now) || now < 0 || token.length > 24_000 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const raw = Buffer.from(token, 'base64url').toString('utf-8');
    if (Buffer.from(raw).toString('base64url') !== token) return null;
    const envelope = envelopeSchema.parse(JSON.parse(raw));
    if (canonicalJson(envelope) !== raw) return null;
    const p = envelope.payload;
    if (p.input.version !== 3 && token.length > 12_000) return null;
    if (p.keyVersion !== key.version || p.issuedAt > now || p.expires <= now || p.expires - p.issuedAt !== lifetime
      || (p.input.expiresAt && new Date(p.input.expiresAt).getTime() <= now)
      || canonicalJson(p.admission) !== canonicalJson(admissionSchema.parse(current))
      || !verifySelectiveClientProof(key, 'preview', p, envelope.proof)) return null;
    return p.input;
  } catch { return null; }
}
