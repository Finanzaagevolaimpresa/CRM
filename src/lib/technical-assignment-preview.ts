import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { boundedAssignmentExpiry, technicalAssignmentCommand, technicalAssignmentRevocation } from './technical-assignment-contract';
import { technicalAssignmentProof } from './technical-assignment-proof';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const generation = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const operationSchema = z.enum(['ASSIGN', 'REVOKE']);
const admissionSchema = z.object({
  actorId: id, sessionId: z.string().uuid(), authorityRevision: generation,
  actorEpoch: generation, recipientEpoch: generation,
  kind: z.enum(['Project', 'TechnicalPractice']), targetId: id, recipientId: id,
  assignmentId: z.string().uuid().nullable(),
  assignmentRevision: z.number().int().nonnegative().max(2_147_483_646),
  assignmentStateSha256: hash.nullable(), contextSha256: hash,
  validUntil: z.number().int().positive().safe(),
}).strict().superRefine((value, ctx) => {
  if (value.actorId === value.recipientId || (value.assignmentRevision === 0
    ? value.assignmentId !== null || value.assignmentStateSha256 !== null
    : value.assignmentId === null || value.assignmentStateSha256 === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent current assignment context' });
  }
});
const payloadSchema = z.object({
  protocol: z.literal('TECHNICAL_ASSIGNMENT_PREVIEW_V1'), operation: operationSchema,
  input: z.union([technicalAssignmentCommand, technicalAssignmentRevocation]),
  admission: admissionSchema, keyVersion: generation,
  issuedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe(),
}).strict();
const envelopeSchema = z.object({ payload: payloadSchema, proof: hash }).strict();
const lifetime = 5 * 60_000;
const maxTokenLength = 32_000;

export type TechnicalAssignmentPreviewAdmission = z.infer<typeof admissionSchema>;
export type TechnicalAssignmentPreviewOperation = z.infer<typeof operationSchema>;

function matchedInput(operation: TechnicalAssignmentPreviewOperation, raw: unknown,
  current: TechnicalAssignmentPreviewAdmission, now: number) {
  const input = operation === 'ASSIGN' ? technicalAssignmentCommand.parse(raw) : technicalAssignmentRevocation.parse(raw);
  if (input.expectedRevision !== current.assignmentRevision || input.expectedContextSha256 !== current.contextSha256) {
    throw new Error('TECHNICAL_ASSIGNMENT_PREVIEW_STALE');
  }
  if ('selection' in input) {
    if (input.targetId !== current.targetId || input.selection.kind !== current.kind
      || input.selection.userId !== current.recipientId || input.expectedRecipientEpoch !== current.recipientEpoch
      || !boundedAssignmentExpiry(input.selection.expiresAt, new Date(now))) {
      throw new Error('TECHNICAL_ASSIGNMENT_PREVIEW_SCOPE');
    }
  } else if (!current.assignmentId || input.assignmentId !== current.assignmentId) {
    throw new Error('TECHNICAL_ASSIGNMENT_PREVIEW_SCOPE');
  }
  return input;
}

function expiry(input: z.infer<typeof payloadSchema>['input'], issuedAt: number, validUntil: number) {
  return Math.min(issuedAt + lifetime, validUntil,
    'selection' in input ? Date.parse(input.selection.expiresAt) : Number.POSITIVE_INFINITY);
}

/** Pure preview preparation only; no route imports this yet. The caller must
 * build admission from the locked session, personal authority, recipient,
 * canonical target, retained journal and current document/permission checks.
 * validUntil is their earliest applicable expiry, never submitted form data.
 * A preview is neither an assignment nor a consumed personal decision. */
export function createTechnicalAssignmentPreview(operation: TechnicalAssignmentPreviewOperation,
  key: PrivilegedStepUpKey, raw: unknown, current: TechnicalAssignmentPreviewAdmission, now: number) {
  const checkedOperation = operationSchema.parse(operation), admission = admissionSchema.parse(current);
  if (!Number.isSafeInteger(now) || now < 0 || admission.validUntil <= now) {
    throw new Error('TECHNICAL_ASSIGNMENT_PREVIEW_EXPIRED');
  }
  const input = matchedInput(checkedOperation, raw, admission, now);
  const payload = payloadSchema.parse({ protocol: 'TECHNICAL_ASSIGNMENT_PREVIEW_V1',
    operation: checkedOperation, input, admission, keyVersion: key.version, issuedAt: now,
    expiresAt: expiry(input, now, admission.validUntil) });
  const token = Buffer.from(canonicalJson({ payload,
    proof: technicalAssignmentProof(key, 'preview', payload) })).toString('base64url');
  if (token.length > maxTokenLength) throw new Error('TECHNICAL_ASSIGNMENT_PREVIEW_SIZE');
  return token;
}

/** Fresh transaction admission and personal step-up remain required at commit.
 * Persist only this returned exact input; never substitute mutable form fields.
 * Command deduplication, consumption and lost-response reconciliation belong to
 * the retained DB journal, not to this stateless signature verifier. */
export function readTechnicalAssignmentPreview(operation: TechnicalAssignmentPreviewOperation,
  key: PrivilegedStepUpKey, token: string, current: TechnicalAssignmentPreviewAdmission, now: number) {
  try {
    const checkedOperation = operationSchema.parse(operation), admission = admissionSchema.parse(current);
    if (!Number.isSafeInteger(now) || now < 0 || token.length > maxTokenLength || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const raw = Buffer.from(token, 'base64url').toString('utf-8');
    if (Buffer.from(raw).toString('base64url') !== token) return null;
    const row = envelopeSchema.parse(JSON.parse(raw)), p = row.payload;
    if (canonicalJson(row) !== raw || p.operation !== checkedOperation || p.keyVersion !== key.version
      || p.issuedAt > now || p.expiresAt <= now || p.expiresAt !== expiry(p.input, p.issuedAt, p.admission.validUntil)
      || canonicalJson(p.admission) !== canonicalJson(admission)) return null;
    const input = matchedInput(checkedOperation, p.input, admission, now);
    const proof = technicalAssignmentProof(key, 'preview', p);
    return timingSafeEqual(Buffer.from(row.proof, 'hex'), Buffer.from(proof, 'hex')) ? input : null;
  } catch { return null; }
}
