import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { documentUploadExtensions, documentUploadMaxBytes, documentUploadMaxFiles } from './document-upload-contract';
import { documentPreviewMime } from './document-preview';
import { financialDocumentRequirements } from './financial-privacy-policy';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { technicalTargetReference } from './technical-assignment-display';
import { technicalUploadProfile, type TechnicalUploadProfile } from './technical-upload-profile';
export { technicalUploadProfile, type TechnicalUploadProfile } from './technical-upload-profile';

// Pure preparation only. No existing assignment parser/action, route, storage or
// database imports this module. A future service must construct admission from
// locked registry, personal authority and immutable assignment journal rows.
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const generation = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.number().int().nonnegative().safe();
const formats = documentUploadExtensions.filter(value => value !== '.zip');
const format = z.enum(formats);
const maximumBytes = documentUploadMaxFiles * documentUploadMaxBytes;

const fileName = z.string().min(1).max(255).refine(value => value.normalize('NFC') === value
  && value.trim() === value && !/[\p{Cc}\p{Cf}<>:"/\\|?*]/u.test(value)
  && !value.includes('..') && !value.endsWith('.')
  && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value), 'Unsafe file name');
const fileDescriptor = z.object({ fileName, extension: format, sizeBytes: z.number().int().min(1).max(documentUploadMaxBytes),
  contentSha256: hash, previewMime: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'text/plain; charset=utf-8']).nullable(),
}).strict().refine(value => {
  const required = ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8' } as Record<string, string>)[value.extension] ?? null;
  return value.fileName.toLowerCase().endsWith(value.extension) && value.previewMime === required;
}, 'Exact passive preview metadata required');
export const technicalUploadCommand = z.object({ commandId: z.string().uuid(), assignmentId: z.string().uuid(),
  assignmentRevision: generation, expectedContextSha256: hash, title: z.string().trim().min(1).max(200),
  file: fileDescriptor, action: z.literal('deposit_private_document'),
}).strict();
export type TechnicalUploadCommand = z.infer<typeof technicalUploadCommand>;

/** Describes supplied bytes; client MIME and size assertions are not used.
 * Opaque approved formats stay attachments and are never unpacked/executed.
 * Classification is metadata based, not a claim to understand file contents. */
export function describeTechnicalUpload(rawName: string, bytes: Uint8Array, rawProfile: TechnicalUploadProfile) {
  const profile = technicalUploadProfile.parse(rawProfile), name = fileName.parse(rawName);
  if (!bytes.length || bytes.length > profile.maxFileBytes) throw new Error('TECHNICAL_UPLOAD_SIZE');
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (!profile.formats.some(value => value === extension)) throw new Error('TECHNICAL_UPLOAD_FORMAT');
  const financial = financialDocumentRequirements({ fileName: name });
  if (financial.contract || financial.payment) throw new Error('TECHNICAL_UPLOAD_FINANCIAL');
  const previewMime = documentPreviewMime(name, bytes);
  if (['.pdf', '.png', '.jpg', '.jpeg', '.txt'].includes(extension) && previewMime === null) throw new Error('TECHNICAL_UPLOAD_FORMAT');
  return fileDescriptor.parse({ fileName: name, extension, sizeBytes: bytes.length,
    contentSha256: createHash('sha256').update(bytes).digest('hex'), previewMime });
}

const admissionSchema = z.object({ target: technicalTargetReference, actorId: id, sessionId: z.string().uuid(),
  assignmentId: z.string().uuid(), assignmentRevision: generation, assignmentStateSha256: hash,
  authorityRevision: generation, actorEpoch: generation, authorEpoch: generation, keyVersion: generation,
  contextSha256: hash, scopeGeneration: generation, profile: technicalUploadProfile,
  consumedFiles: z.number().int().min(0).max(documentUploadMaxFiles), consumedBytes: z.number().int().min(0).max(maximumBytes),
  validUntil: instant,
}).strict().refine(value => value.consumedFiles <= value.profile.maxFilesPerRevision
  && value.consumedBytes <= value.profile.maxBytesPerRevision
  && value.consumedBytes >= value.consumedFiles
  && value.consumedBytes <= value.consumedFiles * value.profile.maxFileBytes,
  'Current quota must correspond to bounded nonempty submissions');
export type TechnicalUploadAdmission = z.infer<typeof admissionSchema>;
const preview = z.object({ protocol: z.literal('TECHNICAL_UPLOAD_PREVIEW_V1'), command: technicalUploadCommand,
  admission: admissionSchema, issuedAt: instant, expiresAt: instant }).strict();
const envelope = z.object({ payload: preview, proof: hash }).strict();
const lifetime = 300_000;
const maximumTokenLength = 32_000;

function sign(key: PrivilegedStepUpKey, purpose: 'preview' | 'receipt', payload: unknown) {
  if (!generation.safeParse(key.version).success || key.secret.length < 32) throw new Error('TECHNICAL_UPLOAD_KEY');
  return createHmac('sha256', key.secret).update(`FAI_TECHNICAL_UPLOAD_V1:${purpose}:${key.version}:`)
    .update(canonicalJson(payload)).digest('hex');
}
function signatureEquals(a: string, b: string) {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function admitted(command: TechnicalUploadCommand, current: TechnicalUploadAdmission) {
  const financial = financialDocumentRequirements({ title: command.title, fileName: command.file.fileName });
  return !financial.contract && !financial.payment && command.assignmentId === current.assignmentId
    && command.assignmentRevision === current.assignmentRevision && command.expectedContextSha256 === current.contextSha256
    && current.profile.formats.includes(command.file.extension) && command.file.sizeBytes <= current.profile.maxFileBytes
    && current.consumedFiles < current.profile.maxFilesPerRevision
    && current.consumedBytes + command.file.sizeBytes <= current.profile.maxBytesPerRevision;
}
export function technicalUploadRequestDigest(target: TechnicalUploadAdmission['target'], raw: TechnicalUploadCommand) {
  return canonicalSha256({ protocol: 'TECHNICAL_UPLOAD_REQUEST_V1', target: technicalTargetReference.parse(target),
    command: technicalUploadCommand.parse(raw) });
}

/** The preview creates neither a stored file nor a right to publish/read one. */
export function createTechnicalUploadPreview(key: PrivilegedStepUpKey, raw: TechnicalUploadCommand,
  state: TechnicalUploadAdmission, now: number) {
  const command = technicalUploadCommand.parse(raw), admission = admissionSchema.parse(state);
  if (!instant.safeParse(now).success || admission.validUntil <= now || key.version !== admission.keyVersion
    || !admitted(command, admission)) throw new Error('TECHNICAL_UPLOAD_STALE');
  const payload = preview.parse({ protocol: 'TECHNICAL_UPLOAD_PREVIEW_V1', command, admission, issuedAt: now,
    expiresAt: Math.min(now + lifetime, admission.validUntil) });
  const token = Buffer.from(canonicalJson({ payload, proof: sign(key, 'preview', payload) })).toString('base64url');
  if (token.length > maximumTokenLength) throw new Error('TECHNICAL_UPLOAD_SIZE');
  return token;
}
export function readTechnicalUploadPreview(key: PrivilegedStepUpKey, token: string, state: TechnicalUploadAdmission, now: number) {
  try {
    const current = admissionSchema.parse(state);
    if (!instant.safeParse(now).success || typeof token !== 'string' || token.length > maximumTokenLength
      || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const text = Buffer.from(token, 'base64url').toString('utf8'), signed = envelope.parse(JSON.parse(text)), p = signed.payload;
    if (Buffer.from(text).toString('base64url') !== token || canonicalJson(signed) !== text
      || canonicalJson(p.admission) !== canonicalJson(current) || key.version !== current.keyVersion
      || p.issuedAt > now || p.expiresAt <= now || p.expiresAt !== Math.min(p.issuedAt + lifetime, current.validUntil)
      || !admitted(p.command, current) || !signatureEquals(signed.proof, sign(key, 'preview', p))) return null;
    return p.command;
  } catch { return null; }
}

/** Historical outcome only: never a read token or implicit publication/grant. */
export const technicalUploadReceipt = z.object({ protocol: z.literal('TECHNICAL_UPLOAD_RECEIPT_V1'),
  commandId: z.string().uuid(), submissionId: z.string().uuid(), actorId: id, sessionId: z.string().uuid(),
  target: technicalTargetReference, assignmentId: z.string().uuid(), assignmentRevision: generation,
  requestDigest: hash, contentSha256: hash, sizeBytes: z.number().int().min(1).max(documentUploadMaxBytes),
  status: z.literal('PRIVATE_STORED'), recordedAt: z.string().datetime(), keyVersion: generation,
}).strict();
export type TechnicalUploadReceipt = z.infer<typeof technicalUploadReceipt>;
export function signTechnicalUploadReceipt(key: PrivilegedStepUpKey, raw: TechnicalUploadReceipt) {
  const value = technicalUploadReceipt.parse(raw);
  if (key.version !== value.keyVersion) throw new Error('TECHNICAL_UPLOAD_KEY');
  return sign(key, 'receipt', value);
}
export function readTechnicalUploadReceipt(key: PrivilegedStepUpKey, raw: unknown, proof: string,
  expected: Pick<TechnicalUploadReceipt, 'commandId' | 'actorId' | 'sessionId' | 'target' | 'requestDigest'>, now: number) {
  try {
    const value = technicalUploadReceipt.parse(raw);
    if (!hash.safeParse(proof).success || !instant.safeParse(now).success || Date.parse(value.recordedAt) > now
      || key.version !== value.keyVersion || value.commandId !== expected.commandId || value.actorId !== expected.actorId
      || value.sessionId !== expected.sessionId || canonicalJson(value.target) !== canonicalJson(expected.target)
      || value.requestDigest !== expected.requestDigest || !signatureEquals(proof, sign(key, 'receipt', value))) return null;
    return value;
  } catch { return null; }
}
