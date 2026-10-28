import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
test('schema70 restart preserves private upload bytes, pending and final reviews and current denials', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_UPLOAD_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; practiceId: string; adminEmail: string; liveEmail: string; revokedEmail: string;
    liveId: string; revokedId: string; salesEmails: string[];
    clientId: string; acquisition: { commandId: string; documentId: string; versionId: string; title: string; bytes: string };
    uploads: Array<{ commandId: string; reviewId: string | null; status: string; title: string; bytes: string; sha256: string; authorId: string }>;
  };
  expect(f.synthetic).toBe(true);
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!, own = origin + '/technical-uploads/practices/' + f.practiceId;
  const review = (recipient: string) => origin + '/technical-upload-review/practices/' + f.practiceId + '/' + recipient;
  async function login(page: Page, email: string) {
    await page.goto(origin + '/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
    await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(origin + '/dashboard');
  }
  const admin = await browser.newContext(), live = await browser.newContext(), revoked = await browser.newContext();
  const a = await admin.newPage(), t = await live.newPage(), r = await revoked.newPage();
  await login(a, f.adminEmail); await login(t, f.liveEmail); await login(r, f.revokedEmail);
  await a.goto(review(f.liveId)); await t.goto(own);
  for (const page of [a, t]) {
    await expect(page.getByText('Approvato · deposito privato', { exact: true })).toBeVisible();
    await expect(page.getByText('Rifiutato · storico conservato', { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain('RECOVERY_PRIVATE_UPLOAD_REVOKED');
  }
  await expect(a.locator('[data-upload-review-ready="true"]')).toHaveCount(1);
  async function exact(context: BrowserContext, url: string, row: typeof f.uploads[number]) {
    for (const suffix of ['', '?download=1']) {
      const response = await context.request.get(url + suffix); expect(response.status()).toBe(200);
      const bytes = await response.body(); expect(bytes.toString()).toBe(row.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
      expect(response.headers()['cache-control']).toContain('private, no-store');
      expect(response.headers()['content-security-policy']).toContain('sandbox');
      expect(response.headers()['content-disposition']).toMatch(suffix ? /^attachment;/ : /^inline;/);
    }
  }
  const allUrls: string[] = [own, review(f.liveId), review(f.revokedId)];
  const acquiredUrl = origin + '/acquired-documents/' + f.acquisition.documentId;
  allUrls.push(acquiredUrl, acquiredUrl + '?download=1', origin + '/clients/' + f.clientId + '/acquired-documents');
  for (const suffix of ['', '?download=1']) {
    const response = await admin.request.get(acquiredUrl + suffix); expect(response.status()).toBe(200);
    expect((await response.body()).toString()).toBe(f.acquisition.bytes);
    expect(response.headers()['cache-control']).toContain('private, no-store');
    expect(response.headers()['content-disposition']).toMatch(suffix ? /^attachment;/ : /^inline;/);
    for (const context of [live, revoked]) expect((await context.request.get(acquiredUrl + suffix)).status()).toBe(404);
  }
  const dossier = await admin.newPage(); await dossier.goto(origin + '/clients/' + f.clientId + '/acquired-documents');
  await expect(dossier.getByRole('heading', { name: f.acquisition.title, exact: true })).toBeVisible();
  for (const row of f.uploads) {
    const ownFile = own + '/files/' + row.commandId, adminFile = review(row.authorId) + '/files/' + row.commandId;
    allUrls.push(ownFile, ownFile + '?download=1', adminFile, adminFile + '?download=1');
    if (row.status !== 'REVOKED') {
      await expect(t.getByRole('heading', { name: row.title, exact: true })).toBeVisible();
      await exact(live, ownFile, row); await exact(admin, adminFile, row);
    } else {
      expect((await live.request.get(ownFile)).status()).toBe(404);
      expect((await admin.request.get(adminFile)).status()).toBe(404);
    }
    expect((await revoked.request.get(ownFile)).status()).toBe(404);
    expect((await live.request.get(adminFile)).status()).toBe(404);
    expect((await admin.request.get(ownFile)).status()).toBe(404);
  }
  expect((await revoked.request.get(own)).status()).toBe(404);
  expect((await admin.request.get(review(f.revokedId))).status()).toBe(404);
  for (const email of f.salesEmails) {
    const sales = await browser.newContext(), page = await sales.newPage(); await login(page, email);
    for (const url of allUrls) expect((await sales.request.get(url)).status()).toBe(404);
    await sales.close();
  }
  // Registry restart deliberately revokes the old session. A new login cannot
  // inherit a receipt even though the original exact command is preserved.
  await t.goto(own + '?uploadDecision=' + f.uploads[0].commandId);
  await t.getByRole('button', { name: 'Verifica ricevuta', exact: true }).click();
  await expect(t.getByRole('link', { name: 'Ricarica il deposito corrente', exact: true })).toHaveCount(0);
  await expect(t.getByRole('status').filter({ hasText: 'Esito non confermato. Verifica la ricevuta senza ripetere l’operazione.' })).toBeVisible();
  await admin.close(); await live.close(); await revoked.close();
});
