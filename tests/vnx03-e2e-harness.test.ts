import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

function source(path: string) {
  return readFileSync(resolve(root, path), 'utf8');
}

test('VNX-03 pins official WPForms, WordPress, database and browser inputs', () => {
  const runner = source('scripts/vnx03/run-e2e.sh');
  const compose = source('tests/vnx03/docker-compose.yml');
  const wordpress = source('tests/vnx03/Dockerfile.wordpress');
  const packageJson = JSON.parse(source('package.json')) as {
    devDependencies: Record<string, string>;
  };

  assert.equal(packageJson.devDependencies['@playwright/test'], '1.63.0');
  assert.match(runner, /WPFORMS_VERSION='2\.0\.1\.1'/u);
  assert.match(runner, /downloads\.wordpress\.org\/plugin\/wpforms-lite\.2\.0\.1\.1\.zip/u);
  assert.match(runner, /WPFORMS_SHA256='[0-9a-f]{64}'/u);
  assert.match(runner, /WP_CLI_VERSION='2\.12\.0'/u);
  assert.match(runner, /WP_CLI_SHA256='[0-9a-f]{64}'/u);
  assert.match(wordpress, /wordpress:7\.1-php8\.4-apache@sha256:[0-9a-f]{64}/u);
  assert.match(compose, /postgres:16-alpine@sha256:[0-9a-f]{64}/u);
  assert.match(compose, /mysql:8\.4@sha256:[0-9a-f]{64}/u);
});

test('VNX-03 environment is synthetic, internal and fail-closed', () => {
  const runner = source('scripts/vnx03/run-e2e.sh');
  const compose = source('tests/vnx03/docker-compose.yml');
  const provision = source('tests/vnx03/provision.ts');

  assert.match(runner, /VNX03_SYNTHETIC_E2E_CONFIRMED/u);
  assert.match(runner, /VNX03_WORKTREE_NOT_EXACT_HEAD/u);
  assert.match(runner, /VNX03_FORBIDDEN_RUNTIME_OR_SCHEMA_DELTA/u);
  assert.match(runner, /VNX03_NONLOCAL_DOCKER_CONTEXT_FORBIDDEN/u);
  assert.match(runner, /down --volumes --remove-orphans/u);
  assert.match(runner, /docker image rm/u);
  assert.match(compose, /\$\{COMPOSE_PROJECT_NAME[^\n]*\}-harness:/u);
  assert.match(compose, /127\.0\.0\.1:\$\{VNX03_WP_PORT/u);
  assert.match(compose, /internal: true/u);
  assert.doesNotMatch(compose, /privileged:/u);
  assert.doesNotMatch(compose, /docker\.sock/u);
  assert.doesNotMatch(compose, /SECURE_LEAD_GATEWAY_MODE: disabled/u);
  assert.match(compose, /SECURE_LEAD_GATEWAY_MODE: enforced/u);
  assert.match(compose, /AI_ORCHESTRATOR_WORKER_ENABLED: "0"/u);
  assert.match(compose, /AI_EXTERNAL_PROVIDERS_ENABLED: "false"/u);
  assert.match(compose, /WEBSITE_LEAD_MODE: disabled/u);
  assert.match(provision, /FAI_CRM_VNX03_EPHEMERAL_TEST_ONLY_V1/u);
  assert.match(provision, /Number\(migrations\[0\]\?\.count\), 43/u);
});

test('VNX-03 positive path uses authentic WPForms UI, HTTPS and bounded production components', () => {
  const browser = source('tests/vnx03/wpforms-https-e2e.spec.ts');
  const pluginSetup = source('tests/vnx03/setup-wordpress.php');
  const gateway = source('tests/vnx03/tls-gateway.mjs');
  const connectorClient = source(
    'integrations/wordpress/fai-secure-lead-connector/includes/class-gateway-client.php',
  );
  const compose = source('tests/vnx03/docker-compose.yml');

  assert.match(pluginSetup, /wpforms\(\)->form->add/u);
  assert.match(pluginSetup, /\[wpforms id="900001"/u);
  assert.match(browser, /page\.locator\(`#wpforms-submit-\$\{input\.formId\}`\)\.click\(\)/u);
  assert.doesNotMatch(browser, /wpforms_process_complete/u);
  assert.match(browser, /'harness', 'npm', 'run', 'vnx01:lead-intake'/u);
  assert.match(browser, /after_granted_projection/u);
  assert.match(browser, /after_denied_projection/u);
  assert.match(gateway, /https\.createServer/u);
  assert.match(gateway, /minVersion: 'TLSv1\.2'/u);
  assert.match(connectorClient, /CURLOPT_SSL_VERIFYPEER => true/u);
  assert.match(connectorClient, /CURLOPT_SSL_VERIFYHOST => 2/u);
  assert.match(compose, /SECURE_LEAD_GATEWAY_MODE: enforced/u);
});

test('VNX-03 exercises every required negative and recovery control', () => {
  const browser = source('tests/vnx03/wpforms-https-e2e.spec.ts');
  const wordpressConfig = source('tests/vnx03/wordpress-config.php');

  for (const scenario of [
    'disabled',
    'excluded',
    'privacy-missing',
    'bad_hmac',
    'wrong_hostname',
    'untrusted_ca',
    'drop_after_admission',
  ]) {
    assert.match(`${browser}\n${wordpressConfig}`, new RegExp(scenario, 'u'));
  }
  assert.match(browser, /compose\(\['stop'.*'gateway'\]\)/u);
  assert.match(browser, /waitForRetry/u);
  assert.match(browser, /'plugin', 'deactivate', 'fai-secure-lead-connector'/u);
  assert.match(browser, /'plugin', 'activate', 'fai-secure-lead-connector'/u);
  assert.match(browser, /responseLossReplayRequests: 2/u);
  assert.match(browser, /plaintextMarker/u);
});

test('VNX-03 is a mandatory CI gate with sanitized evidence', () => {
  const workflow = source('.github/workflows/ci.yml');
  const jobStart = workflow.indexOf('  vnx03-wpforms-https-e2e:');
  assert.ok(jobStart >= 0, 'VNX03_CI_JOB_MISSING');
  const job = workflow.slice(jobStart);

  assert.match(job, /VNX-03 authentic WPForms HTTPS end-to-end/u);
  assert.match(job, /VNX03_SYNTHETIC_E2E_CONFIRMED: "1"/u);
  assert.match(job, /run: npm run test:vnx03:e2e/u);
  assert.match(job, /actions\/upload-artifact@v4/u);
  assert.match(job, /if-no-files-found: error/u);
  assert.doesNotMatch(job, /continue-on-error/u);
  assert.doesNotMatch(job, /if:.*vnx03.*branch/iu);
});
