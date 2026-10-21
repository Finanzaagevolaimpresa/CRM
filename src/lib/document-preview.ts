/** Only passive formats may be served inline from the authenticated CRM origin. */
export const documentPreviewMaxBytes = 25 * 1024 * 1024;
export function documentPreviewMime(fileName: string, bytes: Uint8Array): string | null {
  if (!bytes.length || bytes.length > documentPreviewMaxBytes) return null;
  const data = Buffer.from(bytes), extension = fileName.toLowerCase().split('.').at(-1);
  if (extension === 'pdf' && data.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (extension === 'png' && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (['jpg', 'jpeg'].includes(extension ?? '') && data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (extension === 'txt' && !data.includes(0)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(data); return 'text/plain; charset=utf-8'; } catch { return null; }
  }
  return null;
}
