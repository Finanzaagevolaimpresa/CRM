import { resolveVideoRange, VideoFileError } from './video-file-contract';

export type AdmittedVideoBytes = { bytes: Uint8Array; mimeType: 'video/mp4' | 'video/webm'; fileName: string };
const privateHeaders = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };

/** The callback must authorize the current session, publication, audience,
 * expiry and optional download, then load and verify private bytes. It is called
 * afresh for HEAD and every range; this helper cannot turn a denial into 416 or
 * return a public storage URL. No route is activated by this standalone helper. */
export async function privateVideoResponse(request: Request,
  authorizeAndLoad: (download: boolean) => Promise<AdmittedVideoBytes | null>) {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { ...privateHeaders, Allow: 'GET, HEAD' } });
  const download = new URL(request.url).searchParams.get('download') === '1';
  const admitted = await authorizeAndLoad(download);
  if (!admitted) return new Response(null, { status: 404, headers: privateHeaders });
  // Header material is checked again even after the private-storage contract.
  if (!admitted.fileName || /[\r\n\u0000-\u001f\u007f/\\]/u.test(admitted.fileName)
    || !['video/mp4', 'video/webm'].includes(admitted.mimeType))
    return new Response(null, { status: 404, headers: privateHeaders });
  try {
    const range = resolveVideoRange(request.headers.get('Range'), admitted.bytes.byteLength);
    const headers = { ...privateHeaders, 'Content-Type': admitted.mimeType, 'Accept-Ranges': 'bytes',
      'Content-Length': String(range.length), 'Content-Disposition': (download ? 'attachment' : 'inline')
        + "; filename*=UTF-8''" + encodeURIComponent(admitted.fileName),
      ...(range.contentRange ? { 'Content-Range': range.contentRange } : {}) };
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(admitted.bytes.slice(range.start, range.end + 1)),
      { status: range.status, headers });
  } catch (error) {
    if (!(error instanceof VideoFileError)) throw error;
    return new Response(null, { status: 416, headers: { ...privateHeaders, 'Content-Range': 'bytes */' + admitted.bytes.byteLength } });
  }
}
