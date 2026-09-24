import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';
import { getHandoffReceipt } from '../../src/lib/purchased-service-handoff';
import { readResponsibility } from '../../src/lib/responsibility';
import { readCommercialOrigin } from '../../src/lib/commercial-origin';

const db = new PrismaClient(), app = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
async function login(page: Page, email: string) {
  await page.goto(app + '/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(app + '/dashboard');
}
test.beforeAll(async () => { expect(new URL(app).hostname).toBe('127.0.0.1'); await assertSyntheticCatalogDatabase(db); });
test.afterAll(() => db.$disconnect());

test('packaged image enforces live client perimeters on an existing reviewer session', async ({ page }) => {
  await login(page, 'readiness-reader@invalid.test');
  const client = await db.client.findUniqueOrThrow({ where: { id: 'readiness-browser-client-standard' } });
  const grant = await db.clientReadGrant.findUniqueOrThrow({ where: { userId_clientId: { userId: 'readiness-browser-reader', clientId: client.id } } });
  expect(grant.active).toBe(true);
  async function access(allowed: boolean) {
    const detail = await page.request.get(app + '/clients/' + client.id);
    if (allowed) expect(await detail.text()).toContain(client.displayName);
    else expect(await detail.text()).not.toContain(client.displayName);
    const search = await page.request.get(app + '/search?q=' + encodeURIComponent(client.displayName));
    if (allowed) expect(await search.text()).toContain('/clients/' + client.id);
    else expect(await search.text()).not.toContain('/clients/' + client.id);
    const report = await page.request.get(app + '/clients/' + client.id + '/operational-report');
    expect(report.status()).toBe(allowed ? 200 : 403);
  }
  await access(true);
  try {
    await db.clientReadGrant.update({ where: { id: grant.id }, data: { active: false, version: { increment: 1 } } });
    await access(false);
  } finally {
    // Synthetic-only perturbation is restored byte-for-byte before comparing footprints.
    await db.clientReadGrant.update({ where: { id: grant.id }, data: { active: grant.active, version: grant.version, updatedAt: grant.updatedAt } });
  }
  await access(true);
});

test('packaged image reopens M1 handoff, acceptance and private materials with current access checks', async ({ page, browser }) => {
  const f = JSON.parse(readFileSync(process.env.R05_M1_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; clientId: string; serviceId: string; practiceId: string; handoffId: string; acceptanceId: string; originId: string;
    tech: { id: string; email: string }; otherEmail: string; otherId: string; adminEmail: string;
    materialId: string; materialHash: string; sensitiveId: string;
  };
  expect(f.synthetic).toBe(true);
  expect((await getHandoffReceipt(db, f.serviceId))?.id).toBe(f.handoffId);
  expect((await readCommercialOrigin(db, f.clientId))?.id).toBe(f.originId);
  const responsibility = await readResponsibility(db, 'TechnicalPractice', f.practiceId);
  expect(responsibility.valid).toBe(true);
  expect(responsibility.accepted.map(row => row.id)).toContain(f.acceptanceId);
  // The packaged return must also reject the legacy assignment entry point.
  const adminContext = await browser.newContext(), admin = await adminContext.newPage();
  await login(admin, f.adminEmail);
  const originalPractice = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practiceId } });
  const originalService = await db.clientService.findUniqueOrThrow({ where: { id: f.serviceId } });
  const originalAudit = await db.auditLog.findMany({ where: { entityId: f.practiceId }, orderBy: { id: 'asc' } });
  await admin.goto(app + '/technical-office/practices/' + f.practiceId);
  const legacyForm = admin.locator('form').filter({ has: admin.getByRole('button', { name: 'Assegna', exact: true }) });
  await legacyForm.locator('select[name="technicalOwnerId"]').selectOption(f.otherId);
  await legacyForm.getByRole('button', { name: 'Assegna', exact: true }).click();
  await expect(admin).toHaveURL(/\/settings\/security/);
  expect(await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practiceId } })).toEqual(originalPractice);
  expect(await db.clientService.findUniqueOrThrow({ where: { id: f.serviceId } })).toEqual(originalService);
  expect(await db.auditLog.findMany({ where: { entityId: f.practiceId }, orderBy: { id: 'asc' } })).toEqual(originalAudit);
  await adminContext.close();
  await login(page, f.tech.email);
  const path = app + '/services/' + f.serviceId + '/handoff';
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Passaggio del servizio acquistato', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Responsabilità e presa in carico', exact: true }).click();
  await expect(page.getByText(/Presa in carico tecnico: registrata il/)).toBeVisible();
  const material = await page.request.get(app + '/documents/' + f.materialId + '/download');
  expect(material.status()).toBe(200);
  expect(createHash('sha256').update(await material.body()).digest('hex')).toBe(f.materialHash);
  expect((await page.request.get(app + '/documents/' + f.sensitiveId + '/download')).status()).toBe(403);
  const other = await browser.newContext(), otherPage = await other.newPage();
  await login(otherPage, f.otherEmail);
  await otherPage.goto(path);
  await expect(otherPage.getByRole('heading', { name: 'Passaggio del servizio acquistato', exact: true })).toHaveCount(0);
  expect((await otherPage.request.get(app + '/documents/' + f.materialId + '/download')).status()).toBe(403);
  await other.close();
  const tech = await db.user.findUniqueOrThrow({ where: { id: f.tech.id } });
  try {
    await db.user.update({ where: { id: tech.id }, data: { active: false } });
    const denied = await page.request.get(path, { maxRedirects: 0 });
    expect([303, 307]).toContain(denied.status());
    expect(new URL(denied.headers().location, app).pathname).toBe('/login');
  } finally {
    await db.user.update({ where: { id: tech.id }, data: { active: tech.active, updatedAt: tech.updatedAt } });
  }
});
