import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { syntheticSession } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { agendaDate, agendaIds, agendaPrivateMarker } from './fixtures';
import { calendarWeek } from '../../src/lib/calendar-week';

const db = new PrismaClient(), origin = process.env.APP_ORIGIN ?? 'http://localhost:3063';
async function contextFor(browser: Browser, id: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id } }), session = await syntheticSession(db, user);
  const context = await browser.newContext({ baseURL: origin, locale: 'it-IT', viewport: { width: 1600, height: 1100 } });
  await context.addCookies([{ name: process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session', value: session.token, url: origin,
    httpOnly: true, sameSite: 'Strict', expires: session.session.expiresAt }]);
  await context.route(url => !['localhost','127.0.0.1','[::1]'].includes(url.hostname), route => route.abort('blockedbyclient'));
  return context;
}
async function schedulingState() {
  return JSON.stringify(await Promise.all([
    db.leadAppointment.findMany({ orderBy: { id: 'asc' } }), db.personalCalendar.findMany({ orderBy: { id: 'asc' } }),
    db.lead.findMany({ where: { id: { startsWith: 'agenda-' } }, orderBy: { id: 'asc' } }),
  ]));
}
let before: string;
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); before = await schedulingState(); });
test.afterAll(async () => { try { expect(await schedulingState()).toBe(before); } finally { await db.$disconnect(); } });

test('commercial week opens the authorized named Lead, keeps Google anonymous, and navigates empty and unavailable weeks', async ({ browser }, info) => {
  const context = await contextFor(browser, agendaIds.pilot), page = await context.newPage();
  try {
    await page.goto('/calendars?date=' + agendaDate);
    const grid = page.getByLabel('Agenda settimanale Europe/Rome');
    await expect(grid.locator(':scope > section')).toHaveCount(7);
    const appointment = grid.locator('article').filter({ hasText: 'Ada Esempio' });
    await expect(appointment).toHaveCount(1); await expect(appointment).toContainText('09:00 – 09:45');
    await expect(appointment).toContainText('Officina Dimostrativa');
    await expect(appointment).toContainText('Salvato nel CRM');
    await expect(grid).not.toContainText('Google non collegato');
    await expect(grid.getByText('Bruno Prova', { exact: true })).toBeVisible();
    await expect(grid.locator('article[data-state="CANCELLED"]')).toContainText('Annullato');
    await expect(grid.locator('article[data-state="COMPLETED"]')).toContainText('Svolto');
    const busy = grid.locator('[data-calendar-entry="google"]');
    await expect(busy).toHaveCount(2); await expect(busy.first()).toContainText('Occupato');
    await expect(busy.first()).toContainText('11:30 – 12:30');
    await expect(busy.last()).toContainText('Tutto il giorno');
    await expect(busy.locator('a')).toHaveCount(0);
    expect(await busy.allTextContents()).not.toContain('Ada Esempio');
    await page.screenshot({ path: info.outputPath('agenda-desktop.png'), fullPage: true });
    await appointment.getByRole('link', { name: 'Ada Esempio', exact: true }).click();
    await expect(page).toHaveURL(/\/leads\/agenda-booked$/);
    await expect(page.getByRole('heading', { name: 'Appuntamento', exact: true })).toBeVisible();
    await page.goto('/calendars?date=' + agendaDate);
    await page.getByRole('link', { name: 'Settimana successiva →', exact: true }).click();
    await expect(page.locator('input[name="date"]')).toHaveValue('2030-06-10');
    await expect(page.getByText('Nessun appuntamento', { exact: true })).toBeVisible();
    await expect(page.locator('[data-calendar-entry]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('agenda-empty-week.png'), fullPage: true });
    await page.getByRole('link', { name: 'Settimana successiva →', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Disponibilità Google non verificabile.' })).toBeVisible();
    await expect(page.getByText('Nessuna occupazione Google nella settimana selezionata.', { exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: '← Settimana precedente', exact: true }).click();
    await expect(page.locator('input[name="date"]')).toHaveValue('2030-06-10');
    await page.getByRole('link', { name: 'Questa settimana', exact: true }).click();
    await expect(page.locator('input[name="date"]')).toHaveValue(calendarWeek(undefined).startDate);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/calendars?date=' + agendaDate);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('link', { name: 'Ada Esempio', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('agenda-mobile.png'), fullPage: true });
  } finally { await context.close(); }
});

test('Admin and the configured Setter select all referents, preserve the selection across weeks and disclose only admitted Lead names', async ({ browser }) => {
  for (const id of [agendaIds.admin, agendaIds.setter]) {
    const context = await contextFor(browser, id), page = await context.newPage();
    try {
      await page.goto('/calendars?date=' + agendaDate);
      const people = page.getByLabel('Utente', { exact: true });
      for (const actorId of Object.values(agendaIds)) await expect(people.locator('option[value="' + actorId + '"]')).toHaveCount(1);
      await people.selectOption(agendaIds.pilot); await page.getByRole('button', { name: 'Mostra calendario', exact: true }).click();
      await expect(people).toHaveValue(agendaIds.pilot);
      await expect(page.locator('[data-calendar-entry="google"]')).toHaveCount(2);
      if (id === agendaIds.admin) await expect(page.getByRole('link', { name: 'Ada Esempio', exact: true })).toBeVisible();
      else {
        await expect(page.getByText('Impegno riservato', { exact: true }).first()).toBeVisible();
        await expect(page.locator('main a[href="/leads/agenda-booked"]')).toHaveCount(0);
        const html = await page.content();
        for (const secret of ['Ada Esempio', 'Officina Dimostrativa', 'AGENDA_PRIVATE_NOTE_EXCLUDED']) expect(html).not.toContain(secret);
        const flight = await context.request.get('/calendars?date=' + agendaDate + '&user=' + agendaIds.pilot, { headers: { RSC: '1' } });
        expect(flight.status()).toBe(200);
        for (const secret of ['Ada Esempio', 'Officina Dimostrativa', 'AGENDA_PRIVATE_NOTE_EXCLUDED']) expect(await flight.text()).not.toContain(secret);
        const denied = await context.newPage(); await denied.goto('/leads/agenda-booked');
        await expect(denied.getByRole('heading', { name: 'Lead non trovato', exact: true })).toBeVisible();
        await denied.close();
      }
      await page.getByRole('link', { name: 'Settimana successiva →', exact: true }).click();
      await expect(people).toHaveValue(agendaIds.pilot);
      await page.getByRole('link', { name: 'Questa settimana', exact: true }).click();
      await expect(people).toHaveValue(agendaIds.pilot);
      await expect(page.getByRole('button', { name: 'Collega il mio Google Calendar', exact: true })).toHaveCount(0);
    } finally { await context.close(); }
  }
});

test('other profiles remain own-only; technical assignments and office retain the same authorized practice without Lead disclosure', async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  try {
    for (const id of [agendaIds.other, agendaIds.technical]) {
      const context = await contextFor(browser, id); contexts.push(context);
      const page = await context.newPage(); await page.goto('/calendars?date=' + agendaDate);
      await expect(page.getByLabel('Utente', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Collega il mio Google Calendar', exact: true })).toHaveCount(0);
      expect((await page.request.get('/calendars?date=' + agendaDate + '&user=' + agendaIds.pilot)).status()).toBe(404);
      if (id === agendaIds.technical) {
        await expect(page.getByText('Impegno riservato', { exact: true })).toBeVisible();
        expect(await page.content()).not.toContain(agendaPrivateMarker);
        expect(await page.content()).not.toContain('agenda-technical-private');
        await expect(page.locator('main a[href^="/leads/"]')).toHaveCount(0);
        await page.goto('/assignments');
        await expect(page.getByRole('heading', { name: 'Le mie assegnazioni', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Pratica agenda assegnata', exact: true })).toBeVisible();
        expect(await page.content()).not.toContain('AGENDA_PRATICA_ALTRUI');
        expect((await page.request.get('/assignments?kind=Lead')).status()).toBe(404);
        await page.goto('/technical-office');
        await expect(page.getByRole('heading', { name: 'Ufficio Tecnico', exact: true })).toBeVisible();
        expect(await page.content()).not.toContain('AGENDA_PRATICA_ALTRUI');
        await page.getByRole('link', { name: 'Lista pratiche', exact: true }).click();
        await expect(page.locator('main')).toContainText('Pratica agenda assegnata');
        expect(await page.content()).not.toContain('AGENDA_PRATICA_ALTRUI');
        expect(await page.content()).not.toContain(agendaPrivateMarker);
        expect((await page.request.get('/technical-office/practices/agenda-practice-foreign')).status()).toBe(404);
      } else await expect(page.getByText('Nessun appuntamento', { exact: true })).toBeVisible();
    }
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
