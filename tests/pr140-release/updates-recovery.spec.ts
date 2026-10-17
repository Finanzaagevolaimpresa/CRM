import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

test('schema53 restart preserves selected work, read state and revoked rule denial', async ({ browser }) => {
  const fixture = JSON.parse(readFileSync(process.env.R05_UPDATES_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; noProvider: boolean; readerEmail: string; otherEmail: string;
    records: Record<'READ' | 'REVOKED' | 'AVAILABLE', { id: string; leadId: string }>;
  };
  expect(fixture.synthetic && fixture.noProvider).toBe(true);
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [reader, other] = await Promise.all(contexts.map(context => context.newPage()));
  async function login(page: Page, email: string) {
    await page.goto(origin + '/login');
    await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
    await page.getByRole('button', { name: 'Login interno' }).click();
    await expect(page).toHaveURL(origin + '/dashboard');
  }
  await login(reader, fixture.readerEmail); await login(other, fixture.otherEmail);
  await reader.goto(origin + '/notifications/updates');
  await expect(reader.getByText('SYNTHETIC_UPDATE_RECOVERY READ', { exact: true })).toBeVisible();
  await expect(reader.getByText('SYNTHETIC_UPDATE_RECOVERY AVAILABLE', { exact: true })).toBeVisible();
  await expect(reader.getByText('SYNTHETIC_UPDATE_RECOVERY REVOKED', { exact: true })).toHaveCount(0);
  for (const mode of ['READ', 'AVAILABLE'] as const) {
    const url = origin + '/notifications/updates/' + fixture.records[mode].id;
    await reader.goto(url);
    await expect(reader.getByRole('link', { name: 'Apri scheda', exact: true })).toHaveAttribute('href', '/leads/' + fixture.records[mode].leadId);
    if (mode === 'READ') await expect(reader.getByText(/^Segnato come letto il /)).toBeVisible();
    else await expect(reader.getByRole('button', { name: 'Segna come letto' })).toBeVisible();
    await expect(reader.getByText('SYNTHETIC_PRIVATE_UPDATE_BODY', { exact: true })).toHaveCount(0);
    await expect(reader.getByText('SYNTHETIC_PRIVATE_NOTES', { exact: true })).toHaveCount(0);
    expect((await other.request.get(url)).status()).toBe(404);
  }
  expect((await reader.request.get(origin + '/notifications/updates/' + fixture.records.REVOKED.id)).status()).toBe(404);
  await other.goto(origin + '/notifications/updates');
  await expect(other.getByText('Nessun aggiornamento disponibile', { exact: true })).toBeVisible();
  for (const context of contexts) await context.close();
});
