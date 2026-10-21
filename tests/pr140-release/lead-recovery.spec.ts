import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('schema60 restart preserves exact selected lead fields and durable denial after revocation', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_LEAD_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; email: string; liveId: string; liveLabel: string; privateEmail: string;
    revokedId: string; otherId: string; otherLabel: string;
  };
  expect(f.synthetic).toBe(true);
  const context = await browser.newContext(), page = await context.newPage();
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  await page.goto(origin + '/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email').fill(f.email);
  await page.getByLabel('Password').fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(origin + '/dashboard');
  await page.goto(origin + '/shared-leads/' + f.liveId);
  await expect(page.getByText(f.liveLabel, { exact: true })).toBeVisible();
  await expect(page.locator('dl dt')).toHaveCount(2);
  await expect(page.locator('body')).not.toContainText(f.privateEmail);
  await expect(page.locator('body')).not.toContainText('LEAD_RECOVERY_PRIVATE');
  await page.goto(origin + '/shared-leads/' + f.revokedId);
  await expect(page.getByText('Selezione non disponibile', { exact: true })).toBeVisible();
  for (const id of [f.liveId, f.revokedId]) {
    // The existing lead detail returns its explicit inaccessible header (200).
    // Assert the denial and the complete response, not an invented HTTP contract.
    const denied = await page.request.get(origin + '/leads/' + id);
    expect(denied.status()).toBe(200);
    const html = await denied.text();
    expect(html).toContain('Lead non trovato');
    expect(html).not.toContain(f.liveLabel);
    expect(html).not.toContain(f.privateEmail);
    expect(html).not.toContain('LEAD_RECOVERY_PRIVATE');
    expect((await page.request.get(origin + '/leads/' + id + '/edit')).status()).toBe(404);
  }
  await page.goto(origin + '/leads/' + f.otherId);
  await expect(page.locator('body')).toContainText(f.otherLabel);
  await context.close();
});
