import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { createTechnicalUploadPreview, describeTechnicalUpload, readTechnicalUploadPreview,
  technicalUploadCommand, technicalUploadRequestDigest, type TechnicalUploadAdmission,
  type TechnicalUploadCommand } from './technical-upload-contract';

// This plan has no persistence imports and is not connected to routes. The
// future transaction must build `current` under the existing assignment locks,
// repeat current admission after private storage, and commit quota/audit/receipt
// together. A write intent is not an outcome or a grant to read the file.
const previewInput = technicalUploadCommand.omit({ file: true });

export function previewTechnicalUploadDeposit(key: PrivilegedStepUpKey, raw: unknown,
  fileName: string, bytes: Uint8Array, current: TechnicalUploadAdmission, now: number) {
  const input = previewInput.parse(raw);
  const command = technicalUploadCommand.parse({ ...input,
    file: describeTechnicalUpload(fileName, bytes, current.profile) });
  const token = createTechnicalUploadPreview(key, command, current, now);
  return { command, token, summary: { title: command.title, fileName: command.file.fileName,
    sizeBytes: command.file.sizeBytes, contentSha256: command.file.contentSha256,
    purpose: current.profile.purpose, visibility: current.profile.visibility,
    remainingFilesAfter: current.profile.maxFilesPerRevision - current.consumedFiles - 1,
    remainingBytesAfter: current.profile.maxBytesPerRevision - current.consumedBytes - command.file.sizeBytes } };
}

export type TechnicalUploadWriteIntent = {
  command: TechnicalUploadCommand;
  requestDigest: string;
  privateFile: { storageKey: string; bytes: Uint8Array; sha256: string; sizeBytes: number };
  quota: { assignmentId: string; revision: number; filesBefore: number; bytesBefore: number;
    filesAfter: number; bytesAfter: number };
  audit: { action: 'deposit_private_document'; fileCount: 1 };
};

export function technicalUploadStorageKey(current: Pick<TechnicalUploadAdmission, 'actorId' | 'sessionId' | 'target'>,
  commandId: string) {
  return `technical-submissions/v1/${canonicalSha256({ protocol: 'TECHNICAL_UPLOAD_STORAGE_V1',
    actorId: current.actorId, sessionId: current.sessionId, target: current.target, commandId })}`;
}

/** Recheck exact supplied bytes after the user confirms, before any file/DB
 * write. Storage identity does not change with content, preventing an altered
 * retry from creating a second file for the same actor/session/command. */
export function confirmTechnicalUploadDeposit(key: PrivilegedStepUpKey, raw: unknown,
  token: string, bytes: Uint8Array, confirmed: boolean, current: TechnicalUploadAdmission,
  now: number): TechnicalUploadWriteIntent | null {
  try {
    if (confirmed !== true) return null;
    const command = technicalUploadCommand.parse(raw);
    const previewed = readTechnicalUploadPreview(key, token, current, now);
    if (!previewed || canonicalJson(previewed) !== canonicalJson(command)) return null;
    if (bytes.byteLength !== command.file.sizeBytes || bytes.byteLength > current.profile.maxFileBytes) return null;
    // Copy the caller's buffer so later mutation cannot replace the planned bytes.
    const stableBytes = Uint8Array.from(bytes);
    const actual = describeTechnicalUpload(command.file.fileName, stableBytes, current.profile);
    if (canonicalJson(actual) !== canonicalJson(command.file)) return null;
    return { command, requestDigest: technicalUploadRequestDigest(current.target, command),
      privateFile: { storageKey: technicalUploadStorageKey(current, command.commandId),
        bytes: stableBytes, sha256: actual.contentSha256, sizeBytes: actual.sizeBytes },
      quota: { assignmentId: current.assignmentId, revision: current.assignmentRevision,
        filesBefore: current.consumedFiles, bytesBefore: current.consumedBytes,
        filesAfter: current.consumedFiles + 1, bytesAfter: current.consumedBytes + actual.sizeBytes },
      audit: { action: 'deposit_private_document', fileCount: 1 } };
  } catch { return null; }
}
