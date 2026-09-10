import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const project = required('COMPOSE_PROJECT_NAME');
const composeFile = required('VNX03_COMPOSE_FILE');
const wordpressUrl = required('VNX03_WORDPRESS_PUBLIC_URL');
const crmUrl = required('VNX03_CRM_PUBLIC_URL');
const password = required('VNX03_COMMERCIAL_PASSWORD');
const evidenceDirectory = required('VNX03_EVIDENCE_DIR');

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`VNX03_N14_ENVIRONMENT_MISSING_${name}`);
  return value;
}

function compose(arguments_: readonly string[], timeout = 180_000) {
  return execFileSync('docker', ['compose', '-p', project, '-f', composeFile, ...arguments_], {
    encoding: 'utf8', env: process.env, maxBuffer: 1024 * 1024, timeout,
  });
}

function assertState(checkpoint: 'projected' | 'claimed' | 'contacted') {
  const output = compose(['run', '--rm', '-T', '-e', 'COMMERCIAL_LEAD_INBOX_MODE=enforced',
    '-e', `VNX03_N14_CHECKPOINT=${checkpoint}`, 'harness', 'node', '--import', 'tsx',
    'tests/vnx03/assert-n14-state.ts']);
  assert.match(output, new RegExp(`"checkpoint":"${checkpoint}"`, 'u'));
}

async function login(context: BrowserContext, email: string) {
  const page = await context.newPage();
  await page.goto(`${crmUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  return page;
}

async function submitSyntheticLead(page: Page) {
  compose(['exec', '-T', '--user', '0:0', 'wordpress', 'sh', '-c',
    'printf "normal\\n" > /run/vnx03-control/connector-scenario']);
  await page.goto(`${wordpressUrl}/vnx03-allowed/`, { waitUntil: 'networkidle' });
  const prefix = '#wpforms-900001-field_';
  await page.locator(`${prefix}1`).fill('Browser');
  await page.locator(`${prefix}2`).fill('Commerciale');
  await page.locator(`${prefix}3`).fill('commercial-browser@vnx03.invalid');
  await page.locator(`${prefix}4`).fill('VNX03 N14 Browser');
  await page.locator(`${prefix}5`).fill('+390200000014');
  await page.locator(`${prefix}6`).fill('14000.00');
  await page.locator(`${prefix}7`).fill('Synthetic N14 browser qualification only.');
  await page.locator('input[name="wpforms[fields][8]"][value="SYNTHETIC_SERVICE_ACCEPTED"]').check();
  await page.locator('input[name="wpforms[fields][9]"][value="SYNTHETIC_MARKETING_DENIED"]').check();
  await page.locator('#wpforms-submit-900001').click();
  await expect(page.getByText('VNX03_SYNTHETIC_CONFIRMATION', { exact: true })).toBeVisible();
  compose(['exec', '-T', '--user', '33:33', '-e', 'HOME=/tmp', 'wordpress', 'wp',
    '--path=/var/www/html', '--quiet', 'cron', 'event', 'run', 'fai_vnx02_secure_lead_queue']);
  const consumer = compose(['run', '--rm', '-T', '-e', 'COMMERCIAL_LEAD_INBOX_MODE=enforced',
    'harness', 'npm', 'run', 'vnx01:lead-intake']);
  assert.match(consumer, /"projectedNew":1/u);
}

test('N14 qualifies authentic login, claim conflict, ownership visibility and first response', async ({ browser, page }) => {
  test.setTimeout(5 * 60_000);
  mkdirSync(evidenceDirectory, { recursive: true });
  await submitSyntheticLead(page);
  assertState('projected');

  await page.goto(`${crmUrl}/leads/inbox`);
  await expect(page).toHaveURL(/\/login$/u);

  const inactive = await browser.newContext();
  const inactivePage = await login(inactive, 'commercial.inactive@vnx03.invalid');
  await expect(inactivePage).toHaveURL(/\/login\?error=invalid$/u);
  await inactive.close();

  const owner = await browser.newContext();
  const ownerPage = await login(owner, 'commercial.one@vnx03.invalid');
  await ownerPage.goto(`${crmUrl}/leads/inbox?queue=unassigned`);
  await expect(ownerPage.getByText('VNX03 N14 Browser', { exact: true })).toBeVisible();
  const duplicatePage = await owner.newPage();
  await duplicatePage.goto(`${crmUrl}/leads/inbox?queue=unassigned`);
  const attempts = await Promise.allSettled([
    ownerPage.getByRole('button', { name: 'Prendi in carico' }).click(),
    duplicatePage.getByRole('button', { name: 'Prendi in carico' }).click(),
  ]);
  assert.ok(attempts.some(({ status }) => status === 'fulfilled'));
  await ownerPage.goto(`${crmUrl}/leads/inbox?queue=mine`);
  await expect(ownerPage.getByText('Owner: Commerciale Sintetico Uno', { exact: false })).toBeVisible();
  assertState('claimed');
  const leadHref = await ownerPage.getByRole('link', { name: 'VNX03 N14 Browser' }).getAttribute('href');
  assert.ok(leadHref);

  const other = await browser.newContext();
  const otherPage = await login(other, 'commercial.two@vnx03.invalid');
  await otherPage.goto(`${crmUrl}/leads/inbox?queue=open`);
  await expect(otherPage.getByText('VNX03 N14 Browser', { exact: true })).toHaveCount(0);
  await otherPage.goto(`${crmUrl}${leadHref}`);
  await expect(otherPage.getByRole('heading', { name: 'Lead non trovato' })).toBeVisible();
  assertState('claimed');

  await ownerPage.reload();
  await ownerPage.getByRole('button', { name: 'Registra prima risposta' }).click();
  await ownerPage.reload();
  await expect(ownerPage.getByRole('button', { name: 'Registra prima risposta' })).toHaveCount(0);
  await expect(ownerPage.getByText(/Risposta: (?!—)/u)).toBeVisible();
  await ownerPage.screenshot({ path: join(evidenceDirectory, 'n14-commercial-inbox.png'), fullPage: false });
  assertState('contacted');

  writeFileSync(join(evidenceDirectory, 'n14-browser.json'), `${JSON.stringify({
    synthetic: true, registryLogin: true, ownerPersistedAfterReload: true,
    competingClaimObserved: true, secondCommercialDenied: true, firstResponseRecorded: true,
    n15Effects: 0,
  }, null, 2)}\n`, { mode: 0o600 });
  await other.close();
  await owner.close();
});
