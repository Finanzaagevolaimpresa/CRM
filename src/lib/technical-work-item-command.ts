import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { technicalTargetReference } from './technical-assignment-display';

// Preparation only. The future persistence service must build admission from
// locked, journal-verified rows and validate the patch against the selected
// readable/editable fields. A signed preview is not a new assignment or grant.
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(2_147_483_647);
const instant = z.number().int().nonnegative().safe();
const itemIdentity = { bindingId: z.string().uuid(), bindingRevision: positive,
  kind: z.enum(['ChecklistItem', 'Task']), itemId: id };
const boundedPatch = z.record(z.string(), z.string().max(5000).nullable());
export const technicalWorkItemCommand = z.object({ commandId: z.string().uuid(),
  assignmentId: z.string().uuid(), assignmentRevision: positive, ...itemIdentity,
  expectedContextSha256: hash, expectedItemVersion: positive,
  action: z.literal('update_fields'), patch: boundedPatch,
}).strict().superRefine((value, ctx) => {
  const keys = Object.keys(value.patch);
  const allowed = value.kind === 'ChecklistItem' ? ['title', 'notes'] : ['title', 'description', 'priority', 'dueAt'];
  if (!keys.length || keys.length > allowed.length || keys.some(key => !allowed.includes(key))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only explicitly selected editable item fields are admitted' });
  }
});
export type TechnicalWorkItemCommand = z.infer<typeof technicalWorkItemCommand>;

const admissionSchema = z.object({ target: technicalTargetReference, actorId: id,
  sessionId: z.string().uuid(), assignmentId: z.string().uuid(), assignmentRevision: positive,
  assignmentStateSha256: hash, authorityRevision: positive, actorEpoch: positive, authorEpoch: positive,
  keyVersion: positive, ...itemIdentity, contextSha256: hash, selectionSha256: hash,
  itemVersion: positive, validUntil: instant,
}).strict();
export type TechnicalWorkItemAdmission = z.infer<typeof admissionSchema>;
const previewSchema = z.object({ protocol: z.literal('TECHNICAL_WORK_ITEM_PREVIEW_V1'),
  command: technicalWorkItemCommand, admission: admissionSchema,
  issuedAt: instant, expiresAt: instant,
}).strict();
const envelopeSchema = z.object({ payload: previewSchema, proof: hash }).strict();
const maxTokenBytes = 48_000;
const previewLifetime = 300_000;

function proof(key: PrivilegedStepUpKey, purpose: 'preview' | 'receipt', value: unknown) {
  if (!positive.safeParse(key.version).success || key.secret.length < 32) throw new Error('TECHNICAL_WORK_ITEM_KEY_INVALID');
  return createHmac('sha256', key.secret).update(`FAI_TECHNICAL_WORK_ITEM_V1:${purpose}:${key.version}:`)
    .update(canonicalJson(value)).digest('hex');
}
function equal(a: string, b: string) {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function matches(command: TechnicalWorkItemCommand, current: TechnicalWorkItemAdmission) {
  return command.assignmentId === current.assignmentId && command.assignmentRevision === current.assignmentRevision
    && command.bindingId === current.bindingId && command.bindingRevision === current.bindingRevision
    && command.kind === current.kind && command.itemId === current.itemId
    && command.expectedContextSha256 === current.contextSha256 && command.expectedItemVersion === current.itemVersion;
}
export function technicalWorkItemRequestDigest(target: z.infer<typeof technicalTargetReference>, raw: TechnicalWorkItemCommand) {
  return canonicalSha256({ protocol: 'TECHNICAL_WORK_ITEM_REQUEST_V1',
    target: technicalTargetReference.parse(target), command: technicalWorkItemCommand.parse(raw) });
}

/** No state transition, owner change, document association, notification or
 * implicit scope change is representable by this field-update command. */
export function createTechnicalWorkItemPreview(key: PrivilegedStepUpKey, raw: TechnicalWorkItemCommand,
  current: TechnicalWorkItemAdmission, now: number) {
  const command = technicalWorkItemCommand.parse(raw), admission = admissionSchema.parse(current);
  if (!instant.safeParse(now).success || admission.validUntil <= now || key.version !== admission.keyVersion
    || !matches(command, admission) || command.expectedItemVersion === 2_147_483_647) throw new Error('TECHNICAL_WORK_ITEM_STALE');
  const payload = previewSchema.parse({ protocol: 'TECHNICAL_WORK_ITEM_PREVIEW_V1', command, admission, issuedAt: now,
    expiresAt: Math.min(now + previewLifetime, admission.validUntil) });
  const token = Buffer.from(canonicalJson({ payload, proof: proof(key, 'preview', payload) })).toString('base64url');
  if (token.length > maxTokenBytes) throw new Error('TECHNICAL_WORK_ITEM_INVALID');
  return token;
}
export function readTechnicalWorkItemPreview(key: PrivilegedStepUpKey, token: string,
  current: TechnicalWorkItemAdmission, now: number) {
  try {
    const admission = admissionSchema.parse(current);
    if (!instant.safeParse(now).success || typeof token !== 'string' || token.length > maxTokenBytes
      || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const envelope = envelopeSchema.parse(JSON.parse(raw)), p = envelope.payload;
    if (Buffer.from(raw).toString('base64url') !== token || canonicalJson(envelope) !== raw
      || canonicalJson(p.admission) !== canonicalJson(admission) || key.version !== admission.keyVersion
      || p.issuedAt > now || p.expiresAt <= now || p.expiresAt !== Math.min(p.issuedAt + previewLifetime, admission.validUntil)
      || p.command.expectedItemVersion === 2_147_483_647 || !matches(p.command, admission)
      || !equal(envelope.proof, proof(key, 'preview', p))) return null;
    return p.command;
  } catch { return null; }
}

// Receipt carries identifiers and digests only, never previous/new field values.
// Recovering it still requires the current actor/session and retained audit.
export const technicalWorkItemReceipt = z.object({ protocol: z.literal('TECHNICAL_WORK_ITEM_RECEIPT_V1'),
  commandId: z.string().uuid(), actorId: id, sessionId: z.string().uuid(), target: technicalTargetReference,
  assignmentId: z.string().uuid(), assignmentRevision: positive, ...itemIdentity,
  action: z.literal('update_fields'), fieldCount: z.number().int().min(1).max(4), requestDigest: hash,
  previousItemVersion: positive, itemVersion: positive, recordedAt: z.string().datetime(), keyVersion: positive,
}).strict().refine(value => value.itemVersion === value.previousItemVersion + 1
  && value.fieldCount <= (value.kind === 'ChecklistItem' ? 2 : 4), 'Exact optimistic increment is required');
export type TechnicalWorkItemReceipt = z.infer<typeof technicalWorkItemReceipt>;
export function signTechnicalWorkItemReceipt(key: PrivilegedStepUpKey, raw: TechnicalWorkItemReceipt) {
  const value = technicalWorkItemReceipt.parse(raw);
  if (value.keyVersion !== key.version) throw new Error('TECHNICAL_WORK_ITEM_KEY_INVALID');
  return proof(key, 'receipt', value);
}
export function readTechnicalWorkItemReceipt(key: PrivilegedStepUpKey, raw: unknown, signature: string,
  expected: { commandId: string; actorId: string; sessionId: string;
    target: z.infer<typeof technicalTargetReference>; requestDigest?: string }, now: Date) {
  try {
    const value = technicalWorkItemReceipt.parse(raw);
    if (!hash.safeParse(signature).success || key.version !== value.keyVersion || !Number.isFinite(now.getTime())
      || Date.parse(value.recordedAt) > now.getTime() || value.commandId !== expected.commandId
      || value.actorId !== expected.actorId || value.sessionId !== expected.sessionId
      || canonicalJson(value.target) !== canonicalJson(expected.target)
      || (expected.requestDigest !== undefined && value.requestDigest !== expected.requestDigest)
      || !equal(signature, proof(key, 'receipt', value))) return null;
    return value;
  } catch { return null; }
}
