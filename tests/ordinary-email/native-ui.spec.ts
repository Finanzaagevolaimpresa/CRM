import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeEmailFixture } from './ui-fixture';
import { tokenDigestFromCookie } from '../../src/lib/internal-session-registry';

const db = new PrismaClient(), origin = 'http://127.0.0.1:3036';
const evidence = process.env.ORDINARY_EMAIL_BROWSER_EVIDENCE!;
test.afterAll(async () => db.$disconnect());
async function login(page: Page, email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(process.env.ORDINARY_EMAIL_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function stepUp(page: Page) {
  await page.goto('/settings/security');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Password corrente').fill(process.env.ORDINARY_EMAIL_BROWSER_PASSWORD!);
  const submitted = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/settings/security');
  await page.getByRole('button', { name: /Conferma per (5|30) minuti/ }).click();
  expect((await submitted).status()).toBeLessThan(400);
  await expect(page).toHaveURL(/status=active/);
  await expect(page.getByText('Conferma privilegiata attiva e vincolata alla sessione corrente.', { exact: true })).toBeVisible();
}

test('native preview and refusal bind the exact version, personal authority, current session and uncertain response', async ({ browser }) => {
  const f = await nativeEmailFixture(db), target = `/communications?kind=TECHNICAL&practice=${f.practice.id}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), otherContext = await browser.newContext(), secondContext = await browser.newContext();
  let externalRequests = 0;
  for (const c of [context, otherContext, secondContext]) await c.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { externalRequests++; return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(), other = await otherContext.newPage(), second = await secondContext.newPage();
  await login(page, f.user.email); await login(other, f.other.email); await login(second, f.user.email);
  const panel = page.getByRole('region', { name: 'Decisione personale email', exact: true });
  const exact = page.getByRole('region', { name: 'Anteprima della versione esatta', exact: true });
  await page.goto(target); await expect(panel).toBeVisible();
  let previewRequest: { body: string; headers: Record<string, string> } | undefined;
  page.on('request', request => {
    if (request.method() === 'POST' && request.headers()['next-action'] && !previewRequest) previewRequest = {
      body: request.postData()!, headers: { 'next-action': request.headers()['next-action'], 'content-type': request.headers()['content-type'], origin } };
  });
  await panel.getByRole('button', { name: 'Anteprima email ordinaria' }).click();
  await expect(exact).toContainText(f.input.body); await expect(exact).toContainText('riservato@invalid.test');
  await expect(exact).toContainText(f.version.id); await expect(exact).toContainText(f.doc.checksum!);
  await expect(exact.getByRole('button', { name: 'Rifiuta versione 1' })).toBeDisabled();
  await expect(exact.getByRole('link', { name: 'Conferma la tua identità' })).toBeVisible();
  await expect(panel).toContainText('Invio ordinario non disponibile per questa configurazione');
  expect(await panel.getByRole('button', { name: 'Approva e invia' }).count()).toBe(0);
  await other.goto(target); await expect(other.getByRole('region', { name: 'Decisione personale email', exact: true })).toHaveCount(0);
  expect(previewRequest).toBeTruthy();
  const deniedPreview = await other.request.post(target, { headers: previewRequest!.headers, data: previewRequest!.body });
  const deniedBody = await deniedPreview.text(); expect(deniedBody).toContain('UNAVAILABLE'); expect(deniedBody).not.toContain('oe1.');
  const wrongOrigin = await page.request.post(target, { headers: { ...previewRequest!.headers, origin: 'https://untrusted.invalid' }, data: previewRequest!.body });
  expect(await wrongOrigin.text()).not.toContain('oe1.');

  await stepUp(page); await page.goto(target); await panel.getByRole('button', { name: 'Anteprima email ordinaria' }).click();
  await exact.getByLabel('Rifiuto personalmente questa versione esatta.').check();
  await expect(exact.getByRole('button', { name: 'Rifiuta versione 1' })).toBeEnabled();
  await page.screenshot({ path: path.join(evidence, 'native-preview-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await exact.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, 'native-preview-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const editor = page.locator(`form[data-message-draft="${f.saved.id}"]`);
  await editor.locator('..').locator(':scope > summary').click();
  await editor.getByLabel('Testo esatto').fill('VERSIONE MODIFICATA LOCALMENTE');
  await expect(exact).toHaveCount(0); await expect(panel.getByRole('button', { name: 'Anteprima email ordinaria' })).toBeDisabled();
  await expect(panel).toContainText('Modifiche non salvate');
  await editor.getByRole('button', { name: 'Salva nuova versione da approvare' }).click();
  await expect.poll(async () => (await db.approvedCommunication.findUniqueOrThrow({ where: { id: f.saved.id } })).currentRevision).toBe(2);
  await expect(panel).toContainText('versione salvata 2');
  await panel.getByRole('button', { name: 'Anteprima email ordinaria' }).click(); await expect(exact).toContainText('VERSIONE MODIFICATA LOCALMENTE');

  // A second actual browser session saves a new version after the preview.
  await second.goto(target);
  const otherEditor = second.locator(`form[data-message-draft="${f.saved.id}"]`);
  await otherEditor.locator('..').locator(':scope > summary').click(); await otherEditor.getByLabel('Testo esatto').fill('VERSIONE SALVATA DALLA SECONDA SESSIONE');
  await otherEditor.getByRole('button', { name: 'Salva nuova versione da approvare' }).click();
  await expect.poll(async () => (await db.approvedCommunication.findUniqueOrThrow({ where: { id: f.saved.id } })).currentRevision).toBe(3);
  await exact.getByLabel('Rifiuto personalmente questa versione esatta.').check();
  await exact.getByRole('button', { name: 'Rifiuta versione 2' }).click(); await expect(panel).toContainText('Esito da verificare');
  expect(await db.communicationEvent.count({ where: { messageId: f.saved.id, event: 'ORDINARY_REJECTED' } })).toBe(0);
  await panel.getByRole('button', { name: 'Aggiorna comunicazione' }).click();
  await expect(panel).toContainText('versione salvata 3');
  await page.locator('[data-ordinary-ready="true"]').waitFor({ state: 'attached' });
  await panel.getByRole('button', { name: 'Anteprima email ordinaria' }).click();
  try { await expect(exact).toContainText('VERSIONE SALVATA DALLA SECONDA SESSIONE'); }
  catch (error) { console.log('SYNTHETIC_PANEL_AFTER_RELOAD', await panel.innerText()); throw error; }

  let refusalRequest: { body: string; headers: Record<string, string> } | undefined, refusalPosts = 0;
  await page.route('**/communications?**', async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.postData()?.includes('RIFIUTO_QUESTA_VERSIONE')) {
      refusalPosts++; refusalRequest = { body: request.postData()!, headers: {
        'next-action': request.headers()['next-action'], 'content-type': request.headers()['content-type'], origin } };
      await route.fetch(); await route.abort('failed'); // Commit happened, response deliberately lost.
    } else await route.fallback();
  });
  await exact.getByLabel('Rifiuto personalmente questa versione esatta.').check(); await exact.getByRole('button', { name: 'Rifiuta versione 3' }).click();
  await expect.poll(async () => (await db.approvedCommunication.findUniqueOrThrow({ where: { id: f.saved.id } })).currentRevision).toBe(4);
  await expect(panel).toContainText('Risposta non ricevuta'); await expect(panel.getByRole('button', { name: 'Anteprima email ordinaria' })).toBeDisabled();
  expect(refusalPosts).toBe(1); expect(refusalRequest).toBeTruthy();
  await page.unroute('**/communications?**');
  const replay = await page.request.post(target, { headers: refusalRequest!.headers, data: refusalRequest!.body });
  expect(await replay.text()).toContain('CHECK_CURRENT');
  expect(await db.communicationEvent.count({ where: { messageId: f.saved.id, event: 'ORDINARY_REJECTED' } })).toBe(1);
  const versions = await db.communicationVersion.findMany({ where: { messageId: f.saved.id }, orderBy: { revision: 'asc' } });
  expect(versions.map(version => version.revision)).toEqual([1, 2, 3, 4]);
  expect(versions[2].snapshot).toMatchObject({ body: 'VERSIONE SALVATA DALLA SECONDA SESSIONE' });
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: f.saved.id, event: 'ordinary_email_rejected' } });
  expect(audit.after).toMatchObject({ rejectedVersion: 3, newVersion: 4 });
  await page.reload(); await expect(panel).toContainText('versione salvata 4');
  await page.getByText('Timeline e versioni', { exact: true }).click(); await expect(page.getByText('Versione rifiutata · nuova bozza da approvare', { exact: false })).toBeVisible();
  await page.screenshot({ path: path.join(evidence, 'native-refusal-recorded.png'), fullPage: true });

  const cookie = (await context.cookies()).find(cookie => cookie.name === process.env.AUTH_COOKIE_NAME)!;
  const digest = await tokenDigestFromCookie(cookie.value); expect(digest).toBeTruthy();
  await db.internalSession.updateMany({ where: { tokenDigest: Buffer.from(digest!) }, data: { revokedAt: new Date() } });
  await panel.getByRole('button', { name: 'Anteprima email ordinaria' }).click(); await expect(page).toHaveURL(/\/login$/);
  await second.goto(target); await expect(second.getByRole('region', { name: 'Decisione personale email', exact: true })).toBeVisible();
  await db.project.update({ where: { id: f.project.id }, data: { status: 'archiviato' } });
  await second.getByRole('button', { name: 'Anteprima email ordinaria' }).click();
  await expect(second.getByRole('region', { name: 'Decisione personale email', exact: true })).toContainText('Versione o accesso non più disponibili');
  expect((await second.goto(target))?.status()).toBe(404);
  expect(await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::integer AS count FROM "OrdinaryEmailAttempt" WHERE "messageId"=${f.saved.id}::uuid`).toEqual([{ count: 0 }]);
  expect(externalRequests).toBe(0);
  const proof = { synthetic: true, nativeNextActions: true, nativeLoginAndStepUp: true, samePersonTwoSessions: true, otherAdminDenied: true,
    wrongOriginDenied: true, exactPreview: true, localEditInvalidates: true, concurrentEditDenied: true, committedResponseLost: true,
    refusalPosts, replayDenied: true, refusalAudit: { rejectedVersion: 3, newVersion: 4 }, sessionRevoked: true,
    projectArchived: true, ordinaryAttempts: 0, externalRequests, sendActionRegistered: true, sendAvailable: false, screenshotsInspected: false };
  await writeFile(path.join(evidence, 'native-ui-proof.json'), JSON.stringify(proof, null, 2));
  console.log('ORDINARY_NATIVE_UI_PROOF ' + JSON.stringify(proof));
  await context.close(); await otherContext.close(); await secondContext.close();
});
