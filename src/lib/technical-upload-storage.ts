import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { documentUploadMaxBytes, documentUploadMaxFiles } from './document-upload-contract';
import { localPathFromStoragePath } from './storage';
import type { TechnicalUploadWriteIntent } from './technical-upload-plan';

type PrivateReference = Pick<TechnicalUploadWriteIntent['privateFile'], 'storageKey' | 'sha256' | 'sizeBytes'>;
function validateReference(input: PrivateReference) {
  const configured = Number(process.env.DOCUMENT_MAX_BYTES ?? documentUploadMaxBytes);
  const limit = Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, documentUploadMaxBytes) : documentUploadMaxBytes;
  if (!/^technical-submissions\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(input.storageKey)
    || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > limit
    || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('TECHNICAL_UPLOAD_STORAGE_INVALID');
}
async function privateParents(target: string, create: boolean) {
  let directory = path.dirname(path.dirname(path.dirname(path.dirname(target))));
  if (await realpath(directory) !== directory) throw new Error('TECHNICAL_UPLOAD_STORAGE_PATH');
  for (const segment of ['technical-submissions', 'v1', path.basename(path.dirname(target))]) {
    directory = path.join(directory, segment);
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory)
      throw new Error('TECHNICAL_UPLOAD_STORAGE_PATH');
  }
}

function validateBudget(input: TechnicalUploadWriteIntent['privateFile']) {
  const b = input.storageBudget;
  if (!b || !Number.isSafeInteger(b.maxFileBytes) || b.maxFileBytes < 1 || b.maxFileBytes > documentUploadMaxBytes
    || !Number.isSafeInteger(b.maxFilesPerRevision) || b.maxFilesPerRevision < 1 || b.maxFilesPerRevision > documentUploadMaxFiles
    || !Number.isSafeInteger(b.maxBytesPerRevision) || b.maxBytesPerRevision < b.maxFileBytes
    || b.maxBytesPerRevision > b.maxFileBytes * b.maxFilesPerRevision || input.sizeBytes > b.maxFileBytes)
    throw new Error('TECHNICAL_UPLOAD_STORAGE_INVALID');
}

/** Caller holds the assignment FOR UPDATE across this check and file creation.
 * Include every retained file, even after DB rollback. Empty files reserve one
 * maximum file; partial bytes and strange entries are never removed or repaired.
 * Stop enumeration at the approved count so a corrupt bucket is bounded too. */
async function physicalBudget(target: string, input: TechnicalUploadWriteIntent['privateFile']) {
  const b = input.storageBudget, bucket = path.dirname(target);
  let files = 0, bytes = 0, existing = false;
  for await (const entry of await opendir(bucket)) {
    files++;
    if (files > b.maxFilesPerRevision || !/^[a-f0-9]{64}$/.test(entry.name)
      || !entry.isFile() || entry.isSymbolicLink()) throw new Error('TECHNICAL_UPLOAD_STORAGE_QUOTA');
    const s = await lstat(path.join(bucket, entry.name));
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > b.maxFileBytes)
      throw new Error('TECHNICAL_UPLOAD_STORAGE_QUOTA');
    // Even an empty failed creation occupies a slot and a maximum reservation.
    // Partial nonempty files retain their actual bytes; replay refuses them.
    bytes += s.size === 0 ? b.maxFileBytes : s.size;
    if (entry.name === path.basename(target)) existing = true;
    if (bytes > b.maxBytesPerRevision) throw new Error('TECHNICAL_UPLOAD_STORAGE_QUOTA');
  }
  await privateParents(target, false);
  return { files, bytes, existing };
}

/** Read-only accounting includes files retained by rolled-back commands. It
 * never creates a missing bucket, repairs a file or assumes DB quota is space. */
export async function readTechnicalUploadPhysicalQuota(storageKey: string,
  budget: TechnicalUploadWriteIntent['privateFile']['storageBudget']) {
  const probe = { storageKey, storageBudget: budget, sizeBytes: 1, sha256: '0'.repeat(64), bytes: new Uint8Array(1) };
  validateReference(probe); validateBudget(probe);
  const target = localPathFromStoragePath(storageKey);
  try { await privateParents(target, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: 0, bytes: 0 }; throw error; }
  const { files, bytes } = await physicalBudget(target, probe);
  return { files, bytes };
}
async function enforcePhysicalBudget(target: string, input: TechnicalUploadWriteIntent['privateFile']) {
  const { files, bytes, existing } = await physicalBudget(target, input), b = input.storageBudget;
  if (!existing && (files + 1 > b.maxFilesPerRevision || bytes + input.sizeBytes > b.maxBytesPerRevision))
    throw new Error('TECHNICAL_UPLOAD_STORAGE_QUOTA');
}

/** Exact-byte read only; the caller must first authorize the current
 * private submission under the current assignment. A receipt/reference is not
 * a permission. No directory/file, audit or acknowledgement is created here. */
export async function readTechnicalUploadPrivateFile(input: PrivateReference) {
  validateReference(input);
  const target = localPathFromStoragePath(input.storageKey);
  await privateParents(target, false);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== input.sizeBytes)
    throw new Error('TECHNICAL_UPLOAD_STORAGE_CONFLICT');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== input.sizeBytes
      || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('TECHNICAL_UPLOAD_STORAGE_CONFLICT');
    const buffer = Buffer.alloc(input.sizeBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (used !== input.sizeBytes || after.size !== input.sizeBytes || after.nlink !== 1
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || createHash('sha256').update(buffer.subarray(0, used)).digest('hex') !== input.sha256)
      throw new Error('TECHNICAL_UPLOAD_STORAGE_CHANGED');
    await privateParents(target, false);
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}

/** Private file persistence only. The service holds current assignment/quota
 * locks across this write, then rechecks
 * admission and commit quota, audit and receipt atomically. This result neither
 * publishes a Document nor authorizes any read. An orphan after rollback stays
 * private; it is never overwritten, deleted or automatically cleaned up here. */
export async function storeTechnicalUploadPrivateFile(input: TechnicalUploadWriteIntent['privateFile']) {
  validateReference(input);
  validateBudget(input);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== input.sizeBytes)
    throw new Error('TECHNICAL_UPLOAD_STORAGE_INVALID');
  const bytes = Buffer.from(input.bytes);
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error('TECHNICAL_UPLOAD_STORAGE_CHANGED');
  const target = localPathFromStoragePath(input.storageKey);
  // Check each existing parent before creating its child. A substituted
  // namespace must never cause even a directory write outside the private root.
  await privateParents(target, true);
  await enforcePhysicalBudget(target, input);
  let handle;
  try { handle = await open(target, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size !== bytes.length)
      throw new Error('TECHNICAL_UPLOAD_STORAGE_CONFLICT');
    // Files may outlive a rolled-back transaction. Reuse only the exact bytes;
    // a conflicting or incomplete previous write remains an explicit failure.
    if (!(await readTechnicalUploadPrivateFile(input)).equals(bytes))
      throw new Error('TECHNICAL_UPLOAD_STORAGE_CONFLICT');
    return { storageKey: input.storageKey, sha256: input.sha256, sizeBytes: bytes.length, reusedExactBytes: true };
  }
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return { storageKey: input.storageKey, sha256: input.sha256, sizeBytes: bytes.length, reusedExactBytes: false };
}
