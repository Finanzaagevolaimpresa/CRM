import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson, syntheticSession } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { notificationCount } from '../notification-browser-helpers';
import { readCalendarPerimeterFixture } from './perimeter-fixtures';

const db = new PrismaClient(), origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:3059';
test.afterAll(async () => { await db.$disconnect(); });
test('Setter books and moves, technical calendar hides lead details, and opening a notice marks exactly one read', async ({ browser }, info) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const fixture = readCalendarPerimeterFixture();
  const setterUser = await db.user.findUniqueOrThrow({ where: { id: fixture.setterId } });
  expect(setterUser.id).toBe(process.env.CALENDAR_SETTER_USER_ID);
  expect(setterUser.active).toBe(true);
  expect(setterUser.deletedAt).toBeNull();
  expect(setterUser.role).toBe('commerciale');
  const actors = await Promise.all([
    syntheticSession(db, setterUser).then(session => ({ user: setterUser, ...session })), syntheticPerson(db, 'Ivo calendario browser', 'commerciale'),
    syntheticPerson(db, 'Tecnico calendario browser', 'consulente'), syntheticPerson(db, 'Admin calendario browser', 'admin'),
  ]);
  const contexts = await Promise.all(actors.map(async actor => {
    const context = await browser.newContext({ baseURL: origin });
    await context.addCookies([{ name: process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session', value: actor.token, url: origin,
      httpOnly: true, sameSite: 'Lax', expires: actor.session.expiresAt }]);
    return context;
  }));
  try {
    const [setter, ivo, technical, admin] = await Promise.all(contexts.map(context => context.newPage()));
    const secret = 'LEAD_RISERVATO_CALENDARIO_' + randomUUID();
    const lead = await db.lead.create({ data: { firstName: 'Persona', lastName: 'Sintetica', companyName: secret, notes: 'NOTA_RISERVATA_CALENDARIO', assignedToId: actors[0].user.id } });
    const technicalLead = await db.lead.create({ data: { firstName: 'Persona', lastName: 'Sintetica', companyName: secret + '_TECNICO', notes: 'NOTA_RISERVATA_CALENDARIO', assignedToId: actors[0].user.id } });
    for (const page of [ivo, technical]) {
      await page.goto('/calendars');
      await expect(page.getByRole('heading', { name: 'Calendari', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Calendari', exact: true }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Salva le mie fasce', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Fasce salvate.' })).toBeVisible();
    }
    const calendars = await Promise.all([actors[1], actors[2]].map(actor => db.personalCalendar.findUniqueOrThrow({ where: { userId: actor.user.id } })));
    const day = new Date(Date.now() + 7 * 86400_000); while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
    const date = day.toISOString().slice(0, 10);
    for (const [record, calendar] of [[lead, calendars[0]], [technicalLead, calendars[1]]] as const) {
      await setter.goto('/leads/' + record.id);
      const panel = setter.locator('section').filter({ has: setter.getByRole('heading', { name: 'Appuntamento', exact: true }) });
      await panel.getByLabel('Referente', { exact: true }).selectOption(calendar.id);
      await panel.getByLabel('Data e ora di Roma', { exact: true }).fill(date + 'T10:00');
      await panel.getByRole('button', { name: 'Fissa appuntamento', exact: true }).click();
      await expect.poll(async () => db.leadAppointment.count({ where: { leadId: record.id, status: 'BOOKED' } })).toBe(1);
      await expect(panel.getByText(/Salvato nel CRM/)).toBeVisible();
    }
    await technical.goto('/calendars?date=' + date + '&user=' + actors[1].user.id);
    await expect(technical.getByRole('heading', { name: 'Calendari', exact: true })).toHaveCount(0);
    expect((await technical.request.get('/calendars?date=' + date + '&user=' + actors[1].user.id)).status()).toBe(404);
    await technical.goto('/calendars?date=' + date);
    await expect(technical.getByText('Dettagli riservati al referente della scheda.')).toBeVisible();
    await expect(technical.locator('main a[href^="/leads/"]')).toHaveCount(0);
    expect(await technical.content()).not.toContain(secret);
    expect(await technical.content()).not.toContain('NOTA_RISERVATA_CALENDARIO');
    expect(await technical.content()).not.toContain(technicalLead.id);
    expect((await technical.request.get('/leads/' + lead.id)).status()).toBe(404);
    await admin.goto('/calendars?date=' + date + '&user=' + actors[1].user.id);
    await expect(admin.getByLabel('Utente', { exact: true })).toHaveValue(actors[1].user.id);
    await expect(admin.locator('a[href="/leads/' + lead.id + '"]')).toBeVisible();
    await setter.goto('/leads/' + lead.id);
    let pipeline = setter.locator('section').filter({ has: setter.getByRole('heading', { name: 'Aggiorna pipeline commerciale', exact: true }) });
    const beforePipeline = await db.leadAppointment.findUniqueOrThrow({ where: { leadId: lead.id } });
    await pipeline.locator('input[name="nextActionDate"]').fill(date + 'T10:15');
    await pipeline.getByRole('button', { name: 'Salva aggiornamenti', exact: true }).click();
    await expect(setter).toHaveURL(/appointment=use-panel/);
    expect(await db.leadAppointment.findUniqueOrThrow({ where: { leadId: lead.id } })).toEqual(beforePipeline);
    await setter.goto('/leads/' + lead.id);
    pipeline = setter.locator('section').filter({ has: setter.getByRole('heading', { name: 'Aggiorna pipeline commerciale', exact: true }) });
    await pipeline.locator('textarea[name="notes"]').fill('Note pipeline sintetiche senza spostamento');
    await pipeline.locator('select[name="priority"]').selectOption('alta');
    await pipeline.getByRole('button', { name: 'Salva aggiornamenti', exact: true }).click();
    await expect.poll(async () => (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).notes).toBe('Note pipeline sintetiche senza spostamento');
    expect(await db.leadAppointment.findUniqueOrThrow({ where: { leadId: lead.id } })).toEqual(beforePipeline);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextActionDate).toEqual(beforePipeline.startsAt);
    await setter.reload();
    let panel = setter.locator('section').filter({ has: setter.getByRole('heading', { name: 'Appuntamento', exact: true }) });
    const booked = await db.leadAppointment.findUniqueOrThrow({ where: { leadId: lead.id } });
    await panel.getByLabel('Data e ora di Roma', { exact: true }).fill(date + 'T11:00');
    await panel.getByRole('button', { name: 'Sposta appuntamento', exact: true }).click();
    await expect.poll(async () => (await db.leadAppointment.findUniqueOrThrow({ where: { leadId: lead.id } })).version).toBe(booked.version + 1);
    await setter.reload();
    panel = setter.locator('section').filter({ has: setter.getByRole('heading', { name: 'Appuntamento', exact: true }) });
    await panel.getByRole('button', { name: 'Annulla appuntamento', exact: true }).click();
    await expect.poll(async () => (await db.leadAppointment.findUniqueOrThrow({ where: { leadId: lead.id } })).status).toBe('CANCELLED');
    expect(await db.leadAppointment.count({ where: { leadId: lead.id } })).toBe(1);

    const task = await db.task.create({ data: { title: 'Richiamo sintetico browser ' + randomUUID(), assignedToId: actors[0].user.id,
      createdById: actors[0].user.id, dueAt: new Date(Date.now() - 60_000) } });
    await setter.goto('/notifications');
    const before = await notificationCount(setter);
    expect(before).toBeGreaterThan(0);
    await expect(setter.locator('article[data-notification-id]')).toHaveCount(before);
    const notice = setter.locator('article').filter({ hasText: task.title });
    const id = await notice.getAttribute('data-notification-id');
    await notice.getByRole('button', { name: 'Apri', exact: true }).click();
    await expect(setter).toHaveURL(/\/tasks$/);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('aperta');
    await setter.goto('/notifications?state=read');
    await setter.reload();
    const read = setter.locator('article[data-notification-id="' + id + '"]');
    await expect(read).toBeVisible();
    expect(await notificationCount(setter)).toBe(before - 1);
    await read.getByRole('button', { name: 'Apri', exact: true }).click();
    await expect(setter).toHaveURL(/\/tasks$/);
    expect(await notificationCount(setter)).toBe(before - 1);
    await technical.setViewportSize({ width: 390, height: 844 });
    await technical.goto('/calendars?date=' + date);
    expect(await technical.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await technical.screenshot({ path: info.outputPath('technical-calendar.png'), fullPage: true });
    await setter.goto('/notifications?state=read');
    await setter.screenshot({ path: info.outputPath('notification-read.png'), fullPage: true });
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
