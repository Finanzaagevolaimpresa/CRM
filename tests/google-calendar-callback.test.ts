import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarCallbackBridge, calendarCallbackFailure, parseCalendarCallback, readCalendarCallbackForm } from '../src/lib/google-calendar-callback';
const state = 'a'.repeat(43);
const query = (fields: Record<string, string>) => new URLSearchParams(fields);

test('Callback accepts one bounded state and code, or a cancellation without provider details', () => {
  assert.deepEqual(parseCalendarCallback(query({ state, code: 'opaque', scope: 'untrusted', authuser: '0' }), 'query'), { state, code: 'opaque' });
  assert.deepEqual(parseCalendarCallback(query({ state, error: 'PRIVATE_PROVIDER_DETAIL', error_description: 'PRIVATE' }), 'query'), { state, cancelled: true });
  assert.deepEqual(parseCalendarCallback(query({ state, cancelled: 'true' }), 'form'), { state, cancelled: true });
  const invalid: Record<string, string>[] = [{ state, code: '' }, { state, code: 'a'.repeat(4097) }, { state, code: 'a\nb' }, { state: 'bad', code: 'x' },
    { state, code: 'x', error: 'denied' }, { state, cancelled: 'true', code: 'x' }];
  for (const fields of invalid) assert.equal(parseCalendarCallback(query(fields), 'query'), null);
  assert.equal(parseCalendarCallback(new URLSearchParams('state=' + state + '&state=' + state + '&code=x'), 'query'), null);
  assert.equal(parseCalendarCallback(query({ state, code: 'x', extra: 'ignored?' }), 'form'), null);
  assert.equal(parseCalendarCallback(query({ state, cancelled: 'false' }), 'form'), null);
});

test('Callback bridge escapes opaque values, uses only a nonce and a fixed same-origin form, and erases history first', async () => {
  const response = calendarCallbackBridge({ state, code: '\"><script src="https://foreign.invalid">\'&' }), html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert(html.includes('<meta name="referrer" content="strict-origin">'));
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert(html.includes('&quot;&gt;&lt;script src=&quot;https://foreign.invalid&quot;&gt;&#39;&amp;'));
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert(!/<(?:link|iframe|img|object)\b|<script[^>]*src=/i.test(html));
  assert(html.indexOf('history.replaceState') < html.indexOf(".submit()"));
  const nonce = html.match(/<script nonce="([A-Za-z0-9+/]+)">/)?.[1]; assert(nonce);
  assert(response.headers.get('content-security-policy')?.includes("script-src 'nonce-" + nonce + "'"));
  assert(!response.headers.get('content-security-policy')?.includes('unsafe-inline'));
});

test('Denials have no opaque values, no resources, no redirect and no session cookie mutation', async () => {
  for (const reason of ['session', 'error', 'cancelled'] as const) {
    const response = calendarCallbackFailure(403, reason), html = await response.text();
    assert.equal(response.status, 403);
    assert(html.includes('Collegamento non completato'));
    assert(!html.includes(state));
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
});

test('Bounded form reader rejects wrong content type, duplicate keys, oversized and malformed UTF8 streams', async () => {
  const request = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('http://localhost/settings/integrations/google-calendar/callback', { method: 'POST', body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, duplex: 'half' } as RequestInit);
  assert.deepEqual(await readCalendarCallbackForm(request(query({ state, code: 'opaque' }))), { state, code: 'opaque' });
  assert.equal(await readCalendarCallbackForm(request(query({ state, code: 'opaque' }), { 'content-type': 'application/json' })), null);
  assert.equal(await readCalendarCallbackForm(request('state=' + state + '&code=a&code=b')), null);
  assert.equal(await readCalendarCallbackForm(request('x'.repeat(16_385))), null);
  assert.equal(await readCalendarCallbackForm(request('state=' + state, { 'content-length': '20000' })), null);
  assert.equal(await readCalendarCallbackForm(request(new Uint8Array([255]))), null);
});
