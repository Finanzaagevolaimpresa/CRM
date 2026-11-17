// Shared by the signed MIME contract and the browser's bounded download reader.
export const ORDINARY_ATTACHMENT_MAX_BYTES = 1024 * 1024;

export async function verifiedOrdinaryAttachmentBytes(
  response: Response, expected: { bytes: number; sha256: string },
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0
    || expected.bytes > ORDINARY_ATTACHMENT_MAX_BYTES || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new Error('INTEGRITY');
  }
  const declaredLength = response.headers.get('content-length');
  // Fetch responses may legitimately omit Content-Length. The received body,
  // not this optional transport header, must match the signed size and digest.
  if (!response.ok || response.headers.get('content-type') !== 'application/octet-stream'
    || (declaredLength !== null && declaredLength !== String(expected.bytes)) || !response.body) {
    throw new Error('UNAVAILABLE');
  }
  const bytes = new Uint8Array(expected.bytes), reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > expected.bytes - received) throw new Error('INTEGRITY');
      bytes.set(chunk.value, received);
      received += chunk.value.byteLength;
    }
    if (received !== expected.bytes) throw new Error('INTEGRITY');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== expected.sha256) throw new Error('INTEGRITY');
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
