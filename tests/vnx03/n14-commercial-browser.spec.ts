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

function assertRejection(scenario: 'stale_claim' | 'foreign_first_response', code: string) {
  const output = compose(['run', '--rm', '-T', '-e', 'COMMERCIAL_LEAD_INBOX_MODE=enforced',
    '-e', `VNX03_N14_REJECTION=${scenario}`, 'harness', 'node', '--import', 'tsx',
    'tests/vnx03/exercise-n14-rejections.ts']);
  assert.match(output, new RegExp(`"rejectedBy":"${code}"`, 'u'));
  assert.match(output, /"stateUnchanged":true/u);
}

async function submitLogin(context: BrowserContext, email: string) {
  const page = await context.newPage();
  await page.goto(`${crmUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  return page;
}

async function writeLoginFailureDiagnostic(
  page: Page,
  context: BrowserContext,
  identity: 'commercial_one' | 'commercial_two',
) {
  const current = new URL(page.url());
  const cookies = await context.cookies(crmUrl);
  writeFileSync(join(evidenceDirectory, `n14-login-failure-${identity}.json`), `${JSON.stringify({
    phase: 'ACTIVE_COMMERCIAL_LOGIN',
    syntheticIdentity: identity,
    currentPath: `${current.pathname}${current.search}`,
    expectedOrigin: current.origin === new URL(crmUrl).origin,
    dashboardReached: current.pathname === '/dashboard',
    invalidLoginShown: current.pathname === '/login' && current.searchParams.get('error') === 'invalid',
    registryCookiePresent: cookies.some(({ name }) => name === 'fai_vnx03_n14_session'),
    loginHeadingVisible: await page.getByRole('heading', { name: 'Accesso interno FAI' }).isVisible().catch(() => false),
  }, null, 2)}\n`, { mode: 0o600 });
}

async function loginActive(
  context: BrowserContext,
  email: string,
  identity: 'commercial_one' | 'commercial_two',
) {
  const page = await context.newPage();
  try {
    await page.goto(`${crmUrl}/login`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Login interno' }).click();
    await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 15_000 });
  } catch (error) {
    await writeLoginFailureDiagnostic(page, context, identity);
    throw error;
  }
  await expect(page).toHaveURL(`${crmUrl}/dashboard`);
  return page;
}

async function serverActionName(page: Page, buttonName: string) {
  return page.getByRole('button', { name: buttonName }).evaluate((button) => {
    const form = button.closest('form');
    if (!form) throw new Error('VNX03_N14_ACTION_FORM_MISSING');
    const action = [...new FormData(form).keys()].find((name) => name.startsWith('$ACTION_ID_'));
    if (!action) throw new Error('VNX03_N14_ACTION_ID_MISSING');
    return action;
  });
}

function isServerActionRequest(request: import('@playwright/test').Request, path: string, action: string) {
  const url = new URL(request.url());
  return request.method() === 'POST'
    && url.origin === new URL(crmUrl).origin
    && `${url.pathname}${url.search}` === path
    && (request.postData() ?? '').includes(action);
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
  const inactivePage = await submitLogin(inactive, 'commercial.inactive@vnx03.invalid');
  await expect(inactivePage).toHaveURL(/\/login\?error=invalid$/u);
  await inactive.close();

  const owner = await browser.newContext();
  const ownerPage = await loginActive(owner, 'commercial.one@vnx03.invalid', 'commercial_one');
  await ownerPage.goto(`${crmUrl}/leads/inbox?queue=unassigned`);
  await expect(ownerPage.getByText('VNX03 N14 Browser', { exact: true })).toBeVisible();
  const duplicatePage = await owner.newPage();
  await duplicatePage.goto(`${crmUrl}/leads/inbox?queue=unassigned`);
  const claimAction = await serverActionName(ownerPage, 'Prendi in carico');
  assert.equal(await serverActionName(duplicatePage, 'Prendi in carico'), claimAction);
  const claimPath = '/leads/inbox?queue=unassigned';
  let releaseClaims!: () => void;
  const claimGate = new Promise<void>((resolve) => { releaseClaims = resolve; });
  const claimArrivals: Promise<void>[] = [];
  for (const claimPage of [ownerPage, duplicatePage]) {
    let markArrived!: () => void;
    claimArrivals.push(new Promise<void>((resolve) => { markArrived = resolve; }));
    await claimPage.route('**/*', async (route) => {
      const request = route.request();
      if (!isServerActionRequest(request, claimPath, claimAction)) return route.continue();
      markArrived();
      await claimGate;
      await route.continue();
    });
  }
  const claimResponses = [ownerPage, duplicatePage].map((claimPage) =>
    claimPage.waitForResponse((response) =>
      isServerActionRequest(response.request(), claimPath, claimAction)));
  const clicks = [ownerPage, duplicatePage].map((claimPage) =>
    claimPage.getByRole('button', { name: 'Prendi in carico' }).click());
  await Promise.all(claimArrivals);
  releaseClaims();
  const responses = await Promise.all(claimResponses);
  assert.deepEqual(await Promise.all(responses.map((response) => response.finished())), [null, null]);
  await Promise.allSettled(clicks);
  const claimHttpStatuses = responses.map((response) => response.status()).sort((left, right) => left - right);
  assert.deepEqual(claimHttpStatuses, [200, 500]);
  await ownerPage.goto(`${crmUrl}/leads/inbox?queue=mine`);
  await expect(ownerPage.getByText('Owner: Commerciale Sintetico Uno', { exact: false })).toBeVisible();
  assertState('claimed');
  assertRejection('stale_claim', 'N14_VERSION_CONFLICT');
  const leadHref = await ownerPage.getByRole('link', { name: 'VNX03 N14 Browser' }).getAttribute('href');
  assert.ok(leadHref);
  const firstResponseCommand = await ownerPage.getByRole('button', { name: 'Registra prima risposta' })
    .evaluate((button) => {
      const form = button.closest('form');
      if (!form) throw new Error('VNX03_N14_FIRST_RESPONSE_FORM_MISSING');
      return {
        action: form.action,
        fields: [...new FormData(form).entries()].map(([name, value]) => [name, String(value)]),
      };
    });

  const other = await browser.newContext();
  const otherPage = await loginActive(other, 'commercial.two@vnx03.invalid', 'commercial_two');
  await otherPage.goto(`${crmUrl}/leads/inbox?queue=open`);
  await expect(otherPage.getByText('VNX03 N14 Browser', { exact: true })).toHaveCount(0);
  await otherPage.goto(`${crmUrl}${leadHref}`);
  await expect(otherPage.getByRole('heading', { name: 'Lead non trovato' })).toBeVisible();
  const rejectedMutation = await otherPage.evaluate(async ({ action, fields }) => {
    const body = new FormData();
    for (const [name, value] of fields) body.append(name, value);
    const response = await fetch(action, { method: 'POST', body, redirect: 'manual' });
    return { status: response.status, type: response.type };
  }, firstResponseCommand);
  assert.ok(rejectedMutation.status >= 400, 'VNX03_N14_FOREIGN_MUTATION_NOT_REJECTED');
  assertState('claimed');
  assertRejection('foreign_first_response', 'N14_PERMISSION_DENIED');

  await ownerPage.reload();
  const firstResponseAction = await serverActionName(ownerPage, 'Registra prima risposta');
  const firstResponsePath = '/leads/inbox?queue=mine';
  const firstResponseReply = ownerPage.waitForResponse((response) =>
    isServerActionRequest(response.request(), firstResponsePath, firstResponseAction));
  await ownerPage.getByRole('button', { name: 'Registra prima risposta' }).click();
  const firstResponse = await firstResponseReply;
  assert.equal(await firstResponse.finished(), null);
  assert.equal(firstResponse.status(), 200);
  await expect(ownerPage.getByRole('button', { name: 'Registra prima risposta' })).toHaveCount(0);
  await ownerPage.reload();
  await expect(ownerPage.getByRole('button', { name: 'Registra prima risposta' })).toHaveCount(0);
  await expect(ownerPage.locator('article').filter({ hasText: 'VNX03 N14 Browser' }))
    .not.toContainText('Risposta: —');
  await ownerPage.screenshot({ path: join(evidenceDirectory, 'n14-commercial-inbox.png'), fullPage: false });
  assertState('contacted');

  writeFileSync(join(evidenceDirectory, 'n14-browser.json'), `${JSON.stringify({
    synthetic: true, registryLogin: true, ownerPersistedAfterReload: true,
    claimResponsesCompleted: responses.length, claimHttpStatuses,
    staleClaimCodeVerifiedSeparately: true,
    secondCommercialMutationRejected: true, rejectedMutationStatus: rejectedMutation.status,
    firstResponseHttpStatus: firstResponse.status(), firstResponseRecorded: true,
    n15Effects: 0,
  }, null, 2)}\n`, { mode: 0o600 });
  await other.close();
  await owner.close();
});
