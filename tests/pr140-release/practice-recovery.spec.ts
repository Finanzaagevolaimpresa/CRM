import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('schema63 restart preserves selected practice fields and revoked indirect-resource denials', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_PRACTICE_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; email: string; rows: { id: string; label: string; clientId: string; projectId: string; documents: { id: string; versionId: string; content: string; selected: boolean }[] }[];
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
  for (const [index, row] of f.rows.entries()) {
    for (const document of row.documents) {
      const url = origin + '/shared-practices/' + row.id + '/documents/' + document.versionId;
      const response = await context.request.get(url);
      if (index === 0 && document.selected) {
        expect(response.status()).toBe(200); expect(await response.text()).toBe(document.content);
        expect(response.headers()['content-disposition']).toMatch(/^inline;/);
        expect((await context.request.get(url + '?download=1')).status()).toBe(404);
        expect((await context.request.get(origin + '/shared-practices/' + f.rows[2].id + '/documents/' + document.versionId)).status()).toBe(404);
      } else expect(response.status()).toBe(404);
    }
  }
  await page.goto(origin + '/shared-practices/' + f.rows[3].id);
  await expect(page.getByText(f.rows[3].label, { exact: true })).toBeVisible();
  await expect(page.locator('dl dt')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Consulta versione' })).toHaveCount(0);
  await context.close();
});
