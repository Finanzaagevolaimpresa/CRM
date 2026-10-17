import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localPathFromStoragePath } from './storage';
import { identifyVideoFile, videoMaxBytes } from './video-file-contract';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(): never { throw new Error('VIDEO_STORAGE_UNAVAILABLE'); }
export function videoStoragePath(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) fail();
  return `videos/${id}`;
}

export async function prepareVideoFile(file: File) {
  if (!(file instanceof File) || file.size < 12 || file.size > videoMaxBytes) fail();
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length !== file.size) fail();
  const mimeType = identifyVideoFile(file.name, bytes.length, bytes.subarray(0, 4096));
  return { bytes, fileName: file.name, mimeType, sizeBytes: bytes.length, sha256: hash(bytes) };
}

/** Read only after a fresh locked authorization. Bound memory to 20 MiB and
 * verify exact bytes before any response, including HEAD and partial requests. */
export async function readPrivateVideoFile(id: string, expected: { sizeBytes: number; sha256: string }) {
  if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 12 || expected.sizeBytes > videoMaxBytes
    || !/^[a-f0-9]{64}$/.test(expected.sha256)) fail();
  const target = localPathFromStoragePath(videoStoragePath(id));
  const folder = await lstat(path.dirname(target));
  if (!folder.isDirectory() || folder.isSymbolicLink()) fail();
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.sizeBytes) fail();
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== before.size || stat.dev !== before.dev || stat.ino !== before.ino) fail();
    const bytes = Buffer.alloc(expected.sizeBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const exact = bytes.subarray(0, used);
    if (used !== expected.sizeBytes || hash(exact) !== expected.sha256) fail();
    return exact;
  } finally { await handle.close(); }
}

/** Reserve quota and an immutable upload record in the DB first. A failed write
 * keeps its reservation; the same command can resume only these exact bytes. */
export async function savePrivateVideoFile(id: string, prepared: Awaited<ReturnType<typeof prepareVideoFile>>) {
  if (prepared.bytes.length !== prepared.sizeBytes || hash(prepared.bytes) !== prepared.sha256
    || identifyVideoFile(prepared.fileName, prepared.sizeBytes, prepared.bytes.subarray(0, 4096)) !== prepared.mimeType) fail();
  const storagePath = videoStoragePath(id), target = localPathFromStoragePath(storagePath);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const folder = await lstat(path.dirname(target));
  if (!folder.isDirectory() || folder.isSymbolicLink()) fail();
  try { await writeFile(target, prepared.bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await readPrivateVideoFile(id, prepared);
  }
  return { storagePath, sha256: prepared.sha256, sizeBytes: prepared.sizeBytes };
}
