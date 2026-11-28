import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';

const recovery = Object.freeze({
  commit: '5055b107fed3d35d2a62e5cad273bd60a1c1f884',
  tree: 'ec07c32529e86869c877cf57b3542fb68a3fd736',
  imageId: 'sha256:bdb93253dc3c725a144b280040eed704f6671da602b7e30d50d791f3076ab7e2',
  archiveSha256: '91743e861fca7767be42bd193f97759e4e8b6ef8fb299fa36aa3210f982af2e5',
  artifactId: 15197050184, runId: 45994851134,
});
const phases = ['candidate-before', 'pr263-return', 'candidate-resumed'] as const;
type Phase = typeof phases[number];
type Actor = { userId: string; sessionId: string; name: string; email: string; cookie: string };
type PrivateState = { protocol: 'CALENDAR_RETURN_PRIVATE_V1'; actors: Actor[]; ledgerSha256: string; sessionsSha256: string };
type PhaseProof = { phase: Phase; imageId: string; authenticatedRequests: number; ledgerSha256: string; sessionsSha256: string;
  calendarOff: true; serviceGatesOff: true; sameAuthSecret: true; documentSha256: string; databaseId: string; databaseStarted: string;
  deniedPaths: string[]; denialDestination: '/dashboard'; sameCookieAfterDenials: true };
const deniedPaths = ['/settings/users', '/settings/roles'];

function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function hash64(value: unknown): asserts value is string { assert.equal(typeof value, 'string'); assert.match(value as string, /^[a-f0-9]{64}$/); }
function canonicalReceipt(value: unknown) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  assert.equal(row.protocol, 'PR140_RELEASE_R05');
  assert.equal(row.status, 'CI_SCHEMA78_OPERATIONAL_FLOW_COMPATIBLE_RETURN_PASS');
  assert.equal(row.synthetic, true); assert.equal(row.productionAdmitted, false); assert.equal(row.schema, 78);
  assert.equal(row.candidateCommit, recovery.commit); assert.equal(row.candidateTree, recovery.tree);
  assert.equal(row.candidateImageId, recovery.imageId); assert.equal(row.imageArchiveSha256, recovery.archiveSha256);
  return row;
}
function fixturePath() {
  const path = process.env.CALENDAR_RETURN_PRIVATE_FILE!, directory = process.env.RUNNER_TEMP!;
  assert(isAbsolute(path) && isAbsolute(directory));
  const remainder = relative(realpathSync(directory), resolve(path));
  assert(remainder && !remainder.startsWith('..') && !isAbsolute(remainder));
  assert.equal(basename(path), `fai-crm-r05-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-calendar-return-private.json`);
  return path;
}
function privateRead(path: string): unknown {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 128 * 1024);
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.uid, process.getuid!());
  return JSON.parse(readFileSync(path, 'utf8'));
}
function privateWrite(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
}
function state(): PrivateState {
  const value = privateRead(fixturePath()) as PrivateState;
  assert.equal(value.protocol, 'CALENDAR_RETURN_PRIVATE_V1');
  assert(Array.isArray(value.actors) && value.actors.length === 2);
  hash64(value.ledgerSha256); hash64(value.sessionsSha256);
  const tokens = new Set<string>(), sessions = new Set<string>();
  for (const actor of value.actors) {
    assert.match(actor.userId, /^calendar-return-[a-f0-9-]{36}$/);
    assert.match(actor.sessionId, /^[a-f0-9-]{36}$/);
    assert.match(actor.email, /^calendar-return-[a-f0-9-]{36}@invalid\.test$/);
    assert.match(actor.name, /^Calendar return synthetic (admin|commerciale) /);
    assert.match(actor.cookie, /^v1\.[A-Za-z0-9_-]{43}$/);
    tokens.add(actor.cookie); sessions.add(actor.sessionId);
  }
  assert.equal(tokens.size, 2); assert.equal(sessions.size, 2);
  return value;
}
function runtime(value: unknown, expected: string) {
  assert(value && typeof value === 'object');
  const row = value as { imageId: unknown; environment: unknown };
  assert.equal(row.imageId, expected);
  assert(Array.isArray(row.environment));
  const env = new Map<string, string>();
  for (const item of row.environment) {
    assert.equal(typeof item, 'string'); const at = item.indexOf('='); assert(at > 0);
    const key = item.slice(0, at); assert(!env.has(key)); env.set(key, item.slice(at + 1));
  }
  assert.equal(env.get('INTERNAL_SESSION_MODE'), 'registry');
  assert.equal(env.get('GOOGLE_CALENDAR_INTEGRATION_MODE'), 'disabled');
  assert.equal(env.get('FEATURE_INTEGRATIONS_ENABLED'), 'false');
  for (const gate of ['WORKFLOW_NATIVE_PREPARATION_MODE', 'WORKFLOW_SERVICE_EXECUTION_MODE', 'WORKFLOW_MARKETING_WITHDRAWAL_MODE']) {
    assert.equal(env.get(gate), 'disabled');
  }
  assert(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32);
  assert.equal(env.get('AUTH_SECRET'), process.env.AUTH_SECRET);
  assert.equal(env.get('AUTH_COOKIE_NAME'), process.env.AUTH_COOKIE_NAME);
  return expected;
}
async function stdinJson() {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) { const part = Buffer.from(chunk); bytes += part.length; assert(bytes <= 128 * 1024); chunks.push(part); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function ledger(db: PrismaClient) {
  const rows = await db.$queryRaw<Array<{ migration_name: string; checksum: string; finished_at: Date; rolled_back_at: Date | null; applied_steps_count: number }>>`
    SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name`;
  assert.equal(rows.length, 78);
  for (const row of rows) { hash64(row.checksum); assert(row.finished_at); assert.equal(row.rolled_back_at, null); assert.equal(row.applied_steps_count, 1); }
  return digest(rows);
}
async function sessions(db: PrismaClient) {
  const rows = await db.$queryRaw<Array<{ value: unknown }>>`SELECT json_build_object(
    'sessions',(SELECT coalesce(json_agg(to_jsonb(s) ORDER BY s.id),'[]') FROM "InternalSession" s),
    'users',(SELECT coalesce(json_agg(json_build_object('id',u.id,'role',u.role,'active',u.active,'deletedAt',u."deletedAt",
      'recordUpdateEpoch',u."recordUpdateEpoch",'selectiveLeadEpoch',u."selectiveLeadEpoch",'selectiveClientEpoch',u."selectiveClientEpoch",
      'selectivePracticeEpoch',u."selectivePracticeEpoch") ORDER BY u.id),'[]') FROM "User" u),
    'overrides',(SELECT coalesce(json_agg(to_jsonb(o) ORDER BY o.id),'[]') FROM "UserPermissionOverride" o),
    'continuity',(SELECT coalesce(json_agg(to_jsonb(a) ORDER BY a."createdAt",a.id),'[]') FROM "AuditLog" a
      WHERE a."entityType"='InternalSessionRegistry' AND a."entityId"='registry')) AS value`;
  assert.equal(rows.length, 1); return digest(rows[0].value);
}
async function verifyState(db: PrismaClient, value: PrivateState) {
  const { resolveInternalSession, assertRegistryStartupReady } = await import('../../src/lib/internal-session-registry');
  await assertRegistryStartupReady(db);
  for (const actor of value.actors) {
    const session = await resolveInternalSession(db, actor.cookie);
    assert(session && session.id === actor.sessionId && session.userId === actor.userId && session.expiresAt > new Date());
  }
  assert.equal(await ledger(db), value.ledgerSha256, 'Migration ledger changed during return');
  assert.equal(await sessions(db), value.sessionsSha256, 'Live session, revocation, expiry or user epoch changed during return');
}
async function prepare(db: PrismaClient) {
  const { createRegistryLoginSession, REGISTRY_ACTIVATION_ENTITY, REGISTRY_ACTIVATION_RECEIPT } = await import('../../src/lib/internal-session-registry');
  const { createRegistrySessionToken, digestRegistrySessionToken } = await import('../../src/lib/session');
  assert.equal(await db.auditLog.count({ where: { entityType: REGISTRY_ACTIVATION_ENTITY, entityId: 'registry' } }), 0);
  const actors: Actor[] = [];
  for (const role of ['admin', 'commerciale'] as const) {
    const id = 'calendar-return-' + randomUUID(), name = `Calendar return synthetic ${role} ${randomUUID()}`;
    await db.user.create({ data: { id, name, email: id + '@invalid.test', role, active: true, passwordHash: 'UNUSABLE-SYNTHETIC-NO-LOGIN' } });
    const token = createRegistrySessionToken();
    const session = await createRegistryLoginSession(db, { userId: id, tokenDigest: await digestRegistrySessionToken(token.bytes) });
    assert(session); actors.push({ userId: id, name, email: id + '@invalid.test', sessionId: session.id, cookie: token.token });
  }
  await db.auditLog.create({ data: { actorId: actors[0].userId, event: REGISTRY_ACTIVATION_RECEIPT,
    entityType: REGISTRY_ACTIVATION_ENTITY, entityId: 'registry', after: { enabled: true, version: 1, mode: 'registry', synthetic: true } } });
  const value: PrivateState = { protocol: 'CALENDAR_RETURN_PRIVATE_V1', actors,
    ledgerSha256: await ledger(db), sessionsSha256: await sessions(db) };
  privateWrite(fixturePath(), value); await verifyState(db, value);
}
async function probe(db: PrismaClient, phase: Phase) {
  assert(phases.includes(phase)); const value = state(); await verifyState(db, value);
  const imageId = runtime(await stdinJson(), phase === 'pr263-return' ? recovery.imageId : process.env.CALENDAR_RETURN_CANDIDATE_IMAGE_ID!);
  const origin = new URL(process.env.PRACTICE_READINESS_BROWSER_ORIGIN!);
  assert.equal(origin.protocol, 'https:'); assert.equal(origin.hostname, '127.0.0.1'); assert.equal(origin.port, '13000');
  assert.equal(origin.username, ''); assert.equal(origin.password, ''); assert.equal(origin.pathname, '/');
  assert.match(process.env.AUTH_COOKIE_NAME!, /^[A-Za-z0-9_]+$/);
  for (const actor of value.actors) {
    const response = await fetch(new URL('/settings/account', origin), { redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { cookie: `${process.env.AUTH_COOKIE_NAME}=${actor.cookie}` } });
    assert.equal(response.status, 200, `Authenticated account HTTP failed in ${phase}`);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
    assert(!(response.headers.get('set-cookie') ?? '').includes(process.env.AUTH_COOKIE_NAME + '='), 'Existing cookie was replaced');
    const html = await response.text(); assert(html.length < 4 * 1024 * 1024);
    assert(html.includes('Il mio account') && html.includes(actor.email) && html.includes(actor.name), 'Account identity missing from HTTP response');
  }
  // Next can stream a redirect after HTTP headers. Let the already installed CI
  // browser execute that redirect and prove its destination, without interpreting
  // arbitrary body text as a denial. No trace, HTML, cookies or screenshots persist.
  const spki = process.env.PR140_CI_CERT_SPKI!; assert.match(spki, /^[A-Za-z0-9+/]{43}=$/);
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors-spki-list=' + spki] });
  try {
    const actor = value.actors[1]; assert(actor.name.startsWith('Calendar return synthetic commerciale '));
    const context = await browser.newContext();
    await context.addCookies([{ name: process.env.AUTH_COOKIE_NAME!, value: actor.cookie,
      url: origin.toString(), httpOnly: true, secure: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    for (const path of deniedPaths) {
      await page.goto(new URL(path, origin).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForURL(new URL('/dashboard', origin).toString(), { timeout: 30_000 });
      assert.equal(page.url(), new URL('/dashboard', origin).toString());
      assert.equal((await context.cookies()).find(cookie => cookie.name === process.env.AUTH_COOKIE_NAME)?.value, actor.cookie);
    }
    await context.close();
  } finally { await browser.close(); }
  await verifyState(db, value);
  const documentSha256 = process.env.CALENDAR_RETURN_DOCUMENT_SHA!; hash64(documentSha256);
  const databaseId = process.env.CALENDAR_RETURN_DATABASE_ID!; hash64(databaseId);
  const databaseStarted = process.env.CALENDAR_RETURN_DATABASE_STARTED!; assert(Number.isFinite(Date.parse(databaseStarted)));
  const proof: PhaseProof = { phase, imageId, authenticatedRequests: 2, ledgerSha256: value.ledgerSha256,
    sessionsSha256: value.sessionsSha256, calendarOff: true, serviceGatesOff: true, sameAuthSecret: true,
    documentSha256, databaseId, databaseStarted, deniedPaths, denialDestination: '/dashboard', sameCookieAfterDenials: true };
  privateWrite(fixturePath() + '.' + phase + '.json', proof);
}
async function archive() {
  const dir = realpathSync(process.env.CALENDAR_RETURN_ARTIFACT_DIR!);
  const receiptPath = join(dir, 'release-receipt.json'), archivePath = join(dir, 'release-images.tar.gz');
  for (const path of [receiptPath, archivePath]) {
    const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(relative(dir, realpathSync(path)), basename(path));
  }
  assert(lstatSync(receiptPath).size < 128 * 1024);
  const receipt = canonicalReceipt(JSON.parse(readFileSync(receiptPath, 'utf8')));
  const stream = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(archivePath)) { bytes += chunk.length; assert(bytes < 2 * 1024 ** 3); stream.update(chunk); }
  assert(bytes > 0); assert.equal(stream.digest('hex'), recovery.archiveSha256);
  privateWrite(fixturePath() + '.artifact.json', { ...recovery, receiptSha256: digest(receipt), archiveBytes: bytes });
}
function finish(path: string) {
  const current = state(), results = phases.map(phase => privateRead(fixturePath() + '.' + phase + '.json') as PhaseProof);
  for (let index = 0; index < phases.length; index++) {
    const row = results[index]; assert.equal(row.phase, phases[index]); assert.equal(row.authenticatedRequests, 2);
    assert.equal(row.imageId, index === 1 ? recovery.imageId : process.env.CALENDAR_RETURN_CANDIDATE_IMAGE_ID);
    assert.equal(row.ledgerSha256, current.ledgerSha256); assert.equal(row.sessionsSha256, current.sessionsSha256);
    assert.equal(row.calendarOff, true); assert.equal(row.serviceGatesOff, true); assert.equal(row.sameAuthSecret, true);
    assert.deepEqual(row.deniedPaths, deniedPaths); assert.equal(row.denialDestination, '/dashboard'); assert.equal(row.sameCookieAfterDenials, true);
    for (const key of ['documentSha256', 'databaseId', 'databaseStarted'] as const) assert.equal(row[key], results[0][key]);
  }
  const candidateCommit = process.env.CALENDAR_RETURN_CANDIDATE_COMMIT!, candidateTree = process.env.CALENDAR_RETURN_CANDIDATE_TREE!;
  assert.match(candidateCommit, /^[a-f0-9]{40}$/); assert.notEqual(candidateCommit, recovery.commit);
  assert.match(candidateTree, /^[a-f0-9]{40}$/);
  const artifact = privateRead(fixturePath() + '.artifact.json') as Record<string, unknown>;
  for (const [key, value] of Object.entries(recovery)) assert.equal(artifact[key], value);
  assert.equal(basename(path), 'calendar-return-summary.json');
  assert.equal(resolve(path), join(realpathSync(process.env.R05_EVIDENCE_DIR!), 'calendar-return-summary.json'));
  privateWrite(path, { protocol: 'FAI_CALENDAR_PERIMETER_RETURN78_V1', status: 'PASS',
    candidateCommit, candidateTree, candidateImageId: results[0].imageId,
    recoveryCommit: recovery.commit, recoveryTree: recovery.tree, recoveryImageId: recovery.imageId,
    candidateImage: results[0].imageId, returnCommit: recovery.commit, returnImage: recovery.imageId,
    schema: 78, liveSessionsPreserved: true, ledgerUnchanged: true, databaseNotRestarted: true, documentsPreserved: true,
    calendarOffDuringReturn: true, serviceGatesOff: true, sameAuthSecret: true, sameCookiesVerified: true,
    executedImages: true, documentsUnchanged: true, registryContinuityPreserved: true, existingSessionsPreserved: true,
    calendarOffOnReturn: true, roleDenialsPreserved: true, roleDenialPaths: deniedPaths,
    roleDenialDestination: '/dashboard', roleDenialNavigations: 6,
    authenticatedRequests: 6, dedicatedLiveSessions: 2, sessionsSha256: current.sessionsSha256,
    ledgerSha256: current.ledgerSha256, documentSha256: results[0].documentSha256,
    databaseId: results[0].databaseId, databaseStarted: results[0].databaseStarted,
    artifact, phases: results, synthetic: true, production: false, productionAdmitted: false });
}
function selfTest() {
  const good = { protocol: 'PR140_RELEASE_R05', status: 'CI_SCHEMA78_OPERATIONAL_FLOW_COMPATIBLE_RETURN_PASS', schema: 78,
    synthetic: true, productionAdmitted: false, candidateCommit: recovery.commit, candidateTree: recovery.tree,
    candidateImageId: recovery.imageId, imageArchiveSha256: recovery.archiveSha256 };
  canonicalReceipt(good); let count = 1;
  for (const [key, value] of Object.entries({ candidateCommit: '0'.repeat(40), candidateTree: '0'.repeat(40), candidateImageId: 'sha256:' + '0'.repeat(64),
    imageArchiveSha256: '0'.repeat(64), schema: 77, synthetic: false, productionAdmitted: true, status: 'OTHER' })) {
    assert.throws(() => canonicalReceipt({ ...good, [key]: value })); count++;
  }
  const previousSecret = process.env.AUTH_SECRET, previousCookie = process.env.AUTH_COOKIE_NAME;
  try {
    process.env.AUTH_SECRET = 'PUBLIC-SYNTHETIC-SELF-TEST-NOT-A-CREDENTIAL'; process.env.AUTH_COOKIE_NAME = 'synthetic_cookie';
    const env = ['INTERNAL_SESSION_MODE=registry', 'GOOGLE_CALENDAR_INTEGRATION_MODE=disabled', 'FEATURE_INTEGRATIONS_ENABLED=false',
      'WORKFLOW_NATIVE_PREPARATION_MODE=disabled', 'WORKFLOW_SERVICE_EXECUTION_MODE=disabled', 'WORKFLOW_MARKETING_WITHDRAWAL_MODE=disabled',
      'AUTH_SECRET=' + process.env.AUTH_SECRET, 'AUTH_COOKIE_NAME=synthetic_cookie'];
    runtime({ imageId: recovery.imageId, environment: env }, recovery.imageId); count++;
    for (const key of ['GOOGLE_CALENDAR_INTEGRATION_MODE', 'WORKFLOW_NATIVE_PREPARATION_MODE', 'WORKFLOW_SERVICE_EXECUTION_MODE', 'WORKFLOW_MARKETING_WITHDRAWAL_MODE', 'AUTH_SECRET']) {
      assert.throws(() => runtime({ imageId: recovery.imageId, environment: env.map(value => value.startsWith(key + '=') ? key + '=enabled' : value) }, recovery.imageId)); count++;
    }
    assert.throws(() => runtime({ imageId: recovery.imageId, environment: [...env, env[0]] }, recovery.imageId)); count++;
    assert.throws(() => runtime({ imageId: 'sha256:' + '0'.repeat(64), environment: env }, recovery.imageId)); count++;
  } finally {
    if (previousSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = previousSecret;
    if (previousCookie === undefined) delete process.env.AUTH_COOKIE_NAME; else process.env.AUTH_COOKIE_NAME = previousCookie;
  }
  console.log(JSON.stringify({ status: 'PASS', pureChecks: count, database: false, http: false, docker: false }));
}
async function main() {
  const mode = process.argv[2];
  if (mode === 'self-test') return selfTest();
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'linux');
  assert.notEqual(hostname(), 'fai-crm-prod-02'); assert.equal(process.env.GITHUB_REPOSITORY, 'Finanzaagevolaimpresa/CRM');
  assert.match(process.env.GITHUB_RUN_ID!, /^\d+$/); assert.match(process.env.GITHUB_RUN_ATTEMPT!, /^\d+$/);
  if (mode === 'archive') return archive();
  if (mode === 'finish') return finish(process.argv[3]);
  assert(mode === 'prepare' || mode === 'probe');
  const { PrismaClient } = await import('@prisma/client');
  const { assertAiOrchestratorEphemeralDatabaseIdentity } = await import('../db/ai-orchestrator-db-test-guard');
  const db = new PrismaClient();
  try {
    await assertAiOrchestratorEphemeralDatabaseIdentity(db);
    assert.equal(new URL(process.env.DATABASE_URL!).port, '15432');
    if (mode === 'prepare') await prepare(db); else await probe(db, process.argv[3] as Phase);
  } finally { await db.$disconnect(); }
}
main().catch(() => {
  const mode = ['self-test', 'archive', 'prepare', 'probe', 'finish'].includes(process.argv[2]) ? process.argv[2] : 'invalid';
  const phase = phases.includes(process.argv[3] as Phase) ? process.argv[3] : undefined;
  console.error(JSON.stringify({ code: 'CALENDAR_RETURN_QUALIFICATION_FAILED', mode, phase })); process.exitCode = 1;
});
