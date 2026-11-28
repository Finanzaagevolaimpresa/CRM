import { randomBytes } from 'node:crypto';

export const calendarCallbackPath = '/settings/integrations/google-calendar/callback';
export type CalendarCallbackInput = { state: string } & ({ code: string } | { cancelled: true });
const maximumBytes = 16_384;
const statePattern = /^[A-Za-z0-9_-]{43}$/;
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Only canonical fields cross the bridge; provider error text and extra query
 * parameters never enter HTML, logs, redirects or the authenticated operation. */
export function parseCalendarCallback(fields: URLSearchParams, source: 'query' | 'form'): CalendarCallbackInput | null {
  if (fields.toString().length > maximumBytes || [...fields.keys()].some(key => fields.getAll(key).length !== 1)) return null;
  const state = fields.get('state');
  if (!state || !statePattern.test(state)) return null;
  const code = fields.get('code'), cancellation = source === 'query' ? fields.has('error') : fields.get('cancelled') === 'true';
  if (source === 'form' && [...fields.keys()].some(key => !['state', 'code', 'cancelled'].includes(key))) return null;
  if (source === 'query' && fields.has('cancelled')) return null;
  if (cancellation) return code === null ? { state, cancelled: true } : null;
  if (fields.has('cancelled') || !code || code.length > 4096 || /[\u0000-\u001f\u007f]/u.test(code)) return null;
  return { state, code };
}

export async function readCalendarCallbackForm(request: Request): Promise<CalendarCallbackInput | null> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) { await reader.cancel(); return null; }
      chunks.push(result.value);
    }
    return parseCalendarCallback(new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), 'form');
  } catch { return null; }
  finally { reader.releaseLock(); }
}

function page(content: string, status: number, submit = false) {
  const nonce = randomBytes(24).toString('base64');
  // no-referrer makes the Origin of an HTML form POST "null". On the
  // transport document disclose at most the origin (never path/query), so the
  // existing exact-Origin CSRF guard remains effective. Denials send nothing.
  const referrerPolicy = submit ? 'strict-origin' : 'no-referrer';
  // First commit a document on the CRM origin, erase the sensitive query from
  // its history entry, then submit to the exact same endpoint. Strict session
  // cookies are available only on this new same-origin navigation.
  const script = "history.replaceState(null,'','" + calendarCallbackPath + "');"
    + (submit ? "document.getElementById('calendar-return').submit();" : '');
  return new Response('<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="referrer" content="' + referrerPolicy + '">'
    + '<title>Collegamento Google Calendar · FAI</title></head><body><main>' + content + '</main>'
    + '<script nonce="' + nonce + '">' + script + '</script></body></html>', { status, headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, private', 'Referrer-Policy': referrerPolicy,
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    } });
}
export function calendarCallbackFailure(status = 400, reason: 'error' | 'session' | 'cancelled' = 'error') {
  const message = reason === 'session' ? 'La sessione non è disponibile. Accedi al CRM e riparti dal tuo calendario.'
    : reason === 'cancelled' ? 'Collegamento annullato. Puoi ripartire dal tuo calendario.'
      : 'Il tentativo non è valido o non può essere completato. Riparti dal tuo calendario.';
  return page('<h1>Collegamento non completato</h1><p>' + message + '</p><a href="'
    + (reason === 'session' ? '/login' : '/calendars') + '">Torna al CRM</a>', status);
}
export function calendarCallbackBridge(input: CalendarCallbackInput) {
  const fields = 'code' in input ? { state: input.state, code: input.code } : { state: input.state, cancelled: 'true' };
  return page('<h1>Rientro nel CRM</h1><p>Verifica del collegamento personale in corso.</p>'
    + '<form id="calendar-return" action="' + calendarCallbackPath + '" method="post" autocomplete="off">'
    + Object.entries(fields).map(([name, value]) => '<input type="hidden" name="' + name + '" value="' + escape(value) + '">').join('')
    + '<button type="submit">Completa il collegamento</button></form>', 200, true);
}
