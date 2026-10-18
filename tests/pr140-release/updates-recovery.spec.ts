import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

test('schema55 restart preserves selected work, read state and revoked rule denial', async ({ browser }) => {
  const fixture = JSON.parse(readFileSync(process.env.R05_UPDATES_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; noProvider: boolean; readerEmail: string; otherEmail: string; ownerEmail: string;
    records: Record<'READ' | 'REVOKED' | 'AVAILABLE', { id: string; leadId: string }>;
    emails: Record<'AVAILABLE' | 'REVOKED' | 'UNSAVED', { id: string; leadId: string }>;
  };
  expect(fixture.synthetic && fixture.noProvider).toBe(true);
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [reader, other, owner] = await Promise.all(contexts.map(context => context.newPage()));
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
  await login(owner, fixture.ownerEmail);
  await owner.goto(origin + '/communications/updates');
  await expect(owner.locator('a[href*="update=' + fixture.emails.AVAILABLE.id + '"]')).toHaveText('Apri messaggio già salvato');
  await expect(owner.locator('a[href*="update=' + fixture.emails.UNSAVED.id + '"]')).toHaveText('Prepara bozza da aggiornamento');
  await expect(owner.locator('a[href*="update=' + fixture.emails.REVOKED.id + '"]')).toHaveCount(0);
  await owner.locator('a[href*="update=' + fixture.emails.AVAILABLE.id + '"]').click();
  await expect(owner.getByText('SYNTHETIC EMAIL UPDATE HISTORY', { exact: true })).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Salva bozza', exact: true })).toHaveCount(0);
  expect((await other.request.get(origin + '/communications/updates')).status()).toBe(404);
  expect((await owner.request.get(origin + '/communications?kind=LEAD&practice=' + fixture.emails.REVOKED.leadId + '&update=' + fixture.emails.REVOKED.id)).status()).toBe(404);
  for (const context of contexts) await context.close();
});
