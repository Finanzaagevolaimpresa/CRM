import { expect, test, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';
import { signSessionCookie } from '../../src/lib/session';
const db = new PrismaClient();
const app = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
async function login(page: Page, email: string) {
  await page.goto(app + '/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(app + '/dashboard');
}
test.beforeAll(async () => { expect(new URL(app).hostname).toBe('127.0.0.1'); await assertSyntheticCatalogDatabase(db); });
test.afterAll(() => db.$disconnect());
test('recovery image retains versioned history and current access denials', async ({ page, browser }) => {
  await login(page, 'readiness-owner@invalid.test');
  const dossier = await db.clientDossier.findFirstOrThrow({ where: { clientId: 'readiness-browser-client-standard', practiceReadinessId: { not: null } } });
  const version = await db.engagementDossierVersion.findUniqueOrThrow({ where: { id: dossier.currentVersionId! } });
  const materialId = (version.materialSnapshot as Array<{ documentId: string | null }>).find((r) => r.documentId)?.documentId;
  expect(materialId).toBeTruthy();
  const material = await db.document.findUniqueOrThrow({ where: { id: materialId! } });
  const override = await db.userPermissionOverride.findFirstOrThrow({ where: { userId: 'readiness-browser-owner', permission: 'document.sensitive.read' } });
  const practice = await db.technicalPractice.findFirstOrThrow({ where: { clientId: dossier.clientId } });
  const target = app + '/client-dossiers/' + dossier.id;
  async function visible(allowed: boolean) {
    const detail = await page.request.get(target);
    const html = await detail.text();
    if (allowed) expect(html).toContain(version.title);
    else { expect(html).toContain('Bozza dossier non trovata'); expect(html).not.toContain(version.title); }
    const search = await page.request.get(app + '/search?q=' + encodeURIComponent(version.title));
    const searchHtml = await search.text();
    if (allowed) expect(searchHtml).toContain('/client-dossiers/' + dossier.id);
    else { expect(searchHtml).not.toContain(dossier.id); expect(searchHtml).not.toContain(version.content); }
    for (const path of ['/clients/' + dossier.clientId + '/operational-report', '/technical-office/practices/' + practice.id + '/operational-report']) {
      const report = await page.request.get(app + path);
      expect(report.status()).toBe(200);
      if (allowed) expect(await report.text()).toContain(version.title);
      else expect(await report.text()).not.toContain(version.title);
    }
    if (!allowed) for (const suffix of ['', '/docx'])
      expect((await page.request.get(target + '/export' + suffix + '?versionId=' + dossier.approvedVersionId)).status()).toBe(404);
  }
  await visible(true);
  await db.document.update({ where: { id: material.id }, data: { containsSensitiveData: true } });
  try {
    await visible(false);
    await db.userPermissionOverride.update({ where: { id: override.id }, data: { allowed: true } });
    await visible(true);
    await db.userPermissionOverride.update({ where: { id: override.id }, data: { allowed: false } });
    await visible(false);
  } finally {
    await db.document.update({ where: { id: material.id }, data: { containsSensitiveData: material.containsSensitiveData } });
    await db.userPermissionOverride.update({ where: { id: override.id }, data: { allowed: override.allowed } });
  }
  await visible(true);
  const legacy = await db.clientDossier.findFirstOrThrow({ where: { clientId: dossier.clientId, practiceReadinessId: null } });
  const reviewer = await browser.newContext();
  const reviewerPage = await reviewer.newPage();
  await login(reviewerPage, 'readiness-reader@invalid.test');
  for (const [actorPage, button] of [[page, 'Salva modifiche'], [reviewerPage, 'Conferma revisione dossier']] as const) {
    await actorPage.goto(app + '/client-dossiers/' + legacy.id);
    const form = actorPage.locator('form').filter({ has: actorPage.getByRole('button', { name: button, exact: true }) });
    const before = await db.clientDossier.findUniqueOrThrow({ where: { id: dossier.id } });
    const responsePending = actorPage.waitForResponse(r => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']));
    await form.getByRole('button', { name: button, exact: true }).click();
    const response = await responsePending;
    await response.finished();
    expect(response.status()).toBe(200);
    const request = response.request();
    expect(request.postData()).toContain(legacy.id);
    const forged = request.postData()!.replaceAll(legacy.id, dossier.id);
    const denied = await actorPage.request.fetch(request.url(), {
      method: 'POST', headers: { 'next-action': request.headers()['next-action'], 'content-type': request.headers()['content-type'], origin: app, referer: request.url() },
      data: forged, maxRedirects: 0,
    });
    expect([200, 500]).toContain(denied.status());
    expect(await denied.text()).toMatch(/"digest":/);
    expect(await db.clientDossier.findUniqueOrThrow({ where: { id: dossier.id } })).toEqual(before);
  }
  await reviewer.close();
  const old = await browser.newContext();
  await old.addCookies([{ name: process.env.AUTH_COOKIE_NAME!, url: app, value: await signSessionCookie({ userId: 'readiness-browser-owner', expiresAt: Math.floor(Date.now() / 1000) + 3600 }) }]);
  const denied = await old.request.get(target, { maxRedirects: 0 });
  expect([303, 307]).toContain(denied.status());
  expect(new URL(denied.headers().location, app).pathname).toBe('/login');
  await old.close();
});
