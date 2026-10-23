import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
test('schema65 restart retains technical work, exact documents, revoked assignments and indirect denials', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_TECHNICAL_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; clientId: string; projectId: string; practiceId: string; otherProjectId: string;
    liveEmail: string; revokedEmail: string; salesEmail: string; receiptId: string; title: string; progress: string;
    documents: { fileId: string; bytes: string }[]; excluded: string[];
  };
  expect(f.synthetic).toBe(true);
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  async function login(page: Page, email: string) {
    await page.goto(origin + '/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
    await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(origin + '/dashboard');
  }
  const live = await browser.newContext(), revoked = await browser.newContext(), sales = await browser.newContext();
  const page = await live.newPage(), denied = await revoked.newPage(), commercial = await sales.newPage();
  await login(page, f.liveEmail); await login(denied, f.revokedEmail); await login(commercial, f.salesEmail);
  const url = origin + '/technical-work/practices/' + f.practiceId;
  await page.goto(url); await expect(page.getByText(f.progress, { exact: true }).first()).toBeVisible();
  for (const value of f.excluded) expect(await page.content()).not.toContain(value);
  await expect(page.getByRole('heading', { name: 'Aggiorna il lavoro tecnico', exact: true })).toBeVisible();
  for (const [index, doc] of f.documents.entries()) {
    const path = url + '/documents/' + doc.fileId, response = await live.request.get(path);
    if (index < 2) {
      expect(response.status()).toBe(200); expect(await response.text()).toBe(doc.bytes);
      expect(response.headers()['content-disposition']).toMatch(/^inline;/);
      expect((await live.request.get(path + '?download=1')).status()).toBe(index === 1 ? 200 : 404);
    } else expect(response.status()).toBe(404);
    expect((await revoked.request.get(path)).status()).toBe(404);
    expect((await sales.request.get(path)).status()).toBe(404);
  }
  expect((await revoked.request.get(url)).status()).toBe(404);
  expect((await sales.request.get(url)).status()).toBe(404);
  for (const path of ['/clients/' + f.clientId, '/projects/' + f.otherProjectId]) {
    for (const context of [live, revoked]) {
      const response = await context.request.get(origin + path); expect(response.status()).toBeLessThan(500);
      const body = await response.text(); expect(body).not.toContain(f.title);
      for (const value of f.excluded) expect(body).not.toContain(value);
    }
  }
  await page.goto(origin + '/technical-work/projects/' + f.projectId);
  await expect(page.getByRole('heading', { name: 'Aggiorna il lavoro tecnico', exact: true })).toBeVisible();
  // The old exact command remains stored, but its lost-response recovery cannot
  // be inherited by a different session after the explicit restart revocation.
  await page.goto(url + '?workDecision=' + f.receiptId);
  await page.getByRole('button', { name: 'Verifica esito del salvataggio', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'La modifica non è stata registrata: dati, incarico o permessi non più validi.' })).toBeVisible();
  await expect(page.getByText('Ricarica il lavoro corrente', { exact: true })).toHaveCount(0);
  await live.close(); await revoked.close(); await sales.close();
});
