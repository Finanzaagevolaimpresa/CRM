import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

type QueueRow = Readonly<{
  status: string;
  attempt: number;
  result: string | null;
  ciphertext: boolean;
  plaintextMarker: boolean;
}>;

type QueueState = Readonly<{
  rows: readonly QueueRow[];
  pluginActive: boolean;
  scheduled: boolean;
  nextDelaySeconds: number | null;
  schemaVersion: string;
}>;

const project = requiredEnvironment('COMPOSE_PROJECT_NAME');
const composeFile = requiredEnvironment('VNX03_COMPOSE_FILE');
const wordpressUrl = requiredEnvironment('VNX03_WORDPRESS_PUBLIC_URL');
const evidenceDirectory = requiredEnvironment('VNX03_EVIDENCE_DIR');

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`VNX03_ENVIRONMENT_MISSING_${name}`);
  return value;
}

function compose(arguments_: readonly string[], timeout = 120_000) {
  return execFileSync(
    'docker',
    ['compose', '-p', project, '-f', composeFile, ...arguments_],
    {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout,
    },
  );
}

function wp(arguments_: readonly string[], timeout = 120_000) {
  return compose([
    'exec', '-T', '--user', '33:33', '-e', 'HOME=/tmp',
    'wordpress', 'wp', '--path=/var/www/html', '--quiet', ...arguments_,
  ], timeout);
}

function setControl(service: 'wordpress' | 'gateway', file: string, value: string) {
  assert.match(value, /^[a-z_]+$/u);
  compose([
    'exec', '-T', '--user', '0:0', service,
    'sh', '-c', 'printf "%s\\n" "$1" > "/run/vnx03-control/$2"',
    'vnx03-control', value, file,
  ]);
}

function setConnectorScenario(value: string) {
  setControl('wordpress', 'connector-scenario', value);
}

function setGatewayMode(value: 'normal' | 'drop_after_admission') {
  setControl('wordpress', 'gateway-mode', value);
}

function wordpressState(): QueueState {
  const output = wp(['eval-file', '/opt/vnx03/wp-state.php']);
  const json = output.trim().split(/\r?\n/u).reverse().find((line) => line.startsWith('{'));
  assert.ok(json, 'VNX03_WORDPRESS_STATE_OUTPUT_MISSING');
  return JSON.parse(json) as QueueState;
}

function assertCrm(checkpoint: string) {
  const output = compose([
    'run', '--rm', '-T',
    '-e', `VNX03_ASSERT_CHECKPOINT=${checkpoint}`,
    'harness',
    'node', '--import', 'tsx', 'tests/vnx03/assert-state.ts',
  ], 180_000);
  assert.match(output, new RegExp(`"checkpoint":"${checkpoint}"`, 'u'));
}

function runConsumer() {
  const output = compose([
    'run', '--rm', '-T', 'harness', 'npm', 'run', 'vnx01:lead-intake',
  ], 180_000);
  assert.match(output, /"status":"COMPLETED"/u);
  assert.match(output, /"projectedNew":1/u);
  assert.match(output, /"failed":0/u);
}

function runWordPressWorker() {
  wp(['cron', 'event', 'run', 'fai_vnx02_secure_lead_queue'], 30_000);
}

async function submitForm(
  page: Page,
  input: Readonly<{
    formId: 900001 | 900002;
    slug: 'vnx03-allowed' | 'vnx03-excluded';
    firstName: string;
    lastName: string;
    email: string;
    company: string;
    phone: string;
    amount: string;
    service: boolean;
    marketing: 'SYNTHETIC_MARKETING_GRANTED' | 'SYNTHETIC_MARKETING_DENIED';
  }>,
) {
  await page.goto(`${wordpressUrl}/${input.slug}/`, { waitUntil: 'networkidle' });
  const prefix = `#wpforms-${input.formId}-field_`;
  await page.locator(`${prefix}1`).fill(input.firstName);
  await page.locator(`${prefix}2`).fill(input.lastName);
  await page.locator(`${prefix}3`).fill(input.email);
  await page.locator(`${prefix}4`).fill(input.company);
  await page.locator(`${prefix}5`).fill(input.phone);
  await page.locator(`${prefix}6`).fill(input.amount);
  await page.locator(`${prefix}7`).fill('Synthetic VNX-03 browser qualification only.');
  if (input.service) {
    await page.locator(`input[name="wpforms[fields][8]"][value="SYNTHETIC_SERVICE_ACCEPTED"]`).check();
  }
  await page.locator(`input[name="wpforms[fields][9]"][value="${input.marketing}"]`).check();
  const startedAt = Date.now();
  await page.locator(`#wpforms-submit-${input.formId}`).click();
  await expect(page.getByText('VNX03_SYNTHETIC_CONFIRMATION', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  return Date.now() - startedAt;
}

async function waitForRetry(state: QueueState) {
  const delay = state.nextDelaySeconds;
  assert.ok(delay !== null, 'VNX03_RETRY_DELAY_MISSING');
  assert.ok(delay >= 0 && delay <= 60);
  await new Promise((resolve) => setTimeout(resolve, (delay + 2) * 1_000));
}

async function waitForDropMarker() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      compose(['exec', '-T', 'gateway', 'test', '-f', '/run/vnx03-evidence/dropped-after-admission.marker']);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('VNX03_DROP_MARKER_MISSING');
}

test('authentic WPForms UI reaches N12/N11/VNX-01/N13 over verified HTTPS', async ({
  browser,
  page,
}) => {
  test.setTimeout(8 * 60_000);
  mkdirSync(evidenceDirectory, { recursive: true });
  const initialState = wordpressState();
  assert.deepEqual(
    { schemaVersion: initialState.schemaVersion, pluginActive: initialState.pluginActive },
    { schemaVersion: '1', pluginActive: true },
  );
  assertCrm('empty');

  setConnectorScenario('disabled');
  await submitForm(page, {
    formId: 900001,
    slug: 'vnx03-allowed',
    firstName: 'Disabled',
    lastName: 'Synthetic',
    email: 'disabled@vnx03.invalid',
    company: 'VNX03 Disabled',
    phone: '+390200000001',
    amount: '1000.00',
    service: true,
    marketing: 'SYNTHETIC_MARKETING_GRANTED',
  });
  assert.equal(wordpressState().rows.length, 0);
  assertCrm('empty');

  setConnectorScenario('normal');
  await submitForm(page, {
    formId: 900002,
    slug: 'vnx03-excluded',
    firstName: 'Excluded',
    lastName: 'Synthetic',
    email: 'excluded@vnx03.invalid',
    company: 'VNX03 Excluded',
    phone: '+390200000002',
    amount: '2000.00',
    service: true,
    marketing: 'SYNTHETIC_MARKETING_DENIED',
  });
  assert.equal(wordpressState().rows.length, 0);
  assertCrm('empty');

  await submitForm(page, {
    formId: 900001,
    slug: 'vnx03-allowed',
    firstName: 'Privacy',
    lastName: 'Missing',
    email: 'privacy-missing@vnx03.invalid',
    company: 'VNX03 Privacy Missing',
    phone: '+390200000003',
    amount: '3000.00',
    service: false,
    marketing: 'SYNTHETIC_MARKETING_DENIED',
  });
  assert.equal(wordpressState().rows.length, 0);
  assertCrm('empty');

  compose(['stop', '--timeout', '20', 'gateway']);
  setConnectorScenario('normal');
  const outageSubmissionMs = await submitForm(page, {
    formId: 900001,
    slug: 'vnx03-allowed',
    firstName: 'Giulia',
    lastName: 'Sintetica',
    email: 'granted@vnx03.invalid',
    company: 'VNX03 Granted',
    phone: '+390212345678',
    amount: '125000.50',
    service: true,
    marketing: 'SYNTHETIC_MARKETING_GRANTED',
  });
  assert.ok(outageSubmissionMs < 15_000);
  await page.screenshot({
    path: join(evidenceDirectory, 'wpforms-confirmation.png'),
    fullPage: false,
  });
  await page.waitForTimeout(1_500);
  let state = wordpressState();
  assert.deepEqual(state.rows, [{
    status: 'PENDING', attempt: 0, result: null, ciphertext: true, plaintextMarker: false,
  }]);
  assert.equal(state.scheduled, true);
  assertCrm('empty');

  runWordPressWorker();
  state = wordpressState();
  assert.deepEqual(state.rows, [{
    status: 'PENDING',
    attempt: 1,
    result: 'TEMPORARILY_UNAVAILABLE',
    ciphertext: true,
    plaintextMarker: false,
  }]);
  assertCrm('empty');

  setConnectorScenario('disabled');
  wp(['plugin', 'deactivate', 'fai-secure-lead-connector']);
  state = wordpressState();
  assert.equal(state.pluginActive, false);
  assert.equal(state.scheduled, false);
  compose(['up', '-d', '--wait', '--wait-timeout', '60', 'gateway']);
  await waitForRetry(state);
  setConnectorScenario('normal');
  wp(['plugin', 'activate', 'fai-secure-lead-connector']);
  state = wordpressState();
  assert.equal(state.pluginActive, true);
  assert.equal(state.scheduled, true);
  runWordPressWorker();
  state = wordpressState();
  assert.deepEqual(state.rows, [{
    status: 'DELIVERED', attempt: 2, result: 'DELIVERED', ciphertext: false, plaintextMarker: false,
  }]);
  assertCrm('after_granted_admission');
  runConsumer();
  assertCrm('after_granted_projection');

  setGatewayMode('drop_after_admission');
  await submitForm(page, {
    formId: 900001,
    slug: 'vnx03-allowed',
    firstName: 'Marco',
    lastName: 'Negato',
    email: 'denied@vnx03.invalid',
    company: 'VNX03 Denied',
    phone: '+390298765432',
    amount: '80000.00',
    service: true,
    marketing: 'SYNTHETIC_MARKETING_DENIED',
  });
  await page.waitForTimeout(1_500);
  runWordPressWorker();
  await waitForDropMarker();
  state = wordpressState();
  assert.deepEqual(state.rows[1], {
    status: 'PENDING',
    attempt: 1,
    result: 'TEMPORARILY_UNAVAILABLE',
    ciphertext: true,
    plaintextMarker: false,
  });
  assertCrm('after_lost_response');

  setGatewayMode('normal');
  await waitForRetry(state);
  await page.goto(`${wordpressUrl}/?vnx03_retransmit=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1_500);
  runWordPressWorker();
  state = wordpressState();
  assert.deepEqual(state.rows[1], {
    status: 'DELIVERED', attempt: 2, result: 'DELIVERED', ciphertext: false, plaintextMarker: false,
  });
  assertCrm('after_retry');
  runConsumer();
  assertCrm('after_denied_projection');

  setConnectorScenario('bad_hmac');
  await submitForm(page, {
    formId: 900001,
    slug: 'vnx03-allowed',
    firstName: 'Hmac',
    lastName: 'Rejected',
    email: 'bad-hmac@vnx03.invalid',
    company: 'VNX03 Bad HMAC',
    phone: '+390200000004',
    amount: '4000.00',
    service: true,
    marketing: 'SYNTHETIC_MARKETING_DENIED',
  });
  await page.waitForTimeout(1_500);
  runWordPressWorker();
  state = wordpressState();
  assert.deepEqual(state.rows.at(-1), {
    status: 'PENDING', attempt: 1, result: 'UNAUTHORIZED', ciphertext: true, plaintextMarker: false,
  });
  assertCrm('security_negatives');

  setConnectorScenario('wrong_hostname');
  await submitForm(page, {
    formId: 900001,
    slug: 'vnx03-allowed',
    firstName: 'Hostname',
    lastName: 'Rejected',
    email: 'wrong-hostname@vnx03.invalid',
    company: 'VNX03 Wrong Hostname',
    phone: '+390200000005',
    amount: '5000.00',
    service: true,
    marketing: 'SYNTHETIC_MARKETING_DENIED',
  });
  await page.waitForTimeout(1_500);
  runWordPressWorker();
  state = wordpressState();
  assert.deepEqual(state.rows.at(-1), {
    status: 'PENDING',
    attempt: 1,
    result: 'TEMPORARILY_UNAVAILABLE',
    ciphertext: true,
    plaintextMarker: false,
  });
  assertCrm('security_negatives');

  setConnectorScenario('untrusted_ca');
  await submitForm(page, {
    formId: 900001,
    slug: 'vnx03-allowed',
    firstName: 'Certificate',
    lastName: 'Rejected',
    email: 'untrusted-ca@vnx03.invalid',
    company: 'VNX03 Untrusted CA',
    phone: '+390200000006',
    amount: '6000.00',
    service: true,
    marketing: 'SYNTHETIC_MARKETING_DENIED',
  });
  await page.waitForTimeout(1_500);
  runWordPressWorker();
  state = wordpressState();
  assert.deepEqual(state.rows.at(-1), {
    status: 'PENDING',
    attempt: 1,
    result: 'TEMPORARILY_UNAVAILABLE',
    ciphertext: true,
    plaintextMarker: false,
  });
  assert.ok(state.rows.every(({ plaintextMarker }) => plaintextMarker === false));
  assertCrm('security_negatives');

  writeFileSync(join(evidenceDirectory, 'browser.json'), `${JSON.stringify({
    browserVersion: browser.version(),
    authenticWpformsSubmissions: 8,
    projectedLeads: 2,
    marketingGranted: 1,
    marketingDenied: 1,
    negativeAdmissions: 0,
    responseLossReplayRequests: 2,
  }, null, 2)}\n`, { mode: 0o600 });
});
