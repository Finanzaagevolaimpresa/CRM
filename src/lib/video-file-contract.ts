/** First private-library contract; no provider, persistence or authorization implied. */
export const videoMaxBytes = 20 * 1024 * 1024;
export const videoLibraryQuotaBytes = 1024 * 1024 * 1024;
export const videoTypes = { '.mp4': 'video/mp4', '.webm': 'video/webm' } as const;

export class VideoFileError extends Error {
  constructor(public readonly code: 'VIDEO_FILE_INVALID' | 'VIDEO_RANGE_INVALID') { super(code); }
}

function invalid(): never { throw new VideoFileError('VIDEO_FILE_INVALID'); }

export function identifyVideoFile(name: string, size: number, header: Uint8Array): 'video/mp4' | 'video/webm' {
  if (!name || name.length > 180 || /[\\/\u0000-\u001f\u007f]/u.test(name) || name.includes('..')
    || !Number.isSafeInteger(size) || size < 12 || size > videoMaxBytes || header.length > size) invalid();
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (extension === '.mp4') {
    if (header.length < 16 || String.fromCharCode(...header.slice(4, 8)) !== 'ftyp') invalid();
    const boxSize = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
    if (boxSize < 16 || boxSize > size || boxSize % 4 !== 0) invalid();
    const brand = String.fromCharCode(...header.slice(8, 12));
    if (!['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '].includes(brand)) invalid();
    return 'video/mp4';
  }
  if (extension === '.webm') {
    if (header.length < 12 || header[0] !== 0x1a || header[1] !== 0x45 || header[2] !== 0xdf || header[3] !== 0xa3) invalid();
    const vint = (offset: number, preserveMarker: boolean) => {
      const first = header[offset];
      if (!first) invalid();
      let length = 1, marker = 0x80;
      while (!(first & marker)) { marker >>= 1; length++; }
      if (length > 4 || offset + length > header.length) invalid();
      let value = preserveMarker ? first : first & (marker - 1);
      for (let i = 1; i < length; i++) value = value * 256 + header[offset + i];
      if (!preserveMarker && value === 2 ** (7 * length) - 1) invalid();
      return { value, next: offset + length };
    };
    const envelope = vint(4, false);
    const end = envelope.next + envelope.value;
    if (end > header.length || end > 4096) invalid();
    let cursor = envelope.next, docType = false;
    while (cursor < end) {
      const id = vint(cursor, true), item = vint(id.next, false);
      const next = item.next + item.value;
      if (next > end) invalid();
      if (id.value === 0x4282) {
        if (docType || item.value !== 4 || String.fromCharCode(...header.slice(item.next, next)) !== 'webm') invalid();
        docType = true;
      }
      cursor = next;
    }
    if (!docType) invalid();
    return 'video/webm';
  }
  return invalid();
}

/** Apply only after fresh record/session authorization, for every GET/HEAD/Range. */
export function resolveVideoRange(header: string | null, size: number) {
  const fail = (): never => { throw new VideoFileError('VIDEO_RANGE_INVALID'); };
  if (!Number.isSafeInteger(size) || size < 1 || size > videoMaxBytes) return fail();
  if (header === null) return { status: 200 as const, start: 0, end: size - 1, length: size, contentRange: null };
  if (header.length > 160) return fail();
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return fail();
  const number = (value: string) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return fail();
    return parsed;
  };
  let start: number, end: number;
  if (!match[1]) {
    const suffix = number(match[2]);
    if (!suffix) return fail();
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = number(match[1]); end = match[2] ? number(match[2]) : size - 1;
    if (start >= size || end < start) return fail();
    end = Math.min(end, size - 1);
  }
  return { status: 206 as const, start, end, length: end - start + 1, contentRange: `bytes ${start}-${end}/${size}` };
}
