import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_WEBSITE_LEAD_BYTES = 16 * 1024;
export const WEBSITE_LEAD_TIMEOUT_MS = 5_000;
const MAX_SECRET_BYTES = 512;
const DUMMY_SECRET = 'n01-unconfigured-website-lead-secret';

export type WebsiteLeadMode = 'disabled' | 'legacy' | 'shadow';
export function websiteLeadMode(value = process.env.WEBSITE_LEAD_MODE): WebsiteLeadMode {
  return value === 'legacy' || value === 'shadow' || value === 'disabled' ? value : 'disabled';
}

function digest(value: string) { return createHash('sha256').update(value, 'utf8').digest(); }
export function authenticateWebsiteLead(configured: string | undefined, received: string | null) {
  const configuredValid = Boolean(configured) && Buffer.byteLength(configured!, 'utf8') <= MAX_SECRET_BYTES;
  const receivedValid = Boolean(received) && Buffer.byteLength(received!, 'utf8') <= MAX_SECRET_BYTES;
  const expected = digest(configuredValid ? configured! : DUMMY_SECRET);
  const supplied = digest(receivedValid ? received! : DUMMY_SECRET);
  return configuredValid && receivedValid && timingSafeEqual(expected, supplied);
}
export function sha256(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

export class WebsiteLeadBodyError extends Error { constructor(readonly status: 400 | 413) { super('invalid_body'); } }
export class WebsiteLeadDeadlineError extends Error { constructor() { super('deadline_exceeded'); } }
export class WebsiteLeadDeadline {
  readonly expiresAt: number;
  constructor(startedAt = Date.now(), readonly now: () => number = Date.now) {
    this.expiresAt = startedAt + WEBSITE_LEAD_TIMEOUT_MS;
  }
  remainingMs() { return Math.max(0, this.expiresAt - this.now()); }
  assertRemaining() { if (this.remainingMs() <= 0) throw new WebsiteLeadDeadlineError(); }
}

function retryableDatabaseError(error: unknown) {
  const candidate = error as { code?: string; meta?: { code?: string } };
  return candidate.code === 'P2034' || candidate.meta?.code === '40001' || candidate.meta?.code === '40P01';
}
export async function runWebsiteLeadTransactionWithRetry<T>(
  deadline: WebsiteLeadDeadline,
  operation: (timeoutMs: number, attempt: number) => Promise<T>,
  options: { sleep?: (milliseconds: number) => Promise<void> } = {},
) {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < 3; attempt++) {
    deadline.assertRemaining();
    try { return await operation(deadline.remainingMs(), attempt); }
    catch (error) {
      if (!retryableDatabaseError(error) || attempt === 2) throw error;
      deadline.assertRemaining();
      const deterministicDelay = Math.min(25 * (attempt + 1), Math.max(0, deadline.remainingMs() - 50));
      if (deterministicDelay > 0) await sleep(deterministicDelay);
      deadline.assertRemaining();
    }
  }
  throw new WebsiteLeadDeadlineError();
}
export async function readBoundedBody(request: Request, signal: AbortSignal) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_WEBSITE_LEAD_BYTES)) throw new WebsiteLeadBodyError(Number(length) > MAX_WEBSITE_LEAD_BYTES ? 413 : 400);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => void reader.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new WebsiteLeadDeadlineError();
      const { done, value } = await reader.read();
      if (signal.aborted) throw new WebsiteLeadDeadlineError();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEBSITE_LEAD_BYTES) { await reader.cancel(); throw new WebsiteLeadBodyError(413); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', abort); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new WebsiteLeadBodyError(400); }
}
