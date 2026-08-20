import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import {
  createRegistrySessionToken,
  digestRegistrySessionToken,
  internalSessionMode,
  parseRegistrySessionToken,
} from '../src/lib/session';

test('N02 mode accepts only exact values', () => {
  assert.equal(internalSessionMode('legacy'), 'legacy');
  assert.equal(internalSessionMode('registry'), 'registry');
  const saved = process.env.INTERNAL_SESSION_MODE;
  delete process.env.INTERNAL_SESSION_MODE;
  assert.throws(() => internalSessionMode());
  process.env.INTERNAL_SESSION_MODE = saved;
  for (const value of ['', ' legacy', 'LEGACY', 'registry ']) assert.throws(() => internalSessionMode(value));
});
test('N02 tokens are fresh canonical 32-byte values', () => {
  const a = createRegistrySessionToken(); const b = createRegistrySessionToken();
  assert.match(a.token, /^v1\.[A-Za-z0-9_-]{43}$/); assert.equal(a.bytes.length, 32); assert.notEqual(a.token, b.token);
});
test('N02 parser rejects noncanonical values', () => {
  const good = createRegistrySessionToken().token;
  assert.equal(parseRegistrySessionToken(good)?.length, 32);
  for (const value of [undefined, '', good + '=', good + ' ', good.slice(0, -1), good.replace('v1.', 'v2.')]) assert.equal(parseRegistrySessionToken(value), null);
});
test('N02 hashes raw bytes to 32 bytes', async () => {
  const { bytes } = createRegistrySessionToken();
  assert.equal((await digestRegistrySessionToken(bytes)).length, 32);
  await assert.rejects(digestRegistrySessionToken(bytes.slice(1)));
});
test('N02 middleware is syntactic only', () => {
  const source = readFileSync('src/middleware.ts', 'utf8');
  assert.match(source, /isCanonicalRegistrySessionCookie/); assert.doesNotMatch(source, /prisma|InternalSession/);
  const auth = readFileSync('src/lib/auth.ts', 'utf8'); assert.match(auth, /resolveInternalSession/);
  const instrumentation = readFileSync('src/instrumentation.ts', 'utf8');
  assert.match(instrumentation, /NEXT_RUNTIME !== ["']nodejs["']/);
  assert.match(instrumentation, /internalSessionMode\(\) !== ["']registry["']/);
  assert.match(instrumentation, /assertRegistryActivationReady\(prisma\)/);
});
test('N02 migration and privacy are exact', () => {
  assert.equal(readdirSync('prisma/migrations').length, 38);
  const sql = readFileSync('prisma/migrations/20260815120000_internal_session_registry_revocation_v1/migration.sql', 'utf8');
  assert.match(sql, /octet_length\("tokenDigest"\) = 32/); assert.match(sql, /ON DELETE CASCADE/); assert.match(sql, /ON DELETE SET NULL/);
  assert.doesNotMatch(sql, /^\s*(?:DROP|DELETE|UPDATE|INSERT)\b/im);
  const registry = readFileSync('src/lib/internal-session-registry.ts', 'utf8'); assert.doesNotMatch(registry, /console\.|passwordHash|email|userAgent|ipAddress/);
});
test('N02 examples are dormant legacy', () => {
  for (const file of ['.env.example', '.env.production.example', '.github/workflows/ci.yml', 'scripts/smoke-docker-prod.sh']) assert.match(readFileSync(file, 'utf8'), /INTERNAL_SESSION_MODE[=:] ?["']?legacy/);
});
