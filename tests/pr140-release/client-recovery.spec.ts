import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('schema60 restart preserves exact document bytes, V1 fields and selected/revoked denials', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_CLIENT_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; email: string; rows: { id: string; label: string; companyId: string; projectId: string; leadId: string;
      documents: { id: string; versionId: string; content: string; selected: boolean }[] }[];
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
  await page.goto(origin + '/shared-clients/' + f.rows[0].id);
  await expect(page.getByText(f.rows[0].label, { exact: true })).toBeVisible();
  await expect(page.locator('dl dt')).toHaveCount(2);
  expect(await page.content()).not.toContain('CLIENT_RECOVERY_PRIVATE_');
  for (const row of f.rows.slice(0, 2)) for (const document of row.documents) {
    const url = origin + '/shared-clients/' + row.id + '/documents/' + document.versionId;
    const response = await page.request.get(url);
    if (row === f.rows[0] && document.selected) {
      expect(response.status()).toBe(200);
      expect(await response.text()).toBe(document.content);
      expect(response.headers()['cache-control']).toContain('no-store');
      expect(response.headers()['content-disposition']).toMatch(/^inline;/);
    } else expect(response.status()).toBe(404);
    expect((await page.request.get(url + '?download=1')).status()).toBe(404);
    expect((await page.request.get(origin + '/documents/' + document.id + '/download')).status()).toBe(403);
  }
  await page.goto(origin + '/shared-clients/' + f.rows[1].id);
  await expect(page.getByText('Selezione non disponibile', { exact: true })).toBeVisible();
  for (const row of f.rows.slice(0, 3)) {
    const denied = await page.request.get(origin + '/clients/' + row.id);
    expect(denied.status()).toBe(200);
    const html = await denied.text();
    expect(html).toContain('Cliente non trovato o non accessibile');
    expect(html).not.toContain(row.label);
    expect(html).not.toContain('CLIENT_RECOVERY_PRIVATE_');
    expect((await page.request.get(origin + '/clients/' + row.id + '/edit')).status()).toBe(404);
    for (const route of ['/companies/' + row.companyId, '/projects/' + row.projectId, '/leads/' + row.leadId]) {
      const response = await page.request.get(origin + route);
      expect(response.status()).toBeLessThan(500);
      const body = await response.text();
      for (const prefix of ['SELECTIVE_CLIENT_RECOVERY_', 'CLIENT_RECOVERY_PRIVATE_', 'CLIENT_RECOVERY_COMPANY_',
        'CLIENT_RECOVERY_PROJECT_', 'CLIENT_RECOVERY_LEAD_']) expect(body).not.toContain(prefix);
    }
  }
  await page.goto(origin + '/shared-clients/' + f.rows[2].id);
  await expect(page.getByText(f.rows[2].label, { exact: true })).toBeVisible();
  await expect(page.locator('dl dt')).toHaveCount(2);
  await page.goto(origin + '/clients/' + f.rows[3].id);
  await expect(page.locator('body')).toContainText(f.rows[3].label);
  await context.close();
});
