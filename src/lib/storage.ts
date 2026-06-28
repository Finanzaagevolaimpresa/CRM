import { createHash, randomUUID } from 'crypto';
import { mkdir, stat, writeFile, readFile } from 'fs/promises';
import path from 'path';

const provider = process.env.STORAGE_PROVIDER ?? 'local';
const root = path.resolve(process.cwd(), process.env.LOCAL_DOCUMENT_STORAGE_ROOT ?? 'storage/private/documents');
const maxBytes = Number(process.env.DOCUMENT_MAX_BYTES ?? 25 * 1024 * 1024);
const allowedExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.odt', '.ods', '.p7m', '.xml']);
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

export function localPathFromStoragePath(storagePath: string) {
  assertLocalProvider();
  if (storagePath.includes('..') || path.isAbsolute(storagePath)) throw new Error('Storage path non valido');
  const full = path.resolve(process.cwd(), storagePath);
  if (!full.startsWith(root + path.sep)) throw new Error('Storage path fuori dallo storage privato');
  return full;
}

export async function savePrivateDocumentFile(input: { file: File; clientId: string; clientServiceId?: string; fileName: string }) {
  assertLocalProvider();
  if (input.file.size <= 0) throw new Error('File mancante o vuoto');
  if (input.file.size > maxBytes) throw new Error(`File oltre il limite di ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  assertSafeUploadName(input.fileName);
  const servicePart = input.clientServiceId || 'generale';
  const dir = path.join(root, input.clientId, servicePart);
  await mkdir(dir, { recursive: true });
  const storagePath = path.relative(process.cwd(), path.join(dir, `${randomUUID()}-${input.fileName}`));
  const buffer = Buffer.from(await input.file.arrayBuffer());
  await writeFile(localPathFromStoragePath(storagePath), buffer, { flag: 'wx' });
  return { storagePath, checksum: createHash('sha256').update(buffer).digest('hex'), sizeBytes: buffer.byteLength };
}

export async function privateDocumentExists(storagePath?: string | null) {
  if (!storagePath) return false;
  try { await stat(localPathFromStoragePath(storagePath)); return true; } catch { return false; }
}

export async function readPrivateDocument(storagePath: string) {
  return readFile(localPathFromStoragePath(storagePath));
}
