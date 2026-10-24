import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
test('schema68 restart preserves internal requests, exact unapproved drafts and current origin denial', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_ADMIN_REQUEST_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; ownerEmail: string; salesEmail: string; otherEmail: string; requests: Record<string, { id: string; leadId: string }> };
  expect(f.synthetic).toBe(true); const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  async function login(page: Page, email: string) {
    await page.goto(origin + '/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
    await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(origin + '/dashboard');
  }
  const sales = await browser.newContext(), other = await browser.newContext(), admin = await browser.newContext();
  const p = await sales.newPage(), q = await other.newPage(), a = await admin.newPage();
  await login(p, f.salesEmail); await login(q, f.otherEmail); await login(a, f.ownerEmail);
  await p.goto(origin + '/admin-requests/' + f.requests.OPEN.id);
  await expect(p.getByRole('button', { name: 'Salva integrazione interna', exact: true })).toBeVisible();
  await p.goto(origin + '/admin-requests/' + f.requests.DRAFT.id);
  await expect(p.getByText('Bozza preparata, invio da decidere', { exact: true })).toBeVisible();
  expect(await p.content()).not.toContain('synthetic-recipient@invalid.test');
  await p.goto(origin + '/admin-requests/' + f.requests.REJECTED.id);
  await expect(p.getByText('Richiesta rifiutata in prova isolata.', { exact: true })).toBeVisible();
  await a.goto(origin + '/admin-requests/' + f.requests.DRAFT.id);
  await a.getByRole('link', { name: 'Apri bozza email collegata', exact: true }).click();
  await expect(a.getByText('Testo composto e verificato personalmente per la prova isolata.', { exact: true }).first()).toBeVisible();
  for (const context of [sales, other, admin]) {
    expect((await context.request.get(origin + '/admin-requests/' + f.requests.REVOKED_DRAFT.id)).status()).toBe(404);
  }
  expect((await other.request.get(origin + '/admin-requests/' + f.requests.OPEN.id)).status()).toBe(404);
  await sales.close(); await other.close(); await admin.close();
});
