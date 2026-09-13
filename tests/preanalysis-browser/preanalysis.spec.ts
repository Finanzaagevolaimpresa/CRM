import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

const app = 'http://127.0.0.1:3000';
const password = process.env.PREANALYSIS_BROWSER_PASSWORD!;
const evidence = process.env.PREANALYSIS_BROWSER_EVIDENCE_DIR!;
const db = new PrismaClient();
const fields = { internalSummary: 'Sintesi inventata', scenarioA: 'Scenario A inventato', scenarioB: 'Scenario B inventato', blockingConditions: 'Condizione inventata', requiredDocuments: 'Documento inventato' };

async function login(page: import('@playwright/test').Page, email: string) {
  await page.goto(`${app}/login`);
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached', timeout: 15_000 });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(`${app}/dashboard`);
}

test.afterEach(({}, testInfo) => {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'preanalysis-browser-status.json'), `${JSON.stringify({ phase: 'BROWSER', status: testInfo.status === testInfo.expectedStatus ? 'PASS' : 'FAIL', synthetic: true })}\n`, { mode: 0o600 });
});
test.afterAll(() => db.$disconnect());
test('real manual pre-analysis path, conflict retention and access denials', async ({ browser }) => {
  mkdirSync(evidence, { recursive: true });
  const owner = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await owner.newPage();
  await login(page, 'preanalysis-owner@invalid.test');
  await page.goto(`${app}/projects/preanalysis-browser-project`);
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await expect(page.getByText('Sintesi inventata')).toHaveCount(0);
  await page.getByRole('link', { name: 'Crea pre-analisi' }).click();
  for (const [name, value] of Object.entries(fields)) await page.locator(`textarea[name="${name}"]`).fill(value);
  await page.getByRole('button', { name: 'Crea bozza interna' }).click();
  await expect(page).toHaveURL(/\/preanalyses\/[^?]+\?saved=created$/u);
  const recordId = new URL(page.url()).pathname.split('/').at(-1)!;
  for (const [name, value] of Object.entries(fields)) await expect(page.locator(`textarea[name="${name}"]`)).toHaveValue(value);
  await page.screenshot({ path: join(evidence, 'preanalysis-desktop.png'), fullPage: true });
  const originalVersion = await page.locator('input[name="version"]').inputValue();
  await page.locator('textarea[name="scenarioB"]').evaluate((element) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(element, 'X'.repeat(5001));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Salva modifiche' }).click();
  await expect(page.getByRole('status')).toContainText('Controlla i campi');
  await expect(page.locator('textarea[name="internalSummary"]')).toHaveValue(fields.internalSummary);
  await expect(page.locator('textarea[name="scenarioB"]')).toHaveValue('X'.repeat(5001));
  await expect(page.locator('input[name="version"]')).toHaveValue(originalVersion);
  await page.locator('textarea[name="scenarioB"]').fill(fields.scenarioB);
  await page.reload();
  await page.locator('textarea[name="scenarioA"]').fill('Scenario A seconda modifica');
  await page.getByRole('button', { name: 'Salva modifiche' }).click();
  await expect(page.getByRole('status')).toContainText('Bozza interna salvata');
  await page.reload();
  await expect(page.locator('textarea[name="scenarioA"]')).toHaveValue('Scenario A seconda modifica');

  await page.goto(`${app}/preanalyses/new?clientId=preanalysis-browser-client&projectId=preanalysis-browser-project`);
  await page.locator('textarea[name="internalSummary"]').fill('Richiesta alterata');
  await page.locator('input[name="clientId"]').evaluate((element) => { (element as HTMLInputElement).value = 'preanalysis-browser-foreign-client'; });
  const countBeforeTamper = await db.preAnalysis.count({ where: { clientId: 'preanalysis-browser-client' } });
  const auditBeforeTamper = await db.auditLog.count({ where: { actorId: 'preanalysis-browser-owner', event: 'preanalysis_create' } });
  await page.getByRole('button', { name: 'Crea bozza interna' }).click();
  await expect(page.getByRole('status')).toContainText('non disponibile');
  expect(await db.preAnalysis.count({ where: { clientId: 'preanalysis-browser-client' } })).toBe(countBeforeTamper);
  expect(await db.auditLog.count({ where: { actorId: 'preanalysis-browser-owner', event: 'preanalysis_create' } })).toBe(auditBeforeTamper);

  const secondTab = await owner.newPage();
  await secondTab.goto(`${app}/preanalyses/${recordId}`);
  await page.goto(`${app}/preanalyses/${recordId}`);
  await page.locator('textarea[name="scenarioB"]').fill('Vincitore concorrente');
  await page.getByRole('button', { name: 'Salva modifiche' }).click();
  await expect(page.getByRole('status')).toContainText('salvata');
  await secondTab.locator('textarea[name="internalSummary"]').fill('TESTO CONFLITTO DA CONSERVARE');
  await secondTab.locator('textarea[name="requiredDocuments"]').fill('DOCUMENTI CONFLITTO DA CONSERVARE');
  await secondTab.getByRole('button', { name: 'Salva modifiche' }).click();
  await expect(secondTab.getByRole('status')).toContainText('testo inserito è conservato');
  await expect(secondTab.locator('textarea[name="internalSummary"]')).toHaveValue('TESTO CONFLITTO DA CONSERVARE');
  await expect(secondTab.locator('textarea[name="requiredDocuments"]')).toHaveValue('DOCUMENTI CONFLITTO DA CONSERVARE');

  await page.reload();
  const beforeRevocation = await db.preAnalysis.findUniqueOrThrow({ where: { id: recordId } });
  const auditBeforeRevocation = await db.auditLog.count({ where: { entityId: recordId } });
  await db.userPermissionOverride.create({ data: { userId: 'preanalysis-browser-owner', permission: 'dossier.read', allowed: false } });
  await page.locator('textarea[name="internalSummary"]').fill('TESTO DOPO REVOCA');
  await page.getByRole('button', { name: 'Salva modifiche' }).click();
  await expect(page.getByRole('status')).toContainText('non disponibile');
  await expect(page.locator('textarea[name="internalSummary"]')).toHaveValue('TESTO DOPO REVOCA');
  expect((await db.preAnalysis.findUniqueOrThrow({ where: { id: recordId } })).internalSummary).toBe(beforeRevocation.internalSummary);
  expect(await db.auditLog.count({ where: { entityId: recordId } })).toBe(auditBeforeRevocation);
  await db.userPermissionOverride.delete({ where: { userId_permission: { userId: 'preanalysis-browser-owner', permission: 'dossier.read' } } });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.screenshot({ path: join(evidence, 'preanalysis-narrow.png'), fullPage: true });

  const foreignContext = await browser.newContext(); const foreign = await foreignContext.newPage();
  await login(foreign, 'preanalysis-foreign@invalid.test');
  await foreign.goto(`${app}/preanalyses/${recordId}`);
  await expect(foreign.getByRole('heading', { name: 'Pre-analisi non trovata' })).toBeVisible();
  const noReadContext = await browser.newContext(); const noRead = await noReadContext.newPage();
  await login(noRead, 'preanalysis-no-read@invalid.test');
  await noRead.goto(`${app}/projects/preanalysis-browser-project`);
  await expect(noRead.getByText('Sintesi inventata')).toHaveCount(0);
  await expect(noRead.getByRole('link', { name: 'Crea pre-analisi' })).toHaveCount(0);
  await noRead.goto(`${app}/preanalyses/${recordId}`);
  await expect(noRead).toHaveURL(`${app}/dashboard`);

  const persisted = await db.preAnalysis.findUniqueOrThrow({ where: { id: recordId } });
  writeFileSync(join(evidence, 'preanalysis-browser-receipt.json'), `${JSON.stringify({ synthetic: true, created: true, fiveFieldsPersisted: Object.keys(fields).every((field) => persisted[field as keyof typeof persisted] !== null), validationRejected: true, validationTextRetained: true, validationVersionRetained: true, reloaded: true, secondUpdate: true, conflictDetected: true, conflictTextRetained: true, tamperedPostDenied: true, tamperedPostAtomic: true, permissionRevokedAfterOpenDenied: true, permissionRevokedAfterOpenAtomic: true, foreignDenied: true, dossierReadDenied: true, desktopScreenshot: true, narrowScreenshot: true }, null, 2)}\n`, { mode: 0o600 });
  await Promise.all([owner.close(), foreignContext.close(), noReadContext.close()]);
});
