import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const app = 'http://127.0.0.1:3000';
const password = process.env.CATALOG_BROWSER_PASSWORD!;
const evidence = process.env.CATALOG_BROWSER_EVIDENCE_DIR!;

async function login(page: Page, email: string) {
  await page.goto(`${app}/login`);
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(`${app}/dashboard`);
}

test('current and historical catalog remain readable and selectable', async ({ browser }) => {
  mkdirSync(evidence, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let deniedContext: BrowserContext | undefined;
  let phase = 'catalog';
  try {
    await login(page, 'catalog-viewer@invalid.test');
    await page.goto(`${app}/service-catalog`);
    await expect(page.getByRole('heading', { name: 'Catalogo servizi' })).toBeVisible();

    const optimization = page.getByRole('heading', { name: 'Ottimizzazione Aziendale AI' }).locator('xpath=ancestor::section[1]');
    await expect(optimization.getByText('Revisione disponibile nel CRM', { exact: true })).toBeVisible();
    await expect(optimization.getByText('Su preventivo', { exact: true })).toBeVisible();
    await expect(optimization.getByText(/^Versione 1 · TERMS-v1 · € (?:1\.490|1490)(?:,00)? \+ IVA · storica$/u)).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Consulenza fiscale', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pianificazione e ottimizzazione fiscale' })).toBeVisible();
    await expect(page.getByText('senza garanzia di risparmio fiscale', { exact: false })).toBeVisible();
    await expect(page.getByText('La prestazione fiscale è attribuita al professionista abilitato individuato nell’incarico; FAI cura inquadramento e coordinamento.')).toHaveCount(2);
    const fiscalAdvice = page.getByRole('heading', { name: 'Consulenza fiscale', exact: true }).locator('xpath=ancestor::section[1]');
    await expect(fiscalAdvice.getByText('la richiesta non accetta una scadenza', { exact: false })).toBeVisible();
    await expect(fiscalAdvice.getByRole('heading', { name: 'Deliverable' })).toBeVisible();
    await expect(fiscalAdvice.getByRole('heading', { name: 'Incarichi successivi' })).toBeVisible();

    const digitalTypes = page.getByRole('heading', { name: 'Tipologie disponibili' }).locator('xpath=following-sibling::section');
    await expect(digitalTypes).toHaveCount(7);
    await expect(digitalTypes.filter({ hasText: 'Nessuna promessa di lead o posizionamento' })).toHaveCount(1);
    await expect(digitalTypes.filter({ hasText: 'Nessuna garanzia di lead, vendite o ROI' })).toHaveCount(1);

    phase = 'selection';
    await page.locator('select[name="serviceCode"]').selectOption('progetti_digitali');
    await page.locator('select[name="digitalProjectType"]').selectOption('software_crm_workflow');
    await page.getByRole('button', { name: 'Consulta selezione' }).click();
    const selection = page.getByRole('heading', { name: 'Selezione valida' }).locator('xpath=ancestor::section[1]');
    await expect(selection.getByText('Progetti Digitali', { exact: true })).toBeVisible();
    await expect(selection.getByText('Tipologia: Software, CRM e workflow', { exact: true })).toBeVisible();

    await page.screenshot({ path: join(evidence, 'catalog-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(evidence, 'catalog-mobile.png'), fullPage: true });

    phase = 'authorization';
    deniedContext = await browser.newContext();
    const denied = await deniedContext.newPage();
    await login(denied, 'catalog-denied@invalid.test');
    await denied.goto(`${app}/service-catalog`);
    await expect(denied).toHaveURL(`${app}/dashboard`);
    writeFileSync(join(evidence, 'catalog-receipt.json'), JSON.stringify({ status: 'PASS', synthetic: true, provenancePerRevision: true, currentRevision: true, historicalRevision: true, historicalPrice: 1490, quoteOnly: true, fiscalDistinct: true, digitalTypes: 7, digitalConditions: true, selectionValidated: true, unauthorizedDenied: true, desktopScreenshot: true, mobileScreenshot: true }), { mode: 0o600 });
  } catch (error) {
    await page.screenshot({ path: join(evidence, 'catalog-failure.png'), fullPage: true });
    writeFileSync(join(evidence, 'catalog-failure.json'), JSON.stringify({ status: 'FAIL', synthetic: true, phase, path: new URL(page.url()).pathname, visibleText: await page.locator('body').innerText() }), { mode: 0o600 });
    throw error;
  } finally {
    await context.close();
    await deniedContext?.close();
  }
});
