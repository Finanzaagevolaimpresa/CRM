import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { syntheticSession } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { readCalendarPerimeterFixture } from './perimeter-fixtures';

const db = new PrismaClient(), origin = process.env.APP_ORIGIN ?? 'http://localhost:3059';
const googleHosts = new Set(['accounts.google.com', 'oauth2.googleapis.com', 'openidconnect.googleapis.com', 'www.googleapis.com']);
test.afterAll(async () => { await db.$disconnect(); });
async function contextFor(browser: Browser, userId: string, googleRequests: string[]) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } }), session = await syntheticSession(db, user);
  const context = await browser.newContext({ baseURL: origin });
  await context.addCookies([{ name: process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session', value: session.token, url: origin,
    httpOnly: true, sameSite: 'Lax', expires: session.session.expiresAt }]);
  await context.route(url => googleHosts.has(url.hostname), async route => {
    googleRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  return context;
}
const section = (page: Page, title: string) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

test('Admin and the exact Setter select every active referent, read their bands and keep Lead confidentiality', async ({ browser }, info) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const fixture = readCalendarPerimeterFixture(), requests: string[] = [], contexts: BrowserContext[] = [];
  try {
    for (const actorId of [fixture.adminId, fixture.setterId]) {
      const context = await contextFor(browser, actorId, requests); contexts.push(context);
      const page = await context.newPage();
      await page.goto('/calendars?date=' + fixture.date);
      const people = page.getByLabel('Utente', { exact: true }); await expect(people).toBeVisible();
      for (const id of [fixture.pilotId, fixture.setterId, fixture.otherId, fixture.technicalId, fixture.adminId])
        await expect(people.locator('option[value="' + id + '"]')).toHaveCount(1);
      for (const id of [fixture.inactiveId, fixture.deletedId]) await expect(people.locator('option[value="' + id + '"]')).toHaveCount(0);
      await people.selectOption(fixture.pilotId);
      await page.getByRole('button', { name: 'Mostra calendario', exact: true }).click();
      await expect(people).toHaveValue(fixture.pilotId);
      const bands = section(page, 'Fasce del referente');
      await expect(bands.getByText('Lunedì 09:00 – 10:00', { exact: true })).toBeVisible();
      await expect(bands.locator('input,select,button')).toHaveCount(0);
      await expect(section(page, 'Disponibilità')).toContainText('Calendario locale');
      await expect(section(page, 'Appuntamenti e richiami').locator('article')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Collega il mio Google Calendar', exact: true })).toHaveCount(0);
      if (actorId === fixture.setterId) {
        await expect(page.getByText('Dettagli riservati al referente della scheda.', { exact: true })).toBeVisible();
        await expect(page.locator('main a[href="/leads/' + fixture.privateLeadId + '"]')).toHaveCount(0);
        const html = await page.content();
        expect(html).not.toContain(fixture.privateMarker); expect(html).not.toContain('CALENDAR_PRIVATE_NOTE');
        const flight = await context.request.get('/calendars?date=' + fixture.date + '&user=' + fixture.pilotId, { headers: { RSC: '1' } });
        expect(flight.status()).toBe(200);
        expect(flight.headers()['content-type']).toContain('text/x-component');
        const flightBody = await flight.text();
        expect(flightBody).not.toContain(fixture.privateMarker); expect(flightBody).not.toContain('CALENDAR_PRIVATE_NOTE');
        // The existing Lead reader renders its generic denial with HTTP 200.
        // Prove the actual denied UI and absence of private bytes, not a status
        // code that this page has never promised to return.
        const deniedLead = await context.newPage();
        await deniedLead.goto('/leads/' + fixture.privateLeadId);
        await expect(deniedLead.getByRole('heading', { name: 'Lead non trovato', exact: true })).toBeVisible();
        await expect(deniedLead.getByRole('heading', { name: 'Appuntamento', exact: true })).toHaveCount(0);
        const deniedHtml = await deniedLead.content();
        expect(deniedHtml).not.toContain(fixture.privateMarker); expect(deniedHtml).not.toContain('CALENDAR_PRIVATE_NOTE');
        await deniedLead.close();
        const ownEditor = section(page, 'Le mie fasce');
        await expect(ownEditor.locator('input[name="start-1-0"]')).toHaveValue('11:00');
        const before = await db.personalCalendar.findUniqueOrThrow({ where: { userId: fixture.pilotId } });
        await ownEditor.locator('input[name="start-1-0"]').fill('11:15');
        await ownEditor.getByRole('button', { name: 'Salva le mie fasce', exact: true }).click();
        await expect(ownEditor.getByRole('status')).toHaveText('Fasce salvate.');
        expect(await db.personalCalendar.findUniqueOrThrow({ where: { userId: fixture.pilotId } })).toEqual(before);
        expect((await db.personalCalendar.findUniqueOrThrow({ where: { userId: fixture.setterId } })).availability)
          .toEqual([{ weekday: 1, startMinute: 675, endMinute: 720 }]);
      } else await expect(page.locator('a[href="/leads/' + fixture.privateLeadId + '"]')).toBeVisible();
      for (const id of [fixture.inactiveId, fixture.deletedId, 'missing-synthetic-calendar-user'])
        expect((await page.request.get('/calendars?user=' + id)).status()).toBe(404);
      expect((await page.request.get('/calendars?user=' + fixture.pilotId + '&user=' + fixture.setterId)).status()).toBe(404);
      await page.screenshot({ path: info.outputPath(actorId === fixture.setterId ? 'setter-all-calendars.png' : 'admin-all-calendars.png'), fullPage: true });
    }
    expect(requests).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('Other commercial and technical accounts remain own-only, including a forged user parameter', async ({ browser }, info) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const fixture = readCalendarPerimeterFixture(), requests: string[] = [], contexts: BrowserContext[] = [];
  try {
    for (const id of [fixture.pilotId, fixture.otherId, fixture.technicalId]) {
      const context = await contextFor(browser, id, requests); contexts.push(context);
      const page = await context.newPage();
      await page.goto('/calendars?date=' + fixture.date + '&user=' + id);
      await expect(page.getByRole('heading', { name: 'Calendari', exact: true })).toBeVisible();
      await expect(page.getByLabel('Utente', { exact: true })).toHaveCount(0);
      const selected = await db.user.findUniqueOrThrow({ where: { id } });
      await expect(section(page, 'Fasce del referente')).toContainText(selected.name);
      await expect(page.getByRole('button', { name: 'Collega il mio Google Calendar', exact: true })).toHaveCount(id === fixture.pilotId ? 1 : 0);
      const response = await page.goto('/calendars?date=' + fixture.date + '&user=' + fixture.setterId);
      expect(response?.status()).toBe(404);
      expect(await page.content()).not.toContain(fixture.privateMarker);
      await expect(page.getByRole('heading', { name: 'Fasce del referente', exact: true })).toHaveCount(0);
      expect((await page.request.get('/calendars?user=' + id + '&user=' + fixture.setterId)).status()).toBe(404);
      await page.screenshot({ path: info.outputPath('foreign-user-denied-' + id.slice(-6) + '.png'), fullPage: true });
    }
    expect(requests).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('Only the pilot can prepare consent; forged actions and callbacks never contact Google or persist credentials', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const fixture = readCalendarPerimeterFixture(), requests: string[] = [], contexts: BrowserContext[] = [];
  try {
    const pilotContext = await contextFor(browser, fixture.pilotId, requests); contexts.push(pilotContext);
    const pilot = await pilotContext.newPage();
    await pilot.goto('/calendars?connection=connected');
    await expect(pilot.getByText('Calendario Google non collegato.', { exact: false })).toBeVisible();
    await expect(pilot.getByText('Collegamento personale registrato.', { exact: false })).toHaveCount(0);
    const connect = pilot.getByRole('button', { name: 'Collega il mio Google Calendar', exact: true });
    const actionName = await connect.locator('xpath=ancestor::form').locator('input[name^="$ACTION_ID_"]').getAttribute('name');
    assert(actionName);
    const others: BrowserContext[] = [];
    const before = await db.googleCalendarOAuthState.count({ where: { userId: fixture.pilotId } });
    for (const id of [fixture.adminId, fixture.setterId, fixture.otherId, fixture.technicalId]) {
      const context = await contextFor(browser, id, requests); contexts.push(context); others.push(context);
      const page = await context.newPage(); await page.goto('/calendars');
      await expect(page.getByRole('button', { name: 'Collega il mio Google Calendar', exact: true })).toHaveCount(0);
      // Next decodes MPA Server Actions from multipart; URL-encoded POSTs do
      // not invoke this action and therefore cannot qualify its role denial.
      const response = await context.request.post('/calendars', { multipart: { [actionName]: '' }, headers: { Origin: origin }, maxRedirects: 0 });
      expect(response.status()).toBe(303);
      expect(response.headers().location).toMatch(/\/calendars\?connection=unavailable$/);
      expect(await db.googleCalendarOAuthState.count({ where: { userId: id } })).toBe(0);
    }
    expect(requests).toEqual([]);
    expect(await db.googleCalendarOAuthState.count({ where: { userId: fixture.pilotId } })).toBe(before);
    const outgoing = pilot.waitForRequest(request => new URL(request.url()).hostname === 'accounts.google.com');
    await connect.click();
    const authorization = new URL((await outgoing).url());
    await expect.poll(() => requests.length).toBe(1);
    expect(authorization.pathname).toBe('/o/oauth2/v2/auth');
    expect(authorization.searchParams.get('client_id')).toBe('synthetic-calendar-ci-client');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly']);
    expect(authorization.searchParams.has('client_secret')).toBe(false);
    const state = authorization.searchParams.get('state'); assert(state);
    for (const context of others) {
      const response = await context.request.get('/settings/integrations/google-calendar/callback?state=' + encodeURIComponent(state) + '&code=SYNTHETIC_CODE_NOT_FOR_PROVIDER', { maxRedirects: 0 });
      expect(response.status()).toBe(303);
      expect(response.headers().location).toMatch(/\/calendars\?connection=error$/);
      expect(response.headers()['cache-control']).toBe('no-store, private');
      expect(response.headers()['referrer-policy']).toBe('no-referrer');
    }
    const cancelled = await pilotContext.request.get('/settings/integrations/google-calendar/callback?error=access_denied&state=' + encodeURIComponent(state), { maxRedirects: 0 });
    expect(cancelled.status()).toBe(303); expect(cancelled.headers().location).toMatch(/\/calendars\?connection=error$/);
    expect(requests).toHaveLength(1);
    const ids = [fixture.pilotId, fixture.setterId, fixture.adminId, fixture.otherId, fixture.technicalId];
    expect(await db.googleCalendarCredential.count({ where: { userId: { in: ids } } })).toBe(0);
    expect(await db.googleCalendarOAuthState.count({ where: { userId: fixture.pilotId, consumedAt: { not: null } } })).toBe(0);
    expect((await db.personalCalendar.findUniqueOrThrow({ where: { userId: fixture.pilotId } })).mode).toBe('LOCAL');
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
