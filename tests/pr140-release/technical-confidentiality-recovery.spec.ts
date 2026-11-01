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
        '/admin/records/Payment/' + f.paymentId, '/communications',
        '/documents/' + f.canonicalDocumentIds[2] + '/versions',
        '/documents/' + f.canonicalDocumentIds[2] + '/view?versionId=' + f.documents[2].fileId,
        '/documents/' + f.canonicalDocumentIds[2] + '/download?versionId=' + f.documents[2].fileId]) {
        const response = await context.request.get(origin + path);
        expect(response.status(), path).toBe(404);
        const text = await response.text();
        for (const value of f.excluded) expect(text).not.toContain(value);
      }
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
    await expect(sales.page.getByRole('heading', { name: f.clientName, exact: true })).toBeVisible();
    expect((await sales.context.request.get(origin + '/technical-work/practices/' + f.practiceId)).status()).toBe(404);
  } finally { for (const context of contexts) await context.close(); }
});
