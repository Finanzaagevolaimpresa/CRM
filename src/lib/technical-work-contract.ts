import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { technicalAssignmentSelection, technicalFieldPatch, type TechnicalAssignmentSelection } from './technical-assignment-contract';
import { technicalAssignmentProof } from './technical-assignment-proof';
import { technicalTargetReference } from './technical-assignment-display';
import { projectSchema, technicalPracticeSchema, technicalPracticeStatusSchema } from './validation';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(2_147_483_647);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const technicalWorkCommand = z.object({ commandId: z.string().uuid(),
  assignmentId: z.string().uuid(), assignmentRevision: positive, expectedContextSha256: hash,
  expectedTargetSha256: hash, action: z.enum(['update_fields', 'update_status']),
  patch: z.record(z.string(), z.string().max(5000).nullable()),
}).strict().superRefine((value, ctx) => {
  const keys = Object.keys(value.patch);
  if (keys.length < 1 || keys.length > 11 || (value.action === 'update_status'
    ? keys.length !== 1 || keys[0] !== 'status' : keys.includes('status'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid explicit technical patch' });
  }
});
export type TechnicalWorkCommand = z.infer<typeof technicalWorkCommand>;
export const technicalProjectStatuses = ['idea', 'raccolta_dati', 'in_analisi', 'preanalisi_pronta',
  'dossier_pronto', 'pratica_attiva', 'chiuso'] as const;
export const technicalPracticeStatuses = technicalPracticeStatusSchema.options.filter(status => status !== 'archiviata');
const nullableText = z.string().trim().max(5000).nullable().transform(value => value === '' ? null : value);
const nullableInstant = z.string().datetime({ offset: true }).nullable().transform(value => value === null ? null : new Date(value).toISOString());
const dates = new Set(['dueDate', 'submittedAt', 'nextClientUpdateAt']);
const nullableTexts = new Set(['description', 'targetPortal', 'protocolNumber', 'integrationRequestNote', 'clientVisibleStatus']);

/** Strict allowlist before canonical value validators. No unknown-key stripping,
 * defaults, owner/parent writes, lifecycle operations or auxiliary status fields. */
export function validateTechnicalWorkPatch(selection: TechnicalAssignmentSelection, raw: TechnicalWorkCommand) {
  technicalAssignmentSelection.parse(selection);
  const command = technicalWorkCommand.parse(raw);
  if (!selection.actions.includes(command.action)) throw new Error('TECHNICAL_WORK_DENIED');
  if (command.action === 'update_status') {
    if (!selection.readableFields.includes('status')) throw new Error('TECHNICAL_WORK_DENIED');
    const status = selection.kind === 'Project' ? z.enum(technicalProjectStatuses).parse(command.patch.status)
      : technicalPracticeStatusSchema.exclude(['archiviata']).parse(command.patch.status);
    return { status } as Record<string, string | null>;
  }
  if (!technicalFieldPatch(selection, command.patch)) throw new Error('TECHNICAL_WORK_DENIED');
  const result: Record<string, string | null> = {};
  for (const [field, value] of Object.entries(command.patch)) {
    if (dates.has(field)) result[field] = nullableInstant.parse(value);
    else if (nullableTexts.has(field)) result[field] = nullableText.parse(value);
    else {
      const shape: Record<string, z.ZodTypeAny> = selection.kind === 'Project' ? projectSchema.shape : technicalPracticeSchema.shape;
      const parsed: unknown = shape[field]?.parse(value);
      if (typeof parsed !== 'string') throw new Error('TECHNICAL_WORK_DENIED');
      result[field] = parsed;
    }
  }
  return result;
}

const admissionSchema = z.object({ target: technicalTargetReference, actorId: id, sessionId: z.string().uuid(),
  assignmentId: z.string().uuid(), assignmentRevision: positive, assignmentStateSha256: hash,
  authorityRevision: positive, actorEpoch: positive, authorEpoch: positive, keyVersion: positive,
  contextSha256: hash, targetSha256: hash, validUntil: z.number().int().positive().safe(),
}).strict();
export type TechnicalWorkAdmission = z.infer<typeof admissionSchema>;
const previewSchema = z.object({ protocol: z.literal('TECHNICAL_WORK_PREVIEW_V1'), command: technicalWorkCommand,
  admission: admissionSchema, issuedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe(),
}).strict();
const envelope = z.object({ payload: previewSchema, proof: hash }).strict();
function matched(command: TechnicalWorkCommand, admission: TechnicalWorkAdmission) {
  return command.assignmentId === admission.assignmentId && command.assignmentRevision === admission.assignmentRevision
    && command.expectedContextSha256 === admission.contextSha256 && command.expectedTargetSha256 === admission.targetSha256;
}
function signedEqual(a: string, b: string) { return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
export function technicalWorkRequestDigest(target: z.infer<typeof technicalTargetReference>, command: TechnicalWorkCommand) {
  return canonicalSha256({ protocol: 'TECHNICAL_WORK_REQUEST_V1', target: technicalTargetReference.parse(target),
    command: technicalWorkCommand.parse(command) });
}
export function createTechnicalWorkPreview(key: PrivilegedStepUpKey, raw: TechnicalWorkCommand,
  current: TechnicalWorkAdmission, now: number) {
  const command = technicalWorkCommand.parse(raw), admission = admissionSchema.parse(current);
  if (!matched(command, admission) || admission.keyVersion !== key.version || !Number.isSafeInteger(now)
    || now < 0 || admission.validUntil <= now) throw new Error('TECHNICAL_WORK_STALE');
  const payload = previewSchema.parse({ protocol: 'TECHNICAL_WORK_PREVIEW_V1', command, admission, issuedAt: now,
    expiresAt: Math.min(now + 300_000, admission.validUntil) });
  const token = Buffer.from(canonicalJson({ payload, proof: technicalAssignmentProof(key, 'work-preview', payload) })).toString('base64url');
  if (token.length > 96_000) throw new Error('TECHNICAL_WORK_INVALID');
  return token;
}
export function readTechnicalWorkPreview(key: PrivilegedStepUpKey, token: string, current: TechnicalWorkAdmission, now: number) {
  try {
    const admission = admissionSchema.parse(current);
    if (!Number.isSafeInteger(now) || now < 0 || token.length > 96_000 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const raw = Buffer.from(token, 'base64url').toString('utf8'), row = envelope.parse(JSON.parse(raw)), p = row.payload;
    if (Buffer.from(raw).toString('base64url') !== token || canonicalJson(row) !== raw
      || canonicalJson(p.admission) !== canonicalJson(admission) || admission.keyVersion !== key.version
      || p.issuedAt > now || p.expiresAt <= now || p.expiresAt !== Math.min(p.issuedAt + 300_000, admission.validUntil)
      || !matched(p.command, admission) || !signedEqual(row.proof, technicalAssignmentProof(key, 'work-preview', p))) return null;
    return p.command;
  } catch { return null; }
}

/** Opaque receipt: no old/new field values, names, parent context or documents. */
export const technicalWorkReceipt = z.object({ protocol: z.literal('TECHNICAL_WORK_RECEIPT_V1'),
  commandId: z.string().uuid(), actorId: id, sessionId: z.string().uuid(), target: technicalTargetReference,
  assignmentId: z.string().uuid(), assignmentRevision: positive, action: z.enum(['update_fields', 'update_status']),
  fieldCount: z.number().int().min(1).max(11), requestDigest: hash, targetVersion: z.string().datetime(),
  recordedAt: z.string().datetime(), keyVersion: positive,
}).strict();
export type TechnicalWorkReceipt = z.infer<typeof technicalWorkReceipt>;
export function verifyTechnicalWorkReceipt(raw: unknown, proof: string, key: PrivilegedStepUpKey,
  expected: { commandId: string; actorId: string; sessionId: string; target: z.infer<typeof technicalTargetReference>; requestDigest?: string }, now: Date) {
  try {
    const r = technicalWorkReceipt.parse(raw);
    if (!hash.safeParse(proof).success || r.keyVersion !== key.version || !Number.isFinite(now.getTime())
      || Date.parse(r.recordedAt) > now.getTime() || r.commandId !== expected.commandId || r.actorId !== expected.actorId
      || r.sessionId !== expected.sessionId || canonicalJson(r.target) !== canonicalJson(expected.target)
      || (expected.requestDigest !== undefined && r.requestDigest !== expected.requestDigest)
      || !signedEqual(proof, technicalAssignmentProof(key, 'work-receipt', r))) return null;
    return r;
  } catch { return null; }
}
