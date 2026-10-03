import { createHash, randomUUID } from 'crypto';
import { mkdir, stat, writeFile, readFile, open } from 'fs/promises';
import path from 'path';
import { documentUploadExtensions, documentUploadMaxBytes } from './document-upload-contract';

const provider = process.env.STORAGE_PROVIDER ?? 'local';
const legacyDefaultRoot = 'storage/private/documents';
const root = path.resolve(process.cwd(), process.env.LOCAL_DOCUMENT_STORAGE_ROOT ?? legacyDefaultRoot);
const configuredMaxBytes = Number(process.env.DOCUMENT_MAX_BYTES ?? documentUploadMaxBytes);
const maxBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0 ? Math.min(configuredMaxBytes, documentUploadMaxBytes) : documentUploadMaxBytes;
const allowedExtensions = new Set<string>(documentUploadExtensions);
const blockedExtensions = new Set(['.exe', '.bat', '.cmd', '.com', '.js', '.mjs', '.sh', '.ps1', '.vbs', '.scr', '.jar', '.php']);

export function sanitizeFileName(name: string) {
  const base = path.basename(name).replace(/[\\/\0]/g, '').replace(/[^\w.() -]+/g, '_').replace(/\s+/g, ' ').trim();
  return base || 'documento';
}

export function assertSafeUploadName(fileName: string) {
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) throw new Error('Nome file non valido');
  const extension = path.extname(fileName).toLowerCase();
  if (!extension || blockedExtensions.has(extension) || !allowedExtensions.has(extension)) throw new Error('Estensione file non consentita');
}

function assertLocalProvider() {
  if (provider !== 'local') throw new Error(`Storage provider ${provider} non attivo: placeholder S3 non configurato`);
}

function storageKeySegments(storagePath: string) {
  if (!storagePath || storagePath.includes('\0')) throw new Error('Storage path non valido');
  if (path.posix.isAbsolute(storagePath) || path.win32.isAbsolute(storagePath) || /^[A-Za-z]:/.test(storagePath)) {
    throw new Error('Storage path non valido');
  }

  const normalizedPath = storagePath.replace(/\\/g, '/');
  const legacyPrefix = `${legacyDefaultRoot}/`;
  const key = normalizedPath.startsWith(legacyPrefix) ? normalizedPath.slice(legacyPrefix.length) : normalizedPath;
  const segments = key.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('Storage path non valido');
  return segments;
}

function assertStorageSegment(segment: string, fieldName: string) {
  if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
    throw new Error(`${fieldName} non valido`);
  }
}

export function localPathFromStoragePath(storagePath: string) {
  assertLocalProvider();
  const full = path.resolve(root, ...storageKeySegments(storagePath));
  const relative = path.relative(root, full);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Storage path fuori dallo storage privato');
  }
  return full;
}

export async function savePrivateDocumentFile(input: { file: File; clientId: string; clientServiceId?: string; fileName: string }) {
  assertLocalProvider();
  if (input.file.size <= 0) throw new Error('File mancante o vuoto');
  if (input.file.size > maxBytes) throw new Error(`File oltre il limite di ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  assertSafeUploadName(input.fileName);
  const servicePart = input.clientServiceId || 'generale';
  assertStorageSegment(input.clientId, 'Client ID');
  assertStorageSegment(servicePart, 'Client service ID');
  const storagePath = path.posix.join(input.clientId, servicePart, `${randomUUID()}-${input.fileName}`);
  const targetPath = localPathFromStoragePath(storagePath);
  const buffer = Buffer.from(await input.file.arrayBuffer());
  if (buffer.length !== input.file.size || buffer.length > maxBytes) throw new Error('Dimensione file non valida');
  if (path.extname(input.fileName).toLowerCase() === '.zip' && (buffer.length < 22 || ![0x04034b50, 0x06054b50, 0x08074b50].includes(buffer.readUInt32LE(0)))) {
    throw new Error('Il file non è un archivio ZIP riconoscibile');
  }
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(targetPath, buffer, { flag: 'wx', mode: 0o600 });
  return { storagePath, checksum: createHash('sha256').update(buffer).digest('hex'), sizeBytes: buffer.byteLength };
}

export async function privateDocumentExists(storagePath?: string | null) {
  if (!storagePath) return false;
  try { await stat(localPathFromStoragePath(storagePath)); return true; } catch { return false; }
}

export async function readPrivateDocument(storagePath: string) {
  return readFile(localPathFromStoragePath(storagePath));
}

export async function readPrivateDocumentBounded(storagePath: string, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 * 1024 * 1024) throw new Error('DOCUMENT_SIZE_LIMIT');
  const file = await open(localPathFromStoragePath(storagePath), 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > limit) throw new Error('DOCUMENT_SIZE_LIMIT');
    // Read at most the attested length plus one byte, even if the file grows concurrently.
    const bytes = Buffer.alloc(metadata.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== metadata.size) throw new Error('DOCUMENT_CHANGED');
    return bytes.subarray(0, used);
  } finally { await file.close(); }
}
