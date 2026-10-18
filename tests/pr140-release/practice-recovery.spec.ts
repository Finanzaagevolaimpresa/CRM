import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('schema58 restart preserves selected practice fields and revoked indirect-resource denials', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_PRACTICE_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; email: string; rows: { id: string; label: string; clientId: string; projectId: string }[];
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
  await page.goto(origin + '/shared-practices/' + f.rows[0].id);
  await expect(page.getByText(f.rows[0].label, { exact: true })).toBeVisible();
  await expect(page.locator('dl dt')).toHaveCount(2);
  expect(await page.content()).not.toContain('PRACTICE_RECOVERY_PRIVATE_');
  await page.goto(origin + '/shared-practices/' + f.rows[1].id);
  await expect(page.getByText('Selezione non disponibile', { exact: true })).toBeVisible();
  for (const row of f.rows.slice(0, 2)) {
    const denied = await page.request.get(origin + '/technical-office/practices/' + row.id);
    expect(denied.status()).toBe(200);
    const html = await denied.text();
    expect(html).toContain('Pratica non accessibile');
    expect(html).not.toContain(row.label);
    expect(html).not.toContain('PRACTICE_RECOVERY_PRIVATE_');
    expect((await page.request.get(origin + '/technical-office/practices/' + row.id + '/edit')).status()).toBe(404);
    for (const route of ['/clients/' + row.clientId, '/projects/' + row.projectId]) {
      const response = await page.request.get(origin + route);
      expect(response.status()).toBeLessThan(500);
      const body = await response.text();
      expect(body).not.toContain(row.label);
      expect(body).not.toContain('PRACTICE_RECOVERY_PRIVATE_');
    }
  }
  await page.goto(origin + '/technical-office/practices/' + f.rows[2].id);
  await expect(page.locator('body')).toContainText(f.rows[2].label);
  await context.close();
});
