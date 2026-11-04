import { readFileSync } from 'node:fs';
import { test, expect, type BrowserContext } from '@playwright/test';

test('the exact compatible recovery and resume retain technical privacy across profiles, broad overrides, files and metadata', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_TECHNICAL_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; practiceId: string; clientId: string; clientName: string; contractId: string; paymentId: string;
    liveEmail: string; supportEmail: string; mixedEmail: string; adminEmail: string; salesEmail: string;
    canonicalDocumentIds: string[]; documents: { fileId: string; bytes: string }[]; excluded: string[];
  };
  expect(f.synthetic).toBe(true);
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  const contexts: BrowserContext[] = [];
  async function login(email: string) {
    const context = await browser.newContext(); contexts.push(context);
    const page = await context.newPage();
    await page.goto(origin + '/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
    await page.getByRole('button', { name: 'Login interno', exact: true }).click();
    await expect(page).toHaveURL(origin + '/dashboard');
    return { page, context };
  }
  try {
    for (const email of [f.liveEmail, f.supportEmail, f.mixedEmail]) {
      const { page, context } = await login(email);
      const landing = await page.content();
      for (const value of f.excluded) expect(landing).not.toContain(value);
      for (const path of ['/payments', '/contracts', '/contracts/' + f.contractId,
        '/admin/records/Payment/' + f.paymentId,
        '/documents/' + f.canonicalDocumentIds[2] + '/versions']) {
        const response = await context.request.get(origin + path);
        expect(response.status(), path).toBe(404);
        const text = await response.text();
        for (const value of f.excluded) expect(text).not.toContain(value);
      }
      for (const action of ['view', 'download']) {
        const response = await context.request.get(origin + '/documents/' + f.canonicalDocumentIds[2]
          + '/' + action + '?versionId=' + f.documents[2].fileId);
        expect([403, 404], action).toContain(response.status());
        expect(await response.text()).toBe('Documento non disponibile');
        expect(response.headers()['content-disposition']).toBeUndefined();
        expect(response.headers()['cache-control']).toContain('no-store');
      }
      // These profiles have broad financial/file overrides but no selected
      // internal-content permission. The current guard must deny that surface
      // throughout candidate/recovery/resume without leaking reserved values.
      const communications = await page.goto(origin + '/communications');
      expect(communications?.status()).toBe(200);
      await expect(page).toHaveURL(origin + '/dashboard');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
      await expect(page.locator('main')).toContainText('Il tuo lavoro tecnico');
      const communicationBody = (await communications!.text()) + (await page.content());
      for (const value of [...f.excluded, f.documents[2].bytes]) expect(communicationBody).not.toContain(value);
      await expect(page.getByRole('button', { name: /invia|prepara risposta/i })).toHaveCount(0);
      // Selected operational notices remain a separate, guarded read surface.
      const updates = await page.goto(origin + '/notifications/updates');
      expect(updates?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Aggiornamenti selezionati');
      const updatesBody = (await updates!.text()) + (await page.content());
      for (const value of [...f.excluded, f.documents[2].bytes]) expect(updatesBody).not.toContain(value);
      if (email !== f.mixedEmail) {
        await page.goto(origin + '/technical-work/practices/' + f.practiceId);
        for (const value of f.excluded) expect(await page.content()).not.toContain(value);
        const allowed = await context.request.get(origin + '/technical-work/practices/' + f.practiceId + '/documents/' + f.documents[1].fileId + '?download=1');
        expect(allowed.status()).toBe(200); expect(await allowed.text()).toBe(f.documents[1].bytes);
      }
    }
    const admin = await login(f.adminEmail);
    const signed = await admin.context.request.get(origin + '/documents/' + f.canonicalDocumentIds[2] + '/view?versionId=' + f.documents[2].fileId);
    expect(signed.status()).toBe(200); expect(await signed.text()).toBe(f.documents[2].bytes);
    if (process.env.R05_SELECTIVE_PHASE === 'restart')
      expect((await admin.context.request.get(origin + '/admin/document-disclosure/' + f.documents[0].fileId)).status()).toBe(404);
    const sales = await login(f.salesEmail);
    const client = await sales.page.goto(origin + '/clients/' + f.clientId);
    expect(client?.status()).toBe(200);
    await expect(sales.page.getByRole('heading', { name: 'Fascicolo Cliente Interno — ' + f.clientName, exact: true })).toBeVisible();
    expect((await sales.context.request.get(origin + '/technical-work/practices/' + f.practiceId)).status()).toBe(404);
  } finally { for (const context of contexts) await context.close(); }
});
