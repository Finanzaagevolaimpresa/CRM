import { test, expect, type Browser, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { syntheticSession } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { readCalendarPerimeterFixture } from '../personal-calendar/perimeter-fixtures';

const db = new PrismaClient(), origin = process.env.APP_ORIGIN!, provider = 'http://127.0.0.1:3062';
const callback = '/settings/integrations/google-calendar/callback';
const cookieName = process.env.AUTH_COOKIE_NAME!;
const baseline = process.env.CALENDAR_CALLBACK_EXPECT_BASELINE === '1';
const evidence = process.env.FLOW_EVIDENCE!;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const escapes = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
let providerServer: Server;
const attempts = new Map<string, { state: string; challenge: string; mode: string }>();
const events = () => readFileSync(join(evidence, 'simulator.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).event as string);
const exchanges = () => events().filter(event => event.startsWith('TOKEN_')).length;

test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(new URL(origin).hostname, 'localhost');
  assert.notEqual(new URL(origin).hostname, new URL(provider).hostname);
  providerServer = createServer((request, response) => {
    // All provider values remain in memory. Only an opaque local attempt index
    // appears in this simulator URL; no request logging or third party assets.
    const key = new URL(request.url!, provider).searchParams.get('attempt')!, attempt = attempts.get(key);
    if (!attempt) { response.writeHead(404).end(); return; }
    const target = new URL(callback, origin);
    target.searchParams.set('state', attempt.state);
    if (attempt.mode === 'cancel') target.searchParams.set('error', 'SYNTHETIC_PRIVATE_CANCEL');
    else target.searchParams.set('code', attempt.mode === 'provider-error' ? 'SYNTHETIC_PROVIDER_ERROR' : 'SYNTHETIC.' + attempt.challenge);
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    response.end('<!doctype html><html><body><h1>Consenso sintetico</h1><a href="' + escapes(target.href) + '">Rientra nel CRM</a></body></html>');
  });
  await new Promise<void>(resolve => providerServer.listen(3062, '127.0.0.1', resolve));
});
test.afterAll(async () => { await db.$disconnect(); await new Promise<void>(resolve => providerServer?.close(() => resolve())); });

async function actor(browser: Browser, id: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id } }), session = await syntheticSession(db, user);
  const context = await browser.newContext();
  await context.addCookies([{ name: cookieName, value: session.token, url: origin, sameSite: 'Strict', httpOnly: true,
    expires: session.session.expiresAt }]);
  const page = await context.newPage();
  return { context, page, session };
}
type Actor = Awaited<ReturnType<typeof actor>>;
async function start(subject: Actor, mode = 'success') {
  let prepared: { key: string; state: string; challenge: string; mode: string } | undefined;
  await subject.context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'accounts.google.com') {
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('redirect_uri'), origin + callback);
      assert.equal(url.searchParams.get('scope'), 'openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly');
      const key = String(attempts.size + 1);
      prepared = { key, state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')!, mode };
      attempts.set(key, prepared);
      return route.fulfill({ status: 302, headers: { location: provider + '/authorize?attempt=' + key } });
    }
    if (url.origin !== origin && url.origin !== provider) return route.abort();
    return route.continue();
  });
  await subject.page.goto(origin + '/calendars');
  await subject.page.getByRole('button', { name: 'Collega il mio Google Calendar', exact: true }).click();
  await expect(subject.page.getByRole('heading', { name: 'Consenso sintetico' })).toBeVisible();
  assert(prepared, 'AUTHORIZATION_NOT_PREPARED');
  return prepared;
}
async function returnFromProvider(page: Page) {
  let getWithoutCookie = false, postWithCookie = false, postSameOrigin = false, getCrossSite = false;
  page.on('request', async request => {
    const url = new URL(request.url());
    if (url.origin !== origin || url.pathname !== callback) return;
    const headers = await request.allHeaders();
    if (request.method() === 'GET') {
      getWithoutCookie = !headers.cookie?.includes(cookieName + '=');
      getCrossSite = headers['sec-fetch-site'] === 'cross-site';
    }
    if (request.method() === 'POST') {
      postWithCookie = !!headers.cookie?.includes(cookieName + '=');
      postSameOrigin = headers.origin === origin && headers['sec-fetch-site'] === 'same-origin';
    }
  });
  await page.getByRole('link', { name: 'Rientra nel CRM' }).click();
  return () => ({ getWithoutCookie, getCrossSite, postWithCookie, postSameOrigin });
}

test('Full cross-site return preserves Strict and the original session, PKCE and availability', async ({ browser }) => {
  const fixture = readCalendarPerimeterFixture(), subject = await actor(browser, fixture.pilotId);
  const before = exchanges(), appointments = await db.leadAppointment.count();
  try {
    const prepared = await start(subject), observed = await returnFromProvider(subject.page);
    if (baseline) {
      await expect.poll(() => new URL(subject.page.url()).pathname === '/login').toBe(true);
      expect(exchanges()).toBe(before);
      writeFileSync(join(evidence, 'cross-site-proof.json'), JSON.stringify({ phase: 'BEFORE', outcome: 'REPRODUCED_LOGIN_FAILURE',
        distinctSites: true, strictCookie: true, ...observed(), tokenExchange: false, appointmentsCreated: 0 }));
      return;
    }
    await expect(subject.page.getByText('Collegamento personale registrato.', { exact: false })).toBeVisible();
    expect(observed()).toEqual({ getWithoutCookie: true, getCrossSite: true, postWithCookie: true, postSameOrigin: true });
    expect(new URL(subject.page.url()).search).toBe('?connection=connected');
    const cookies = await subject.context.cookies(origin), current = cookies.find(cookie => cookie.name === cookieName);
    expect(current?.sameSite).toBe('Strict'); expect(current?.value === subject.session.token).toBe(true);
    expect((await db.googleCalendarOAuthState.findUniqueOrThrow({ where: { stateHash: hash(prepared.state) } })).consumedAt !== null).toBe(true);
    expect(exchanges()).toBe(before + 1);
    expect(events().includes('AVAILABILITY_READ')).toBe(true);
    expect(await db.leadAppointment.count()).toBe(appointments);
    const all = await db.googleCalendarCredential.findMany({ select: { userId: true } });
    expect(all).toEqual([{ userId: fixture.pilotId }]);
    writeFileSync(join(evidence, 'cross-site-proof.json'), JSON.stringify({ phase: 'AFTER', outcome: 'CONNECTED',
      distinctSites: true, strictCookie: true, originalSessionPreserved: true, ...observed(), pkceVerified: true,
      singleUseClaim: true, availabilityRead: true, externalNetworkRequests: 0, appointmentsCreated: 0 }));
  } finally { await subject.context.close(); }
});

for (const mode of ['cancel', 'missing-session', 'wrong-session', 'expired', 'wrong-state', 'revoked', 'provider-error'] as const) {
  test('Controlled cross-site denial: ' + mode, async ({ browser }) => {
    test.skip(baseline, 'Before-fix reproduction only');
    const fixture = readCalendarPerimeterFixture(), subject = await actor(browser, fixture.pilotId);
    try {
      const prepared = await start(subject, mode), before = exchanges();
      const credentials = await db.googleCalendarCredential.findMany();
      const stateHash = hash(prepared.state);
      if (mode === 'missing-session') await subject.context.clearCookies();
      if (mode === 'wrong-session') {
        const second = await syntheticSession(db, await db.user.findUniqueOrThrow({ where: { id: fixture.pilotId } }));
        await subject.context.addCookies([{ name: cookieName, value: second.token, url: origin, sameSite: 'Strict', httpOnly: true }]);
      }
      if (mode === 'expired') await db.googleCalendarOAuthState.update({ where: { stateHash }, data: { expiresAt: new Date(Date.now() - 1000) } });
      if (mode === 'wrong-state') attempts.get(prepared.key)!.state = 'a'.repeat(43);
      if (mode === 'revoked') await db.internalSession.update({ where: { id: subject.session.session.sessionId }, data: { revokedAt: new Date() } });
      // Render the provider's current in-memory response after changing the
      // synthetic case, then exercise an actual cross-site top-level link.
      await subject.page.reload();
      await returnFromProvider(subject.page);
      await expect(subject.page.getByRole('heading', { name: 'Collegamento non completato', exact: true })).toBeVisible();
      expect(new URL(subject.page.url()).pathname === callback && new URL(subject.page.url()).search === '').toBe(true);
      const html = await subject.page.content();
      expect(html.includes(prepared.state) || html.includes('SYNTHETIC_PRIVATE') || html.includes('SYNTHETIC_PROVIDER_ERROR')).toBe(false);
      expect(exchanges()).toBe(before + (mode === 'provider-error' ? 1 : 0));
      expect(await db.googleCalendarCredential.findMany()).toEqual(credentials);
      const consumed = (await db.googleCalendarOAuthState.findUniqueOrThrow({ where: { stateHash } })).consumedAt !== null;
      expect(consumed).toBe(mode === 'cancel' || mode === 'provider-error');
      // A cancellation or uncertain/failed token exchange is terminal: no retry.
      if (consumed) {
        await subject.page.goto(provider + '/authorize?attempt=' + prepared.key);
        await returnFromProvider(subject.page);
        await expect(subject.page.getByRole('heading', { name: 'Collegamento non completato' })).toBeVisible();
        expect(exchanges()).toBe(before + (mode === 'provider-error' ? 1 : 0));
      }
    } finally { await subject.context.close(); }
  });
}

test('Other roles cannot start OAuth or complete a pilot callback after a context switch', async ({ browser }) => {
  test.skip(baseline, 'Before-fix reproduction only');
  const fixture = readCalendarPerimeterFixture(), pilot = await actor(browser, fixture.pilotId);
  try {
    const prepared = await start(pilot), before = exchanges();
    for (const id of [fixture.adminId, fixture.setterId, fixture.otherId, fixture.technicalId]) {
      const subject = await actor(browser, id);
      try {
        const states = await db.googleCalendarOAuthState.count();
        const probe = await subject.page.goto(origin + '/calendars'); expect(probe?.status()).toBe(200);
        await expect(subject.page.getByRole('button', { name: 'Collega il mio Google Calendar', exact: true })).toHaveCount(0);
        await subject.page.goto(provider + '/authorize?attempt=' + prepared.key);
        await returnFromProvider(subject.page);
        await expect(subject.page.getByRole('heading', { name: 'Collegamento non completato' })).toBeVisible();
        expect(await db.googleCalendarOAuthState.count()).toBe(states);
        expect((await db.googleCalendarOAuthState.findUniqueOrThrow({ where: { stateHash: hash(prepared.state) } })).consumedAt).toBe(null);
        expect(exchanges()).toBe(before);
      } finally { await subject.context.close(); }
    }
  } finally { await pilot.context.close(); }
});

test('Callback envelope is resource-free, no-referrer, nonce-restricted and rejects forged posts', async ({ browser }) => {
  test.skip(baseline, 'Before-fix reproduction only');
  const subject = await actor(browser, readCalendarPerimeterFixture().pilotId);
  try {
    const prepared = await start(subject), before = exchanges();
    const url = new URL(callback, origin);
    url.searchParams.set('state', prepared.state); url.searchParams.set('code', '"><img src=https://invalid.test>');
    const envelope = await subject.context.request.get(url.href, { maxRedirects: 0 });
    expect(envelope.status()).toBe(200);
    expect(envelope.headers()['cache-control']).toBe('no-store, private');
    expect(envelope.headers()['referrer-policy']).toBe('no-referrer');
    const csp = envelope.headers()['content-security-policy'];
    expect(csp.includes("default-src 'none'") && csp.includes("script-src 'nonce-") && !csp.includes('unsafe-inline')).toBe(true);
    expect(envelope.headers().location).toBeUndefined();
    const html = await envelope.text();
    expect(/<(?:img|link|iframe|object)\b|<script[^>]+src=/i.test(html)).toBe(false);
    expect(html.includes('&quot;&gt;&lt;img')).toBe(true);
    const data = { state: prepared.state, code: 'SYNTHETIC.' + prepared.challenge };
    for (const headers of [{ Origin: provider, 'Sec-Fetch-Site': 'cross-site' }, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }]) {
      const denied = await subject.context.request.post(origin + callback, { form: data, headers, maxRedirects: 0 });
      expect(denied.status()).toBe(403);
      expect(denied.headers().location).toBeUndefined();
    }
    const duplicate = await subject.context.request.post(origin + callback, { data: new URLSearchParams(data).toString() + '&state=' + prepared.state,
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' }, maxRedirects: 0 });
    expect(duplicate.status()).toBe(400);
    expect(exchanges()).toBe(before);
  } finally { await subject.context.close(); }
});
