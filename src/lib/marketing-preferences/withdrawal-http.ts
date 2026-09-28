import { z } from 'zod';
import type { MarketingPreferences } from './service';

const input = z.object({ email: z.string().max(254).email(), requestId: z.string().uuid() }).strict();
type Format = 'json' | 'html';
function reply(status: number, message: string, format: Format) {
  const headers = {
    'content-type': format === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
  // Only fixed application messages are rendered, never the email or a contact-existence flag.
  const escaped = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const body = format === 'html'
    ? `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Preferenze email</title></head><body><main><h1>Preferenze email</h1><p role="status">${escaped}</p><a href="/preferenze-email/">Torna alle preferenze email</a></main></body></html>`
    : JSON.stringify({ message });
  return new Response(body, { status, headers });
}

export type WithdrawalRuntime = Readonly<{
  service: Pick<MarketingPreferences, 'suppressPublic'>;
  publicOrigin: string;
  // Must be a shared, qualified admission/rate limiter, not a process-local counter.
  admitRequest: (request: Request) => Promise<boolean>;
}>;

async function boundedText(request: Request) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > 1024)) throw new Error('BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('BODY_REQUIRED');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); throw new Error('BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

async function readInput(request: Request, format: Format) {
  const text = await boundedText(request);
  if (format === 'json') return input.parse(JSON.parse(text));
  const fields = new URLSearchParams(text);
  if (fields.size !== 2 || fields.getAll('email').length !== 1 || fields.getAll('requestId').length !== 1) {
    throw new Error('FORM_FIELDS_INVALID');
  }
  return input.parse(Object.fromEntries(fields));
}

/** Unmounted adapter. Neither this module nor its tests publish a route on WordPress or CRM. */
export function createWithdrawalPost(runtime: WithdrawalRuntime | null = null) {
  return async (request: Request): Promise<Response> => {
    const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const format: Format = contentType === 'application/x-www-form-urlencoded' ? 'html' : 'json';
    const respond = (status: number, message: string) => reply(status, message, format);
    const unavailable = () => respond(503, 'Richiesta non completata. Riprova più tardi.');
    if (!runtime) return unavailable();
    if (request.method !== 'POST') return respond(405, 'Metodo non disponibile.');
    let allowedOrigin: string;
    try { allowedOrigin = new URL(runtime.publicOrigin).origin; }
    catch { return unavailable(); }
    if (allowedOrigin !== runtime.publicOrigin || request.headers.get('origin') !== allowedOrigin
      || new URL(request.url).origin !== allowedOrigin) return respond(403, 'Richiesta non consentita.');
    if (contentType !== 'application/json' && contentType !== 'application/x-www-form-urlencoded') {
      return respond(415, 'Formato non disponibile.');
    }
    try {
      if (!await runtime.admitRequest(request)) return respond(429, 'Riprova più tardi.');
    } catch { return unavailable(); }
    let body: z.infer<typeof input>;
    try { body = await readInput(request, format); }
    catch { return respond(400, 'Controlla l’indirizzo email e riprova.'); }
    try {
      const outcome = await runtime.service.suppressPublic(body.email, body.requestId);
      // Same response for a known contact, an unknown contact and a committed replay.
      // A conflict is not a successful withdrawal receipt, even when quarantine blocks sends.
      return outcome === 'RECORDED' || outcome === 'REPLAY'
        ? respond(200, 'Richiesta registrata. Il blocco delle email promozionali è stato acquisito.') : unavailable();
    } catch { return unavailable(); }
  };
}

/** R13 has no runtime composition, route, key provisioning or activation environment flag. */
export function marketingWithdrawalRuntime(): WithdrawalRuntime | null { return null; }
