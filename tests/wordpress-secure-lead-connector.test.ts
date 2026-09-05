import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/lib/canonical-json';
import { parseLeadSubmittedEventV1 } from '../src/lib/lead-event-contract';
import {
  createSecureLeadGatewaySignature,
  createSecureLeadGatewaySignedBytes,
  parseCanonicalSecureLeadGatewayEnvelope,
} from '../src/lib/secure-lead-gateway-protocol';

const root = resolve(import.meta.dirname, '..');
const pluginRoot = resolve(root, 'integrations/wordpress/fai-secure-lead-connector');
const phpBinary = process.env.PHP_BINARY ?? 'php';
const phpProbe = spawnSync(phpBinary, ['-r', 'echo PHP_VERSION;'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
const phpAvailable = phpProbe.status === 0;
// Local offline Docker runs can supply the output of the same PHP fixture.
const offlinePhpFixture = process.env.VNX02_PHP_FIXTURE_JSON;

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

test('VNX-02 PHP fixture is accepted byte-for-byte by N10 and N12 TypeScript', {
  skip: phpAvailable || offlinePhpFixture ? false : 'PHP runtime unavailable; the dedicated CI PHP gate remains mandatory.',
}, () => {
  const execution = offlinePhpFixture ? { status: 0, stdout: offlinePhpFixture, stderr: '' } : spawnSync(phpBinary, ['tests/php/vnx02-cross-language-fixture.php'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(execution.status, 0, execution.stderr || 'PHP fixture failed without stderr.');
  const fixture = JSON.parse(execution.stdout) as {
    body: string;
    businessKeyDigest: string;
    payloadHash: string;
    bodyHash: string;
    keyId: string;
    timestamp: string;
    nonce: string;
    signedBytesBase64: string;
    signature: string;
  };
  const rawBody = Buffer.from(fixture.body, 'utf8');
  const parsed = parseCanonicalSecureLeadGatewayEnvelope(rawBody);
  assert.deepEqual(parseLeadSubmittedEventV1(JSON.parse(fixture.body)), parsed);
  assert.equal(canonicalJson(parsed), fixture.body);
  assert.equal(parsed.idempotency.keyDigest, fixture.businessKeyDigest);
  assert.equal(parsed.idempotency.payloadHash, fixture.payloadHash);
  assert.equal(
    fixture.bodyHash,
    createHash('sha256').update(rawBody).digest('hex'),
  );
  assert.equal(parsed.source.systemCode, 'WORDPRESS');
  assert.equal(parsed.source.submissionId, 'WPFORM:900001:ENTRY:700001');
  assert.equal(parsed.privacy.service.noticeCode, 'SYNTHETIC_PRIVACY_NOTICE');
  assert.equal(parsed.privacy.marketing.decision, 'DENIED');
  assert.equal(parsed.payload.firstName, 'Café 😀');
  assert.equal(parsed.payload.phone, '+393330000010');
  assert.equal(parsed.payload.requestedAmount?.minorUnits, Number.MAX_SAFE_INTEGER);

  const signedBytes = createSecureLeadGatewaySignedBytes({
    keyId: fixture.keyId,
    timestamp: fixture.timestamp,
    nonce: fixture.nonce,
  }, rawBody);
  assert.deepEqual(signedBytes, Buffer.from(fixture.signedBytesBase64, 'base64'));
  const secret = Buffer.from('11'.repeat(32), 'hex');
  assert.equal(createSecureLeadGatewaySignature(secret, signedBytes), fixture.signature);
});

test('VNX-02 is an isolated installable plugin with no browser or CRM runtime surface', () => {
  const files = filesBelow(pluginRoot);
  const relative = files.map((path) => path.slice(pluginRoot.length + 1).replaceAll('\\', '/')).sort();
  assert.ok(relative.includes('fai-secure-lead-connector.php'));
  assert.ok(relative.includes('readme.txt'));
  assert.ok(relative.includes('config.synthetic.example.php'));
  assert.equal(relative.some((path) => ['.js', '.mjs', '.cjs'].includes(extname(path))), false);

  const source = files
    .filter((path) => extname(path) === '.php')
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.match(source, /Plugin Name: FAI Secure Lead Connector/u);
  assert.match(source, /Version: 1\.0\.0/u);
  assert.match(source, /wpforms_process_complete/u);
  assert.match(source, /FAI_VNX02_CONNECTOR_CONFIG/u);
  assert.match(source, /enabled' => false/u);
  assert.match(source, /application\/vnd\.fai\.lead-event\.v1\+json/u);
  assert.match(source, /sodium_crypto_aead_xchacha20poly1305_ietf_encrypt/u);
  assert.match(source, /CURLOPT_PROTOCOLS => CURLPROTO_HTTPS/u);
  assert.doesNotMatch(source, /wp_remote_(?:post|get|request)/u);
  assert.doesNotMatch(source, /add_(?:menu|submenu)_page|register_rest_route|wp_enqueue_script/u);
  assert.doesNotMatch(source, /x-fai-webhook-secret|WEBSITE_LEAD_WEBHOOK_SECRET/u);
  assert.doesNotMatch(source, /finanzaagevolaimpresa\.it/u);
  assert.doesNotMatch(source, /getMessage\(\)|->last_error|curl_error\(/u);
});

test('VNX-02 keeps migration count at 43 and makes the pre-N04 guide unusable', () => {
  const migrations = readdirSync(resolve(root, 'prisma/migrations'))
    .filter((name) => statSync(resolve(root, 'prisma/migrations', name)).isDirectory());
  assert.equal(migrations.length, 43);
  const legacy = readFileSync(resolve(root, 'docs/wordpress-wpforms-crm-integration.md'), 'utf8');
  assert.match(legacy, /percorso storico è revocato/u);
  assert.match(legacy, /non devono essere copiati, distribuiti, configurati/u);
  assert.doesNotMatch(legacy, /x-fai-webhook-secret|FAI_CRM_WEBHOOK_SECRET|wp_remote_post/u);
  assert.match(legacy, /enabled=false/u);
});

test('VNX-02 source fixes bounded retry, lease, body and response limits', () => {
  const queue = readFileSync(
    resolve(pluginRoot, 'includes/class-queue-store.php'),
    'utf8',
  );
  const gateway = readFileSync(
    resolve(pluginRoot, 'includes/class-gateway-client.php'),
    'utf8',
  );
  const contract = readFileSync(
    resolve(pluginRoot, 'includes/class-event-contract.php'),
    'utf8',
  );
  assert.match(queue, /MAXIMUM_BATCH_SIZE = 10/u);
  assert.match(queue, /LEASE_SECONDS = 60/u);
  assert.match(queue, /business_key_digest \(business_key_digest\)/u);
  assert.match(queue, /attempt_count<%d/u);
  assert.match(queue, /encrypted_body=''/u);
  assert.match(gateway, /MAXIMUM_ATTEMPTS = 5/u);
  assert.match(gateway, /array\(60, 300, 1800, 7200\)/u);
  assert.match(gateway, /TIMEOUT_MILLISECONDS = 4000/u);
  assert.match(gateway, /MAXIMUM_RESPONSE_BYTES = 512/u);
  assert.match(contract, /MAXIMUM_BODY_BYTES = 16384/u);
});

test('VNX-02 packaging creates one deterministic installable ZIP without key material', () => {
  const output = mkdtempSync(join(tmpdir(), 'vnx02-package-'));
  try {
    const first = spawnSync(process.execPath, [
      'tools/package-vnx02-wordpress-connector.mjs', '--output', output,
    ], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(first.status, 0, first.stderr || 'First packaging run failed.');
    const artifactPath = join(output, 'fai-secure-lead-connector-1.0.0.zip');
    const firstBytes = readFileSync(artifactPath);
    assert.equal(firstBytes.readUInt32LE(0), 0x04034b50);
    const firstDigest = createHash('sha256').update(firstBytes).digest('hex');

    const second = spawnSync(process.execPath, [
      'tools/package-vnx02-wordpress-connector.mjs', '--output', output,
    ], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(second.status, 0, second.stderr || 'Second packaging run failed.');
    const secondBytes = readFileSync(artifactPath);
    assert.equal(createHash('sha256').update(secondBytes).digest('hex'), firstDigest);
    const printable = secondBytes.toString('latin1');
    assert.match(printable, /fai-secure-lead-connector\/fai-secure-lead-connector\.php/u);
    assert.match(printable, /fai-secure-lead-connector\/readme\.txt/u);
    assert.doesNotMatch(printable, /\.env|\.key|\.pem/u);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
