import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
test('historical contact and conversion survive exact-image restart without SLA rewrite or cross-owner access', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_HISTORICAL_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; ownerEmail: string; otherEmail: string; adminEmail: string;
    records: Record<string, { leadId: string; contactId: string; conversionId?: string; clientId?: string }>;
  };
  expect(f.synthetic).toBe(true);
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  async function login(page: Page, email: string) {
    await page.goto(origin + '/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
    await page.getByRole('button', { name: 'Login interno', exact: true }).click(); await expect(page).toHaveURL(origin + '/dashboard');
  }
  const contactPath = '/leads/' + f.records.CONTACT.leadId + '/historical-contact?historicalContactCommand=' + f.records.CONTACT.contactId;
  const convertedPath = '/leads/' + f.records.CONVERTED.leadId + '/historical-conversion?historicalConversionCommand=' + f.records.CONVERTED.conversionId;
  for (const [email, permitted] of [[f.ownerEmail, true], [f.otherEmail, false], [f.adminEmail, false]] as const) {
    const context = await browser.newContext(), page = await context.newPage();
    await login(page, email);
    await page.goto(origin + contactPath);
    await expect(page.getByRole('heading', { name: permitted ? 'Contatto registrato' : 'Contatto precedente non disponibile', exact: true })).toBeVisible();
    if (permitted) await expect(page.getByText('SYNTHETIC_HISTORICAL_RECOVERY_REFERENCE', { exact: true })).toBeVisible();
    else expect(await page.content()).not.toContain('SYNTHETIC_HISTORICAL_RECOVERY_REFERENCE');
    await page.goto(origin + convertedPath);
    await expect(page.getByRole('heading', { name: permitted ? 'Cliente registrato' : 'Conversione storica non disponibile', exact: true })).toBeVisible();
    if (permitted) await expect(page.getByRole('link', { name: 'Apri cliente', exact: true })).toHaveAttribute('href', '/clients/' + f.records.CONVERTED.clientId);
    else expect(await page.content()).not.toContain(f.records.CONVERTED.clientId!);
    await context.close();
  }
});
