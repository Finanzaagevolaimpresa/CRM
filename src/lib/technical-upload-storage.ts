import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { documentUploadMaxBytes } from './document-upload-contract';
import { localPathFromStoragePath, readPrivateDocumentBounded } from './storage';
import type { TechnicalUploadWriteIntent } from './technical-upload-plan';

/** Private file persistence only, currently disconnected from all routes.
 * The future service must hold current assignment/quota locks, then recheck
 * admission and commit quota, audit and receipt atomically. This result neither
 * publishes a Document nor authorizes any read. An orphan after rollback stays
 * private; it is never overwritten, deleted or automatically cleaned up here. */
export async function storeTechnicalUploadPrivateFile(input: TechnicalUploadWriteIntent['privateFile']) {
  const configured = Number(process.env.DOCUMENT_MAX_BYTES ?? documentUploadMaxBytes);
  const limit = Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, documentUploadMaxBytes) : documentUploadMaxBytes;
  if (!/^technical-submissions\/v1\/[a-f0-9]{64}$/.test(input.storageKey)
    || !(input.bytes instanceof Uint8Array) || !Number.isSafeInteger(input.sizeBytes)
    || input.sizeBytes < 1 || input.sizeBytes > limit || input.bytes.byteLength !== input.sizeBytes
    || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('TECHNICAL_UPLOAD_STORAGE_INVALID');
  const bytes = Buffer.from(input.bytes);
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error('TECHNICAL_UPLOAD_STORAGE_CHANGED');
  const target = localPathFromStoragePath(input.storageKey);
  // Check each existing parent before creating its child. A substituted
  // namespace must never cause even a directory write outside the private root.
  let directory = path.dirname(path.dirname(path.dirname(target)));
  if (await realpath(directory) !== directory) throw new Error('TECHNICAL_UPLOAD_STORAGE_PATH');
  for (const segment of ['technical-submissions', 'v1']) {
    directory = path.join(directory, segment);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory)
      throw new Error('TECHNICAL_UPLOAD_STORAGE_PATH');
  }
  let handle;
  try { handle = await open(target, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size !== bytes.length)
      throw new Error('TECHNICAL_UPLOAD_STORAGE_CONFLICT');
    // Files may outlive a rolled-back transaction. Reuse only the exact bytes;
    // a conflicting or incomplete previous write remains an explicit failure.
    if (!(await readPrivateDocumentBounded(input.storageKey, limit)).equals(bytes))
      throw new Error('TECHNICAL_UPLOAD_STORAGE_CONFLICT');
    return { storageKey: input.storageKey, sha256: input.sha256, sizeBytes: bytes.length, reusedExactBytes: true };
  }
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return { storageKey: input.storageKey, sha256: input.sha256, sizeBytes: bytes.length, reusedExactBytes: false };
}
