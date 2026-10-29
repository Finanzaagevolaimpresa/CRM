import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

test('schema71 exact-image restart retains reminder instants, read receipts, cancellation and current source denial', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_REMINDER_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; noSend: boolean; authorEmail: string; readerEmail: string; otherEmail: string;
    records: Record<string, { commandId: string; deliveryId: string; taskId: string; remindAt: string }>;
  };
  expect(f.synthetic && f.noSend).toBe(true);
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [reader, other, author] = await Promise.all(contexts.map(c => c.newPage()));
  async function login(page: Page, email: string) {
    await page.goto(origin + '/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
    await page.getByRole('button', { name: 'Login interno', exact: true }).click(); await expect(page).toHaveURL(origin + '/dashboard');
  }
  await login(reader, f.readerEmail); await login(other, f.otherEmail); await login(author, f.authorEmail);
  await reader.goto(origin + '/notifications/updates');
  for (const state of ['READ', 'AVAILABLE']) {
    await expect(reader.locator(`a[href="/notifications/updates/${f.records[state].deliveryId}"]`)).toBeVisible();
  }
  for (const state of ['SCHEDULED', 'CANCELED', 'SUPPRESSED']) {
    const path = '/notifications/updates/' + f.records[state].deliveryId;
    await expect(reader.locator(`a[href="${path}"]`)).toHaveCount(0);
    expect((await reader.request.get(origin + path)).status()).toBe(404);
  }
  for (const state of ['READ', 'AVAILABLE']) {
    const path = '/notifications/updates/' + f.records[state].deliveryId;
    await reader.goto(origin + path);
    await expect(reader.getByText('Scadenza dell’attività:', { exact: false })).toBeVisible();
    expect(await reader.locator('body').innerText()).not.toMatch(/SYNTHETIC_TASK_TITLE_PRIVATE|SYNTHETIC_TASK_NOTE_PRIVATE/);
    if (state === 'READ') await expect(reader.getByText(/^Segnato come letto il /)).toBeVisible();
    else await expect(reader.getByRole('button', { name: 'Segna come letto', exact: true })).toBeVisible();
    expect((await other.request.get(origin + path)).status()).toBe(404);
  }
  const labels = { SCHEDULED: 'Programmato', AVAILABLE: 'Disponibile nel CRM', READ: 'Letto nel CRM', CANCELED: 'Annullato', SUPPRESSED: 'Sospeso: attività, destinatari o permessi non più conformi' };
  for (const [state, label] of Object.entries(labels)) {
    const path = '/notifications/reminders/' + f.records[state].commandId;
    await author.goto(origin + path); await expect(author.getByText(label, { exact: true })).toBeVisible();
    expect((await reader.request.get(origin + path)).status()).toBe(404);
    expect((await other.request.get(origin + path)).status()).toBe(404);
  }
  for (const c of contexts) await c.close();
});
