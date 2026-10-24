export function technicalUploadFileResponse(file: { bytes: Uint8Array; fileName: string; previewMime: string | null }, download: boolean) {
  const inline = !download && file.previewMime !== null;
  return new Response(new Uint8Array(file.bytes), { headers: {
    'Content-Type': inline ? file.previewMime! : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="documento"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'Content-Length': String(file.bytes.byteLength), 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; frame-ancestors 'self'",
    'Referrer-Policy': 'no-referrer',
  } });
}
export function technicalUploadNotFound() { return new Response('Non disponibile', { status: 404, headers: { 'Cache-Control': 'private, no-store, max-age=0' } }); }
