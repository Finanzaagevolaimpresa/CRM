import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

test('schema76 preserves shared history, canonical contacts and current perimeters across compatible return and resume', async ({ browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_SHARED_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; noProvider: boolean; updates: string[]; readNoticeId: string;
    adminEmail: string; techEmail: string; secondEmail: string; salesEmail: string; otherEmail: string; strangerEmail: string;
    clientId: string; projectId: string; practiceId: string; contractId: string; paymentId: string;
  };
  expect(f.synthetic && f.noProvider).toBe(true);
  const origin = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
  const recovery = process.env.R05_SELECTIVE_PHASE === 'restart';
  async function login(page: Page, email: string) {
    await page.goto(origin + '/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
    await page.getByRole('button', { name: 'Login interno', exact: true }).click();
    await expect(page).toHaveURL(origin + '/dashboard');
  }
  for (const email of [f.adminEmail, f.techEmail, f.secondEmail, f.salesEmail, f.otherEmail, f.strangerEmail]) {
    const context = await browser.newContext(), page = await context.newPage();
    await login(page, email);
    const endpoint = origin + '/api/operational-updates?kind=PRACTICE&id=' + f.practiceId;
    if ([f.otherEmail, f.strangerEmail].includes(email)) {
      const response = await context.request.get(endpoint);
      expect(response.status()).toBe(404); expect(await response.text()).not.toContain(f.practiceId);
      await context.close(); continue;
    }
    const response = await context.request.get(endpoint); expect(response.status()).toBe(200);
    const result = await response.json(); expect(result.panel.writesAvailable).toBe(!recovery);
    expect(result.panel.canWrite).toBe(!recovery && email !== f.salesEmail);
    expect(result.panel.history.map((row: { id: string }) => row.id).sort()).toEqual([...f.updates].sort());
    await page.goto(origin + '/operational-updates/practice/' + f.practiceId);
    const panel = page.getByTestId('shared-operational-panel');
    await expect(panel.getByText('SYNTHETIC_SHARED_ORIGINAL', { exact: true })).toBeVisible();
    await expect(panel.getByText('SYNTHETIC_SHARED_CORRECTION', { exact: true })).toBeVisible();
    await expect(panel).toContainText('SDI: SYN0001'); await expect(panel).toContainText('CAP: 00001');
    await expect(panel).not.toContainText('PRIVATE_');
    await expect(panel.getByRole('button', { name: 'Salva e notifica', exact: true })).toHaveCount(recovery || email === f.salesEmail ? 0 : 1);
    if (recovery) await expect(panel).toContainText('Salvataggi e chiusure dei tentativi sospesi');
    if (email === f.adminEmail || email === f.salesEmail) {
      for (const [kind, id] of [['CLIENT', f.clientId], ['PROJECT', f.projectId]]) {
        const linked = await context.request.get(origin + '/api/operational-updates?kind=' + kind + '&id=' + id);
        expect(linked.status()).toBe(200);
        expect((await linked.json()).panel.history.map((row: { id: string }) => row.id).sort()).toEqual([...f.updates].sort());
      }
    }
    if (email === f.salesEmail) {
      await page.goto(origin + '/notifications/updates/' + f.readNoticeId);
      await expect(page.getByText(/^Segnato come letto il /)).toBeVisible();
    }
    if ([f.techEmail, f.secondEmail].includes(email)) {
      for (const route of ['/payments/' + f.paymentId + '/collection', '/contracts/' + f.contractId]) {
        const denied = await context.request.get(origin + route); expect(denied.status()).toBe(404);
        expect(await denied.text()).not.toContain('PRIVATE_');
      }
    }
    await context.close();
  }
});
