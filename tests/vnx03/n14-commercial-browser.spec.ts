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

function assertState(checkpoint: 'projected' | 'assigned' | 'contacted') {
  const output = compose(['run', '--rm', '-T', '-e', 'COMMERCIAL_LEAD_INBOX_MODE=enforced',
    '-e', `VNX03_N14_CHECKPOINT=${checkpoint}`, 'harness', 'node', '--import', 'tsx',
    'tests/vnx03/assert-n14-state.ts']);
  assert.match(output, new RegExp(`"checkpoint":"${checkpoint}"`, 'u'));
}

function assertRejection(scenario: 'stale_assignment' | 'foreign_first_response', code: string) {
  const output = compose(['run', '--rm', '-T', '-e', 'COMMERCIAL_LEAD_INBOX_MODE=enforced',
    '-e', 'INTERNAL_SESSION_MODE=registry',
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
  identity: 'commercial_one' | 'commercial_two' | 'admin',
) {
  const current = new URL(page.url());
  writeFileSync(join(evidenceDirectory, `n14-login-failure-${identity}.json`), `${JSON.stringify({
    phase: 'ACTIVE_COMMERCIAL_LOGIN',
    syntheticIdentity: identity,
    currentPath: `${current.pathname}${current.search}`,
    expectedOrigin: current.origin === new URL(crmUrl).origin,
    dashboardReached: current.pathname === '/dashboard',
    invalidLoginShown: current.pathname === '/login' && current.searchParams.get('error') === 'invalid',
    loginHeadingVisible: await page.getByRole('heading', { name: 'Accesso interno FAI' }).isVisible().catch(() => false),
  }, null, 2)}\n`, { mode: 0o600 });
}

async function loginActive(
  context: BrowserContext,
  email: string,
  identity: 'commercial_one' | 'commercial_two' | 'admin',
) {
  const page = await context.newPage();
  try {
    await page.goto(`${crmUrl}/login`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Login interno' }).click();
    await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 15_000 });
  } catch (error) {
    await writeLoginFailureDiagnostic(page, identity);
    throw error;
  }
  await expect(page).toHaveURL(`${crmUrl}/dashboard`);
  return page;
}

type ServerActionIdentity = Readonly<{ formField: string; nextAction: string }>;

async function serverActionIdentity(page: Page, buttonName: string): Promise<ServerActionIdentity> {
  return page.getByRole('button', { name: buttonName }).evaluate((button) => {
    const form = button.closest('form');
    if (!form) throw new Error('VNX03_N14_ACTION_FORM_MISSING');
    const actionFields = [...new FormData(form).keys()]
      .filter((name) => name.startsWith('$ACTION_ID_') || name.startsWith('$ACTION_REF_'));
    if (actionFields.length !== 1) throw new Error('VNX03_N14_ACTION_ID_MISSING');
    const formField = actionFields[0]!;
    if (formField.startsWith('$ACTION_REF_')) throw new Error('VNX03_N14_BOUND_ACTION_UNEXPECTED');
    return { formField, nextAction: formField.slice('$ACTION_ID_'.length) };
  });
}

function isServerActionRequest(
  request: import('@playwright/test').Request,
  path: string,
  action: ServerActionIdentity,
) {
  const url = new URL(request.url());
  return request.method() === 'POST'
    && url.origin === new URL(crmUrl).origin
    && `${url.pathname}${url.search}` === path
    && request.headers()['next-action'] === action.nextAction;
}

function responseMediaType(response: import('@playwright/test').Response) {
  return response.headers()['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? 'missing';
}

function writeCheckpoint(name: string, value: Readonly<Record<string, unknown>>) {
  writeFileSync(join(evidenceDirectory, `n14-${name}.json`), `${JSON.stringify({
    phase: name, ...value,
  }, null, 2)}\n`, { mode: 0o600 });
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

test('R05 N14 qualifies admin assignment, conflict, ownership visibility and first response', async ({ browser, page }) => {
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
  await ownerPage.goto(crmUrl + '/leads/inbox?queue=unassigned');
  await expect(ownerPage.getByText('VNX03 N14 Browser', { exact: true })).toHaveCount(0);
  await expect(ownerPage.getByRole('button', { name: 'Prendi in carico' })).toHaveCount(0);
  const admin = await browser.newContext();
  const adminPage = await loginActive(admin, 'admin.n14@vnx03.invalid', 'admin');
  await adminPage.goto(crmUrl + '/settings/security');
  await adminPage.getByLabel('Password corrente').fill(password);
  await adminPage.getByRole('button', { name: 'Conferma per cinque minuti' }).click();
  await expect(adminPage).toHaveURL(/status=active/);
  await adminPage.goto(crmUrl + '/leads/inbox?queue=unassigned');
  await expect(adminPage.getByText('VNX03 N14 Browser', { exact: true })).toBeVisible();
  await adminPage.locator('select[name="targetUserId"]').selectOption('vnx03-n14-commercial-one');
  const duplicatePage = await admin.newPage();
  await duplicatePage.goto(crmUrl + '/leads/inbox?queue=unassigned');
  await duplicatePage.locator('select[name="targetUserId"]').selectOption('vnx03-n14-commercial-one');
  const assignmentAction = await serverActionIdentity(adminPage, 'Assegna');
  assert.deepEqual(await serverActionIdentity(duplicatePage, 'Assegna'), assignmentAction);
  const assignmentPath = '/leads/inbox?queue=unassigned';
  let releaseAssignments!: () => void;
  const assignmentGate = new Promise<void>((resolve) => { releaseAssignments = resolve; });
  const assignmentArrivals: Promise<void>[] = [];
  for (const assignmentPage of [adminPage, duplicatePage]) {
    let markArrived!: () => void;
    assignmentArrivals.push(new Promise<void>((resolve) => { markArrived = resolve; }));
    await assignmentPage.route('**/*', async (route) => {
      const request = route.request();
      if (!isServerActionRequest(request, assignmentPath, assignmentAction)) return route.continue();
      markArrived();
      await assignmentGate;
      await route.continue();
    });
  }
  const assignmentPages = [adminPage, duplicatePage] as const;
  const assignmentResponses = assignmentPages.map((assignmentPage) =>
    assignmentPage.waitForResponse((response) =>
      isServerActionRequest(response.request(), assignmentPath, assignmentAction), { timeout: 30_000 }));
  const clicks = assignmentPages.map((assignmentPage) =>
    assignmentPage.getByRole('button', { name: 'Assegna' }).click().catch(() => undefined));
  await Promise.all(assignmentArrivals);
  writeCheckpoint('assignment-requests-released', {
    requestsObserved: assignmentArrivals.length, exactActionMatched: true, deadlineSeconds: 30,
  });
  releaseAssignments();
  const responses = await Promise.all(assignmentResponses);
  const assignmentHttpStatuses = responses.map((response) => response.status()).sort((left, right) => left - right);
  const assignmentContentTypes = responses.map(responseMediaType);
  writeCheckpoint('assignment-response-headers', {
    responsesObserved: responses.length, assignmentHttpStatuses, assignmentContentTypes,
  });
  assert.deepEqual(assignmentHttpStatuses, [200, 500]);
  assert.ok(assignmentContentTypes.every((value) => value === 'text/x-component'));
  const successPage = assignmentPages[responses.findIndex((response) => response.status() === 200)];
  const errorPage = assignmentPages[responses.findIndex((response) => response.status() === 500)];
  assert.ok(successPage && errorPage);
  assertState('assigned');
  const transportHealth = await ownerPage.request.get(`${crmUrl}/api/health`, { timeout: 10_000 });
  assert.equal(transportHealth.status(), 200);
  assert.equal(transportHealth.headers()['content-type']?.split(';', 1)[0], 'application/json');
  await successPage.goto(`${crmUrl}/leads/inbox?queue=open`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await expect(successPage.getByText('Owner: Commerciale Sintetico Uno', { exact: false }))
    .toBeVisible({ timeout: 20_000 });
  await errorPage.goto(`${crmUrl}/leads/inbox?queue=unassigned`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await expect(errorPage.getByText('Nessun item', { exact: true })).toBeVisible({ timeout: 20_000 });
  void Promise.all(clicks);
  writeCheckpoint('assignment-semantic-result', {
    successUiObserved: true, errorBrowserRecovered: true,
    transportHealthStatus: transportHealth.status(), persistentCheckpoint: 'assigned',
  });
  await ownerPage.goto(crmUrl + '/leads/inbox?queue=mine');
  await expect(ownerPage.getByText('VNX03 N14 Browser', { exact: true })).toBeVisible();
  const ownerWorkPage = ownerPage;
  assertRejection('stale_assignment', 'N14_VERSION_CONFLICT');
  const leadHref = await ownerWorkPage.getByRole('link', { name: 'VNX03 N14 Browser' }).getAttribute('href');
  assert.ok(leadHref);
  const firstResponseCommand = await ownerWorkPage.getByRole('button', { name: 'Registra prima risposta' })
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
  assertState('assigned');
  assertRejection('foreign_first_response', 'N14_PERMISSION_DENIED');

  await ownerWorkPage.reload();
  const firstResponseAction = await serverActionIdentity(ownerWorkPage, 'Registra prima risposta');
  const firstResponsePath = '/leads/inbox?queue=mine';
  const firstResponseReply = ownerWorkPage.waitForResponse((response) =>
    isServerActionRequest(response.request(), firstResponsePath, firstResponseAction), { timeout: 30_000 });
  writeCheckpoint('first-response-request-started', {
    exactActionMatched: true, deadlineSeconds: 30,
  });
  const firstResponseClick = ownerWorkPage.getByRole('button', { name: 'Registra prima risposta' })
    .click().catch(() => undefined);
  const firstResponse = await firstResponseReply;
  const firstResponseContentType = responseMediaType(firstResponse);
  writeCheckpoint('first-response-headers', {
    responseObserved: true, httpStatus: firstResponse.status(), contentType: firstResponseContentType,
  });
  assert.equal(firstResponse.status(), 200);
  assert.equal(firstResponseContentType, 'text/x-component');
  assertState('contacted');
  await expect(ownerWorkPage.getByRole('button', { name: 'Registra prima risposta' }))
    .toHaveCount(0, { timeout: 20_000 });
  void firstResponseClick;
  writeCheckpoint('first-response-semantic-result', {
    uiAppliedBeforeReload: true, persistentCheckpoint: 'contacted',
  });
  await ownerWorkPage.reload();
  await expect(ownerWorkPage.getByRole('button', { name: 'Registra prima risposta' })).toHaveCount(0);
  await expect(ownerWorkPage.locator('article').filter({ hasText: 'VNX03 N14 Browser' }))
    .not.toContainText('Risposta: —');
  await ownerWorkPage.screenshot({ path: join(evidenceDirectory, 'n14-commercial-inbox.png'), fullPage: false });
  assertState('contacted');

  writeFileSync(join(evidenceDirectory, 'n14-browser.json'), `${JSON.stringify({
    synthetic: true, registryLogin: true, ownerPersistedAfterReload: true,
    assignmentResponsesObserved: responses.length, assignmentHttpStatuses, assignmentContentTypes,
    assignmentSuccessUiObserved: true, assignmentErrorBrowserRecovered: true,
    assignmentTransportHealthStatus: transportHealth.status(),
    staleAssignmentCodeVerifiedSeparately: true,
    secondCommercialMutationRejected: true, rejectedMutationStatus: rejectedMutation.status,
    firstResponseObserved: true, firstResponseHttpStatus: firstResponse.status(),
    firstResponseContentType, firstResponseUiAppliedBeforeReload: true, firstResponseRecorded: true,
    n15Effects: 0,
  }, null, 2)}\n`, { mode: 0o600 });
  await other.close();
  await owner.close();
  await admin.close();
});
