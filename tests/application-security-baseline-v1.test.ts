import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import {
  applicationFeatureGateCodes,
  applicationSecurityHeaders,
  containmentMode,
  environmentFeatureGateEnabled,
  isAllowedMutationOrigin,
  securityHeadersMode,
} from '../src/lib/application-security-policy';
import {
  applicationFeatureGateSnapshot,
  isApplicationFeatureEnabled,
} from '../src/lib/application-feature-gates';
import {
  privilegedStepUpEnvironmentKey,
  PRIVILEGED_STEP_UP_KEY_PURPOSE,
} from '../src/lib/application-key-registry';
import {
  loginThrottleConfiguration,
  loginThrottleKeyDigest,
  loginThrottleRuntime,
} from '../src/lib/login-throttle';
import {
  createPrivilegedStepUpToken,
  privilegedStepUpKeyDigest,
  PRIVILEGED_STEP_UP_TTL_SECONDS,
  verifyPrivilegedStepUpToken,
} from '../src/lib/privileged-step-up-token';

test('N03 containment modes accept only explicit canonical values', () => {
  assert.equal(containmentMode('disabled', 'TEST'), 'disabled');
  assert.equal(containmentMode('enforced', 'TEST'), 'enforced');
  for (const value of [undefined, '', 'enabled', 'Disabled', ' enforced', 'enforced ']) {
    assert.throws(() => containmentMode(value, 'TEST'), /TEST_NOT_CANONICAL/);
  }
  assert.equal(securityHeadersMode(undefined), 'report-only');
  assert.equal(securityHeadersMode('invalid'), 'report-only');
  assert.equal(securityHeadersMode('enforced'), 'enforced');
});

test('N03 feature gates require exact ENV true and a matching enabled database row', async () => {
  for (const code of applicationFeatureGateCodes) {
    const environmentName = `FEATURE_${code}_ENABLED`;
    assert.equal(environmentFeatureGateEnabled(code, { [environmentName]: 'true' }), true);
    for (const value of [undefined, '', '1', 'TRUE', ' true', 'false']) {
      assert.equal(environmentFeatureGateEnabled(code, { [environmentName]: value }), false);
    }
  }

  let databaseReads = 0;
  const db = {
    applicationFeatureGate: {
      findUnique: async () => { databaseReads += 1; return { enabled: true }; },
      findMany: async () => [
        { code: 'INTEGRATIONS', enabled: true, version: 3 },
        { code: 'PAYMENTS', enabled: false, version: 1 },
      ],
    },
  };
  assert.equal(await isApplicationFeatureEnabled(db as never, 'INTEGRATIONS', {}), false);
  assert.equal(databaseReads, 0, 'ENV OFF must short-circuit before touching PostgreSQL');
  assert.equal(await isApplicationFeatureEnabled(db as never, 'INTEGRATIONS', { FEATURE_INTEGRATIONS_ENABLED: 'true' }), true);
  const snapshot = await applicationFeatureGateSnapshot(db as never, {
    FEATURE_INTEGRATIONS_ENABLED: 'true',
    FEATURE_PAYMENTS_ENABLED: 'true',
    FEATURE_AI_EGRESS_ENABLED: 'true',
  });
  assert.deepEqual(snapshot.find(({ code }) => code === 'INTEGRATIONS'), {
    code: 'INTEGRATIONS', databaseEnabled: true, environmentEnabled: true, effectiveEnabled: true, version: 3,
  });
  assert.equal(snapshot.find(({ code }) => code === 'PAYMENTS')?.effectiveEnabled, false);
  assert.equal(snapshot.find(({ code }) => code === 'AI_EGRESS')?.effectiveEnabled, false);
  const unavailableDb = {
    applicationFeatureGate: {
      findUnique: async () => { throw new Error('synthetic unavailable'); },
      findMany: async () => { throw new Error('synthetic unavailable'); },
    },
  };
  assert.equal(await isApplicationFeatureEnabled(unavailableDb as never, 'INTEGRATIONS', { FEATURE_INTEGRATIONS_ENABLED: 'true' }), false);
  assert.ok((await applicationFeatureGateSnapshot(unavailableDb as never, { FEATURE_INTEGRATIONS_ENABLED: 'true' })).every(({ effectiveEnabled }) => !effectiveEnabled));
});

test('N03 privileged mutation origin check is strict and same-origin only', () => {
  assert.equal(isAllowedMutationOrigin({
    origin: 'https://crm.example.test',
    configuredOrigin: 'https://crm.example.test',
    secFetchSite: 'same-origin',
  }), true);
  assert.equal(isAllowedMutationOrigin({
    origin: 'https://crm.example.test',
    configuredOrigin: 'https://crm.example.test',
  }), true);
  for (const input of [
    { origin: null, configuredOrigin: 'https://crm.example.test' },
    { origin: 'https://evil.example', configuredOrigin: 'https://crm.example.test' },
    { origin: 'https://crm.example.test/path', configuredOrigin: 'https://crm.example.test' },
    { origin: 'https://crm.example.test', configuredOrigin: 'https://crm.example.test/path' },
    { origin: 'https://crm.example.test', configuredOrigin: 'https://crm.example.test', secFetchSite: 'cross-site' },
  ]) assert.equal(isAllowedMutationOrigin(input), false);
});

test('N03 security headers are global, report-only by default, and explicitly enforceable', () => {
  const reportOnly = Object.fromEntries(applicationSecurityHeaders('report-only').map(({ key, value }) => [key, value]));
  assert.match(reportOnly['Content-Security-Policy-Report-Only'], /default-src 'self'/);
  assert.equal(reportOnly['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.equal(reportOnly['X-Content-Type-Options'], 'nosniff');
  assert.equal(reportOnly['X-Frame-Options'], 'DENY');
  assert.equal(reportOnly['Referrer-Policy'], 'no-referrer');
  const enforced = Object.fromEntries(applicationSecurityHeaders('enforced').map(({ key, value }) => [key, value]));
  assert.ok(enforced['Content-Security-Policy']);
  assert.equal(enforced['Content-Security-Policy-Report-Only'], undefined);
  assert.match(readFileSync('next.config.ts', 'utf8'), /source: '\/:path\*'/);
  assert.match(readFileSync('Dockerfile.prod.example', 'utf8'), /ARG SECURITY_HEADERS_MODE=report-only/);
  assert.match(readFileSync('docker-compose.prod.example.yml', 'utf8'), /SECURITY_HEADERS_MODE: \$\{SECURITY_HEADERS_MODE:-report-only\}/);
});

test('N03 step-up tokens are bounded, session-bound, rotation-aware, and tamper-evident', () => {
  const key = { version: 7, secret: 'a'.repeat(32) };
  const token = createPrivilegedStepUpToken({
    key, userId: 'synthetic-user', sessionToken: 'synthetic-session-a', nowSeconds: 10_000,
  });
  assert.equal(verifyPrivilegedStepUpToken({ token, key, expectedUserId: 'synthetic-user', sessionToken: 'synthetic-session-a', nowSeconds: 10_001 }), true);
  assert.equal(verifyPrivilegedStepUpToken({ token, key, expectedUserId: 'other-user', sessionToken: 'synthetic-session-a', nowSeconds: 10_001 }), false);
  assert.equal(verifyPrivilegedStepUpToken({ token, key, expectedUserId: 'synthetic-user', sessionToken: 'synthetic-session-b', nowSeconds: 10_001 }), false);
  assert.equal(verifyPrivilegedStepUpToken({ token, key: { ...key, version: 8 }, expectedUserId: 'synthetic-user', sessionToken: 'synthetic-session-a', nowSeconds: 10_001 }), false);
  assert.equal(verifyPrivilegedStepUpToken({ token, key: { ...key, secret: 'b'.repeat(32) }, expectedUserId: 'synthetic-user', sessionToken: 'synthetic-session-a', nowSeconds: 10_001 }), false);
  const signatureOffset = token.lastIndexOf('.') + 1;
  const signature = token.slice(signatureOffset);
  const significantMutation = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.equal(verifyPrivilegedStepUpToken({ token: `${token.slice(0, signatureOffset)}${significantMutation}`, key, expectedUserId: 'synthetic-user', sessionToken: 'synthetic-session-a', nowSeconds: 10_001 }), false);

  const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const canonicalLastIndex = base64UrlAlphabet.indexOf(signature.at(-1) ?? '');
  assert.equal(canonicalLastIndex % 4, 0);
  const nonCanonicalSignature = `${signature.slice(0, -1)}${base64UrlAlphabet[canonicalLastIndex + 1]}`;
  assert.deepEqual(Buffer.from(nonCanonicalSignature, 'base64url'), Buffer.from(signature, 'base64url'));
  assert.equal(verifyPrivilegedStepUpToken({ token: `${token.slice(0, signatureOffset)}${nonCanonicalSignature}`, key, expectedUserId: 'synthetic-user', sessionToken: 'synthetic-session-a', nowSeconds: 10_001 }), false);
  assert.equal(verifyPrivilegedStepUpToken({ token, key, expectedUserId: 'synthetic-user', sessionToken: 'synthetic-session-a', nowSeconds: 10_000 + PRIVILEGED_STEP_UP_TTL_SECONDS }), false);
  assert.equal(privilegedStepUpKeyDigest(key.secret).length, 32);
});

test('N03 key registry accepts only a strong, positive, versioned environment key', () => {
  assert.deepEqual(privilegedStepUpEnvironmentKey({
    PRIVILEGED_STEP_UP_KEY_VERSION: '3', PRIVILEGED_STEP_UP_SECRET: 's'.repeat(32),
  }), { version: 3, secret: 's'.repeat(32) });
  for (const environment of [
    {},
    { PRIVILEGED_STEP_UP_KEY_VERSION: '0', PRIVILEGED_STEP_UP_SECRET: 's'.repeat(32) },
    { PRIVILEGED_STEP_UP_KEY_VERSION: '01', PRIVILEGED_STEP_UP_SECRET: 's'.repeat(32) },
    { PRIVILEGED_STEP_UP_KEY_VERSION: '1', PRIVILEGED_STEP_UP_SECRET: 'short' },
  ]) assert.equal(privilegedStepUpEnvironmentKey(environment), null);
  assert.equal(PRIVILEGED_STEP_UP_KEY_PURPOSE, 'PRIVILEGED_STEP_UP');
  const registry = readFileSync('src/lib/application-key-registry.ts', 'utf8');
  assert.match(registry, /role: 'admin', active: true, deletedAt: null/);
  assert.match(registry, /\$executeRaw\(Prisma\.sql`SELECT pg_advisory_xact_lock/);
  assert.doesNotMatch(registry, /\$queryRaw\(Prisma\.sql`SELECT pg_advisory_xact_lock/);
  assert.match(registry, /SELECT CURRENT_TIMESTAMP AS now/);
});

test('N03 login throttle is explicit, bounded, and stores only a keyed digest', () => {
  const enabledEnvironment = {
    LOGIN_THROTTLE_MODE: 'enforced',
    LOGIN_THROTTLE_MAX_FAILURES: '5',
    LOGIN_THROTTLE_WINDOW_SECONDS: '900',
    LOGIN_THROTTLE_BLOCK_SECONDS: '1200',
    AUTH_SECRET: 'z'.repeat(32),
  };
  assert.deepEqual(loginThrottleConfiguration(enabledEnvironment), {
    maxFailures: 5, windowSeconds: 900, blockSeconds: 1200,
  });
  const runtime = loginThrottleRuntime(' Admin@Example.Test ', enabledEnvironment);
  assert.equal(runtime?.mode, 'enforced');
  if (!runtime || runtime.mode !== 'enforced') assert.fail('enforced throttle unavailable');
  assert.match(runtime.keyDigest, /^[0-9a-f]{64}$/);
  assert.equal(runtime.keyDigest, loginThrottleKeyDigest('admin@example.test', 'z'.repeat(32)));
  assert.doesNotMatch(runtime.keyDigest, /admin|example/i);
  assert.deepEqual(loginThrottleRuntime('any@example.test', { LOGIN_THROTTLE_MODE: 'disabled' }), { mode: 'disabled' });
  assert.equal(loginThrottleRuntime('any@example.test', { ...enabledEnvironment, AUTH_SECRET: 'short' }), null);
  assert.throws(() => loginThrottleRuntime('any@example.test', { LOGIN_THROTTLE_MODE: 'invalid' }));
});

test('N03 protects every privileged user mutation behind AuthZ and step-up', () => {
  const source = readFileSync('src/lib/user-actions.ts', 'utf8');
  const actions = [
    ['createInternalUser', 'USER_CREATE'],
    ['activateInternalUser', 'USER_ACTIVATE'],
    ['updateInternalUserRole', 'USER_ROLE_UPDATE'],
    ['deactivateInternalUser', 'USER_DEACTIVATE'],
    ['updateUserPermissionOverrides', 'USER_PERMISSION_OVERRIDE_UPDATE'],
    ['resetUserPermissionOverrides', 'USER_PERMISSION_OVERRIDE_RESET'],
  ] as const;
  for (const [action, code] of actions) {
    const body = source.slice(source.indexOf(`export async function ${action}`));
    assert.match(body.slice(0, body.indexOf('\n}')), /requirePermission\('user\.write'\)/);
    assert.match(body.slice(0, body.indexOf('\n}')), new RegExp(`requirePrivilegedMutation\\(s, '${code}'\\)`));
  }
  const service = readFileSync('src/lib/user-privilege-service.ts', 'utf8');
  assert.match(service, /requireAdminActor/);
  assert.match(service, /actorUser\.role !== 'admin'/);
});

test('N03 inventories AI control-plane decisions while preserving emergency stop availability', () => {
  const actions = readFileSync('src/lib/actions.ts', 'utf8');
  assert.match(actions, /requirePermission\('ai_agents\.write'\)[\s\S]{0,160}requirePrivilegedMutation\(s, 'AI_AGENT_CONFIG_UPDATE'\)/);
  assert.match(actions, /requirePermission\('settings\.manage'\)[\s\S]{0,160}requirePrivilegedMutation\(s, 'AI_CONTROL_SETTING_UPDATE'\)/);

  const decisions = readFileSync('src/lib/ai-execution-authorization-actions.ts', 'utf8');
  for (const code of ['AI_EXECUTION_APPROVE', 'AI_EXECUTION_REJECT', 'AI_EXECUTION_INFORMATION_REQUEST', 'AI_EXECUTION_REVOKE']) {
    assert.match(decisions, new RegExp(`requirePrivilegedMutation\\(session, '${code}'\\)`));
  }
  assert.match(decisions, /cancelAiExecutionRequestAndRedirect[\s\S]*requireSession\(\)/);

  const orchestrator = readFileSync('src/lib/ai-orchestrator/admin-ui-actions-v1.ts', 'utf8');
  assert.match(orchestrator, /requirePrivilegedMutation\(session, 'AI_ORCHESTRATOR_GLOBAL_POLICY_UPDATE'\)/);
  assert.match(orchestrator, /requirePrivilegedMutation\(session, 'AI_ORCHESTRATOR_SCOPE_POLICY_UPDATE'\)/);
  const emergency = orchestrator.slice(orchestrator.indexOf('export async function engageAiOrchestratorEmergencyStopAction'));
  assert.doesNotMatch(emergency, /requirePrivilegedMutation/);
});

test('N03 authentication cookies and login lookup use hardened defaults', () => {
  const login = readFileSync('src/lib/login-actions.ts', 'utf8');
  assert.match(login, /httpOnly: true/);
  assert.match(login, /sameSite: 'strict'/);
  assert.match(login, /secure: process\.env\.NODE_ENV === 'production'/);
  assert.match(login, /priority: 'high'/);
  assert.match(login, /deletedAt: null/);
  assert.match(login, /dummyPasswordHash/);
  assert.match(login, /normalizedEmail\.length > 254/);
  assert.match(login, /password\.length > 1024/);
  const privileged = readFileSync('src/lib/privileged-access.ts', 'utf8');
  assert.match(privileged, /PRIVILEGED_STEP_UP_TTL_SECONDS/);
  assert.doesNotMatch(privileged, /console\.|passwordHash.*after|secret.*after|token.*after/);
  const page = readFileSync('src/app/settings/security/page.tsx', 'utf8');
  const action = readFileSync('src/lib/privileged-access-actions.ts', 'utf8');
  const nav = readFileSync('src/components/nav-links.tsx', 'utf8');
  assert.match(page, /requireAnyPermission\(\[\.\.\.privilegedAccessPermissions\]\)/);
  assert.match(action, /requireAnyPermission\(\[\.\.\.privilegedAccessPermissions\]\)/);
  assert.match(nav, /requiredAnyPermissions: \[\.\.\.privilegedAccessPermissions\]/);
});

test('N03 migration 34 is additive, seeds only OFF gates, and preserves dormant examples', () => {
  assert.equal(readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).length, 38);
  const migration = readFileSync('prisma/migrations/20260816120000_privileged_access_application_security_baseline_v1/migration.sql', 'utf8');
  assert.doesNotMatch(migration, /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/im);
  assert.match(migration, /CREATE TABLE "ApplicationFeatureGate"/);
  assert.match(migration, /CREATE TABLE "ApplicationKeyVersion"/);
  assert.match(migration, /CREATE TABLE "LoginThrottleBucket"/);
  assert.equal(migration.match(/\('[A-Z_]+', FALSE, 1, CURRENT_TIMESTAMP\)/g)?.length, 6);
  assert.match(migration, /WHERE "status" = 'ACTIVE'/);
  assert.match(migration, /octet_length\("keyDigest"\) = 32/);
  for (const file of ['.env.example', '.env.production.example', '.github/workflows/ci.yml', 'scripts/smoke-docker-prod.sh']) {
    const contents = readFileSync(file, 'utf8');
    assert.match(contents, /PRIVILEGED_ACCESS_MODE[=:] ?["']?disabled/);
    assert.match(contents, /LOGIN_THROTTLE_MODE[=:] ?["']?disabled/);
    for (const code of applicationFeatureGateCodes) {
      assert.match(contents, new RegExp(`FEATURE_${code}_ENABLED[=:] ?["']?false`));
    }
  }
});
