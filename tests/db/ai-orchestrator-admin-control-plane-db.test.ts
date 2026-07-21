import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  Prisma,
  PrismaClient,
  type AiOrchestratorAdminPolicyRevision,
  type User,
} from '@prisma/client';
import {
  getAiOrchestratorAdminControlSnapshot,
  listAiOrchestratorAdminPolicyRevisions,
  mutateAiOrchestratorAdminControlPolicy,
} from '../../src/lib/ai-orchestrator/admin-control-plane-v1';
import {
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS,
  AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON,
  AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE,
  AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE,
  AiOrchestratorAdminGlobalPolicySchema,
  AiOrchestratorAdminScopePolicySchema,
  buildAiOrchestratorAdminRequestIdentity,
  buildAiOrchestratorAdminRevisionIdentity,
  createAiOrchestratorAdminGenesisPolicy,
  createAiOrchestratorAdminPolicyHash,
  createAiOrchestratorAdminRequestHash,
  createAiOrchestratorAdminRevisionHash,
  getAiOrchestratorAdminControlTarget,
  validateAiOrchestratorAdminPolicyForTarget,
  type AiOrchestratorAdminControlTarget,
  type AiOrchestratorAdminGlobalPolicy,
} from '../../src/lib/ai-orchestrator/admin-control-policy-v1';
import {
  AI_ORCHESTRATOR_ADMIN_FORBIDDEN_CONTENT_REASON_CASES,
  AI_ORCHESTRATOR_ADMIN_INVALID_SHAPE_REASON_CASES,
  AI_ORCHESTRATOR_ADMIN_VALID_REASON_CASES,
} from '../fixtures/ai-orchestrator-admin-reason-corpus';

const dbTestsRequested = process.env.RUN_DB_TESTS === '1';
const destructiveDbTestsConfirmed = process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1';
const runDbTests = dbTestsRequested && destructiveDbTestsConfirmed;
const prisma = runDbTests ? new PrismaClient() : null;
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const TEST_PASSWORD_HASH = '$2b$12$synthetic.pr79.db.test.only';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

let adminUser: User;
let plainUser: User;
let overrideUser: User;
let baselineOperationalCounts: OperationalCounts;
let baselineGates: GateSnapshot;

function db() {
  if (!prisma) throw new Error('DB tests disabled');
  return prisma;
}

function assertDedicatedTestDatabase(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error('DATABASE_URL obbligatorio per i test DB Admin Control Plane.');
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const schemaName = parsed.searchParams.get('schema') ?? 'public';
  const testNamePattern = /(^|[_-])test($|[_-])/i;
  if (!testNamePattern.test(databaseName) && !testNamePattern.test(schemaName)) {
    throw new Error('I test DB Admin Control Plane richiedono un database o schema dedicato con "test" nel nome.');
  }
}

if (dbTestsRequested && !destructiveDbTestsConfirmed) {
  throw new Error('Impostare AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1 per confermare il database effimero dedicato.');
}
if (runDbTests) assertDedicatedTestDatabase(process.env.DATABASE_URL);

interface OperationalCounts {
  jobs: bigint;
  outboxEvents: bigint;
  runtimes: bigint;
  attempts: bigint;
  receipts: bigint;
  runtimeEvents: bigint;
  results: bigint;
  artifacts: bigint;
  sources: bigint;
  aiRuns: bigint;
  aiOutputs: bigint;
}

interface GateSnapshot {
  stateMachineEnabled: boolean;
  dispatchEnabled: boolean;
  syntheticDataOnly: boolean;
  provider: string;
  externalProvidersEnabled: boolean;
  enabledCapabilities: number;
  dispatchBarrier: number;
}

async function operationalCounts() {
  const rows = await db().$queryRaw<OperationalCounts[]>(Prisma.sql`
    SELECT
      (SELECT COUNT(*) FROM "AiWorkflowJob") AS "jobs",
      (SELECT COUNT(*) FROM "AiWorkflowJobOutboxEvent") AS "outboxEvents",
      (SELECT COUNT(*) FROM "AiWorkflowJobRuntime") AS "runtimes",
      (SELECT COUNT(*) FROM "AiWorkflowJobAttempt") AS "attempts",
      (SELECT COUNT(*) FROM "AiWorkflowOutboxConsumption") AS "receipts",
      (SELECT COUNT(*) FROM "AiWorkflowJobRuntimeEvent") AS "runtimeEvents",
      (SELECT COUNT(*) FROM "AiWorkflowJobResult") AS "results",
      (SELECT COUNT(*) FROM "AiWorkflowJobArtifact") AS "artifacts",
      (SELECT COUNT(*) FROM "AiWorkflowJobSourceArtifact") AS "sources",
      (SELECT COUNT(*) FROM "AiRun") AS "aiRuns",
      (SELECT COUNT(*) FROM "AiOutput") AS "aiOutputs"
  `);
  assert.equal(rows.length, 1);
  return rows[0];
}

async function gateSnapshot() {
  const rows = await db().$queryRaw<GateSnapshot[]>(Prisma.sql`
    SELECT setting."stateMachineEnabled",
           setting."dispatchEnabled",
           setting."syntheticDataOnly",
           setting."provider",
           control."externalProvidersEnabled",
           (
             SELECT COUNT(*)::INTEGER
             FROM "AiOrchestratorWorkerCapabilitySetting"
             WHERE "enabled" = true
           ) AS "enabledCapabilities",
           (
             SELECT COUNT(*)::INTEGER
             FROM pg_constraint constraint_row
             WHERE constraint_row.conrelid = '"AiOrchestratorSetting"'::REGCLASS
               AND constraint_row.conname = 'AiOrchestratorSetting_dispatch_disabled_check'
               AND constraint_row.convalidated = true
               AND PG_GET_CONSTRAINTDEF(constraint_row.oid) = 'CHECK (("dispatchEnabled" = false))'
           ) AS "dispatchBarrier"
    FROM "AiOrchestratorSetting" setting
    CROSS JOIN "AiControlSetting" control
    WHERE setting."id" = 'global' AND control."id" = 'global'
  `);
  assert.equal(rows.length, 1);
  return rows[0];
}

async function latestRevision(scopeType: string, scopeCode: string) {
  return db().aiOrchestratorAdminPolicyRevision.findFirstOrThrow({
    where: { scopeType, scopeCode },
    orderBy: { version: 'desc' },
  });
}

function target(scopeType: string, scopeCode: string) {
  const value = getAiOrchestratorAdminControlTarget(scopeType, scopeCode);
  assert.ok(value, `Target ${scopeType}:${scopeCode} non disponibile.`);
  return value;
}

function globalPolicy(row: AiOrchestratorAdminPolicyRevision) {
  return AiOrchestratorAdminGlobalPolicySchema.parse(row.policy);
}

function scopePolicyFor(
  controlTarget: AiOrchestratorAdminControlTarget,
  desiredEnabled: boolean,
  killSwitch: boolean,
) {
  const genesis = createAiOrchestratorAdminGenesisPolicy(controlTarget);
  assert.equal(genesis.policyCode, 'AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY');
  return AiOrchestratorAdminScopePolicySchema.parse({
    ...genesis,
    desiredEnabled,
    killSwitch,
  });
}

async function auditRowsForRequest(requestId: string) {
  return db().$queryRaw<Array<{
    id: string;
    event: string;
    before: unknown;
    after: unknown;
  }>>(Prisma.sql`
    SELECT "id", "event", "before", "after"
    FROM "AuditLog"
    WHERE "after" ->> 'requestId' = ${requestId}
    ORDER BY "createdAt", "id"
  `);
}

function mutationSucceeded(
  result: Awaited<ReturnType<typeof mutateAiOrchestratorAdminControlPolicy>>,
) {
  if (result.ok === false) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

const jobTargets = AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS
  .filter((entry) => entry.scopeType === 'JOB')
  .sort((left, right) => left.scopeCode.localeCompare(right.scopeCode));

test.before(async () => {
  if (!runDbTests) return;

  baselineOperationalCounts = await operationalCounts();
  baselineGates = await gateSnapshot();

  adminUser = await db().user.create({
    data: {
      email: `pr79-admin-${runId}@example.test`,
      name: 'PR79 synthetic admin',
      passwordHash: TEST_PASSWORD_HASH,
      role: 'admin',
      active: true,
    },
  });
  plainUser = await db().user.create({
    data: {
      email: `pr79-plain-${runId}@example.test`,
      name: 'PR79 synthetic non-admin',
      passwordHash: TEST_PASSWORD_HASH,
      role: 'consulente',
      active: true,
    },
  });
  overrideUser = await db().user.create({
    data: {
      email: `pr79-override-${runId}@example.test`,
      name: 'PR79 synthetic override user',
      passwordHash: TEST_PASSWORD_HASH,
      role: 'consulente',
      active: true,
      permissionOverrides: {
        create: [
          { permission: 'ai.orchestrator.configure', allowed: true },
          { permission: 'ai.orchestrator.enable', allowed: true },
          { permission: 'ai.orchestrator.kill', allowed: true },
        ],
      },
    },
  });
});

test.after(async () => {
  // Le revisioni sono append-only e referenziano gli attori con RESTRICT.
  // Il guard dedicato rende il database effimero: nessun cleanup distruttivo
  // o bypass dei trigger viene tentato da questa suite.
  await prisma?.$disconnect();
});

test('bootstrap PostgreSQL contiene 36 genesis strict, hashate e interamente fail-closed', {
  skip: !runDbTests,
}, async () => {
  const revisions = await db().aiOrchestratorAdminPolicyRevision.findMany({
    orderBy: [{ scopeType: 'asc' }, { scopeCode: 'asc' }, { version: 'asc' }],
  });
  assert.equal(revisions.length, 36, 'Il test richiede uno schema effimero appena migrato.');
  assert.deepEqual(
    Object.fromEntries(['GLOBAL', 'PROVIDER', 'AGENT', 'CAPABILITY', 'JOB', 'WORKFLOW'].map((scopeType) => [
      scopeType,
      revisions.filter((revision) => revision.scopeType === scopeType).length,
    ])),
    { GLOBAL: 1, PROVIDER: 1, AGENT: 7, CAPABILITY: 13, JOB: 13, WORKFLOW: 1 },
  );

  for (const revision of revisions) {
    assert.equal(revision.version, 1);
    assert.equal(revision.operationCode, 'GENESIS');
    assert.equal(revision.previousRevisionHash, null);
    assert.equal(revision.requestId, null);
    assert.equal(revision.actorUserId, null);
    assert.equal(revision.actorRole, null);
    assert.equal(revision.reasonCode, AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE);
    assert.equal(revision.reason, AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON);
    assert.equal(revision.confirmed, false);
    assert.deepEqual(revision.requiredPermissions, []);
    assert.deepEqual(revision.permissionDecisions, []);

    const controlTarget = target(revision.scopeType, revision.scopeCode);
    assert.equal(revision.targetDefinitionHash, controlTarget.targetDefinitionHash);
    const policy = validateAiOrchestratorAdminPolicyForTarget(controlTarget, revision.policy);
    const policyHash = createAiOrchestratorAdminPolicyHash(policy);
    assert.equal(revision.policyHash, policyHash);
    assert.equal(revision.requestedPolicyHash, policyHash);

    const request = buildAiOrchestratorAdminRequestIdentity({
      actorUserId: null,
      requestId: null,
      scopeType: controlTarget.scopeType,
      scopeCode: controlTarget.scopeCode,
      expectedVersion: null,
      expectedRevisionHash: null,
      operationCode: 'GENESIS',
      requestedPolicyHash: policyHash,
      reasonCode: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE,
      reason: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON,
      confirmed: false,
    });
    const requestHash = createAiOrchestratorAdminRequestHash(request);
    assert.equal(revision.requestHash, requestHash);
    assert.equal(revision.revisionHash, createAiOrchestratorAdminRevisionHash(
      buildAiOrchestratorAdminRevisionIdentity({
        scopeType: controlTarget.scopeType,
        scopeCode: controlTarget.scopeCode,
        targetDefinitionHash: controlTarget.targetDefinitionHash,
        version: 1,
        policyHash,
        previousRevisionHash: null,
        requestId: null,
        requestHash,
        operationCode: 'GENESIS',
        requiredPermissions: [],
        permissionDecisions: [],
        actorUserId: null,
        actorRole: null,
        reasonCode: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE,
        reason: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON,
        confirmed: false,
      }),
    ));

    if (policy.policyCode === AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE) {
      assert.equal(policy.desiredMode, 'STOPPED');
      assert.equal(policy.desiredStateMachineEnabled, false);
      assert.equal(policy.desiredDispatchEnabled, false);
      assert.equal(policy.emergencyStopEngaged, true);
      assert.equal(policy.globalKillSwitch, true);
    } else {
      assert.equal(policy.desiredEnabled, false);
      assert.equal(policy.killSwitch, true);
    }
  }

  assert.deepEqual(await gateSnapshot(), baselineGates);
  assert.equal(baselineGates.stateMachineEnabled, false);
  assert.equal(baselineGates.dispatchEnabled, false);
  assert.equal(baselineGates.syntheticDataOnly, true);
  assert.equal(baselineGates.provider, 'mock');
  assert.equal(baselineGates.externalProvidersEnabled, false);
  assert.equal(baselineGates.enabledCapabilities, 0);
  assert.equal(baselineGates.dispatchBarrier, 1);

  const snapshot = await getAiOrchestratorAdminControlSnapshot(db(), {
    actorUserId: adminUser.id,
    env: {
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      AI_ORCHESTRATOR_WORKER_ENABLED: '0',
      AI_EXTERNAL_PROVIDERS_ENABLED: 'false',
      AI_ALLOWED_MODELS: '',
    },
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.desired.scopes.length, 35);
  assert.equal(snapshot.effective.operational, false);
  assert.equal(snapshot.effective.databaseEligible, false);
  assert.equal(snapshot.effective.workerEnabled, false);
  assert.equal(snapshot.effective.dispatchEnabled, false);
  assert.equal(snapshot.effective.humanApprovalBypassAllowed, false);
});

test('PostgreSQL espone reason hardening validato e indice keyset PR80', {
  skip: !runDbTests,
}, async () => {
  const constraints = await db().$queryRaw<Array<{
    name: string;
    validated: boolean;
    definition: string;
  }>>(Prisma.sql`
    SELECT constraint_row.conname AS "name",
           constraint_row.convalidated AS "validated",
           PG_GET_CONSTRAINTDEF(constraint_row.oid) AS "definition"
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = '"AiOrchestratorAdminPolicyRevision"'::REGCLASS
      AND constraint_row.conname IN (
        'AiOAdminPolicy_reason_check',
        'AiOAdminPolicy_reason_minimized_v1_check'
      )
    ORDER BY constraint_row.conname
  `);
  assert.equal(constraints.length, 2);
  assert.ok(constraints.every(({ validated }) => validated));
  const minimized = constraints.find(({ name }) => name === 'AiOAdminPolicy_reason_minimized_v1_check');
  assert.ok(minimized);
  assert.match(minimized.definition, /^CHECK /);

  const indexes = await db().$queryRaw<Array<{ definition: string }>>(Prisma.sql`
    SELECT indexdef AS "definition"
    FROM pg_indexes
    WHERE schemaname = CURRENT_SCHEMA()
      AND tablename = 'AiOrchestratorAdminPolicyRevision'
      AND indexname = 'AiOAdminPolicy_audit_cursor_idx'
  `);
  assert.equal(indexes.length, 1);
  assert.match(indexes[0].definition, /USING btree \("createdAt", "?id"?\)/);
});

test('storico keyset pagina timestamp uguali senza duplicati, salti o cambio filtro', {
  skip: !runDbTests,
}, async () => {
  const expectedRows = await db().aiOrchestratorAdminPolicyRevision.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, createdAt: true },
  });
  assert.equal(expectedRows.length, 36, 'La prova keyset deve precedere le revisioni umane della suite.');
  assert.equal(new Set(expectedRows.map(({ createdAt }) => createdAt.getTime())).size, 1);

  const collectedIds: string[] = [];
  let cursor: string | undefined;
  let firstCursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await listAiOrchestratorAdminPolicyRevisions(db(), {
      actorUserId: adminUser.id,
      cursor,
      limit: 7,
    });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    collectedIds.push(...page.revisions.map(({ id }) => id));
    if (pageNumber === 0) firstCursor = page.nextCursor;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  assert.deepEqual(collectedIds, expectedRows.map(({ id }) => id));
  assert.equal(new Set(collectedIds).size, expectedRows.length);
  assert.ok(firstCursor);

  const changedFilter = await listAiOrchestratorAdminPolicyRevisions(db(), {
    actorUserId: adminUser.id,
    scopeType: 'GLOBAL',
    cursor: firstCursor,
    limit: 7,
  });
  assert.deepEqual(
    { ok: changedFilter.ok, code: changedFilter.ok ? null : changedFilter.code },
    { ok: false, code: 'INVALID_CURSOR' },
  );

  const malformed = await listAiOrchestratorAdminPolicyRevisions(db(), {
    actorUserId: adminUser.id,
    cursor: `${firstCursor}!`,
    limit: 7,
  });
  assert.deepEqual(
    { ok: malformed.ok, code: malformed.ok ? null : malformed.code },
    { ok: false, code: 'INVALID_CURSOR' },
  );

  const invalidFilter = await listAiOrchestratorAdminPolicyRevisions(db(), {
    actorUserId: adminUser.id,
    scopeCode: 'global',
    limit: 7,
  });
  assert.deepEqual(
    { ok: invalidFilter.ok, code: invalidFilter.ok ? null : invalidFilter.code },
    { ok: false, code: 'INVALID_FILTER' },
  );

  const denied = await listAiOrchestratorAdminPolicyRevisions(db(), {
    actorUserId: plainUser.id,
    limit: 7,
  });
  assert.deepEqual(
    { ok: denied.ok, code: denied.ok ? null : denied.code },
    { ok: false, code: 'ACTOR_NOT_AUTHORIZED' },
  );
});

test('global mutation usa CAS, audit atomico, replay idempotente e collision detection', {
  skip: !runDbTests,
}, async () => {
  const genesis = await latestRevision('GLOBAL', 'global');
  const expanded = structuredClone(globalPolicy(genesis));
  expanded.desiredMode = 'READY';
  expanded.desiredStateMachineEnabled = true;
  expanded.emergencyStopEngaged = false;
  expanded.globalKillSwitch = false;
  expanded.limits.dailyJobLimit = 1;
  const requestId = randomUUID();
  const command = {
    actorUserId: adminUser.id,
    requestId,
    operationCode: 'SET_GLOBAL_POLICY' as const,
    expectedVersion: genesis.version,
    expectedRevisionHash: genesis.revisionHash,
    reasonCode: 'ENABLEMENT_CHANGE' as const,
    reason: 'Abilitazione desiderata sintetica per il test controllato.',
    confirmed: true as const,
    policy: expanded,
  };

  const result = mutationSucceeded(await mutateAiOrchestratorAdminControlPolicy(db(), command));
  assert.equal(result.replayed, false);
  assert.equal(result.revision.version, 2);
  assert.equal(result.revision.previousRevisionHash, genesis.revisionHash);
  assert.equal(result.revision.requestId, requestId);
  assert.deepEqual(result.revision.requiredPermissions, [
    'ai.orchestrator.configure',
    'ai.orchestrator.enable',
    'ai.orchestrator.kill',
    'ai.orchestrator.limits',
  ]);
  assert.ok(result.revision.permissionDecisions.every((decision) => (
    decision.allowed && decision.source === 'ADMIN'
  )));
  assert.equal(await db().aiOrchestratorAdminPolicyRevision.count({ where: { requestId } }), 1);

  const successAudits = await auditRowsForRequest(requestId);
  assert.equal(successAudits.length, 1);
  assert.equal(successAudits[0].event, 'ai_orchestrator_control_policy_changed');
  assert.deepEqual(successAudits[0].before, {
    policyHash: genesis.policyHash,
    revisionHash: genesis.revisionHash,
    version: genesis.version,
  });
  assert.deepEqual(successAudits[0].after, {
    changedPaths: [
      'desiredMode',
      'desiredStateMachineEnabled',
      'emergencyStopEngaged',
      'globalKillSwitch',
      'limits',
    ],
    operationCode: 'SET_GLOBAL_POLICY',
    policyHash: result.revision.policyHash,
    requestHash: result.revision.requestHash,
    requestId,
    revisionHash: result.revision.revisionHash,
    scopeCode: 'global',
    scopeType: 'GLOBAL',
    version: result.revision.version,
  });

  const replay = mutationSucceeded(await mutateAiOrchestratorAdminControlPolicy(db(), command));
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision.revisionHash, result.revision.revisionHash);
  assert.equal(await db().aiOrchestratorAdminPolicyRevision.count({ where: { requestId } }), 1);
  assert.equal((await auditRowsForRequest(requestId)).length, 1);

  const collision = await mutateAiOrchestratorAdminControlPolicy(db(), {
    ...command,
    reason: 'Contenuto differente associato alla stessa chiave idempotente.',
  });
  assert.deepEqual({ ok: collision.ok, code: collision.ok ? null : collision.code }, {
    ok: false,
    code: 'REQUEST_ID_COLLISION',
  });
  assert.equal(await db().aiOrchestratorAdminPolicyRevision.count({ where: { requestId } }), 1);
  assert.equal((await auditRowsForRequest(requestId)).length, 2);

  const staleRequestId = randomUUID();
  const stale = await mutateAiOrchestratorAdminControlPolicy(db(), {
    ...command,
    requestId: staleRequestId,
  });
  assert.deepEqual({ ok: stale.ok, code: stale.ok ? null : stale.code }, {
    ok: false,
    code: 'CAS_MISMATCH',
  });
  assert.equal(await db().aiOrchestratorAdminPolicyRevision.count({ where: { requestId: staleRequestId } }), 0);
  assert.equal((await auditRowsForRequest(staleRequestId)).length, 1);

  const invalidReasonRequest = randomUUID();
  await assert.rejects(mutateAiOrchestratorAdminControlPolicy(db(), {
    ...command,
    requestId: invalidReasonRequest,
    expectedVersion: result.revision.version,
    expectedRevisionHash: result.revision.revisionHash,
    reason: 'Cambio con token segreto non ammesso dal contratto.',
  }));
  assert.equal(await db().aiOrchestratorAdminPolicyRevision.count({
    where: { requestId: invalidReasonRequest },
  }), 0);
  assert.equal((await auditRowsForRequest(invalidReasonRequest)).length, 0);
});

test('scope mutation rilegge override DB e fallisce chiusa dopo revoca o senza grant', {
  skip: !runDbTests,
}, async () => {
  assert.ok(jobTargets.length >= 4);
  const allowedTarget = jobTargets[0];
  const allowedHead = await latestRevision(allowedTarget.scopeType, allowedTarget.scopeCode);
  const allowedRequestId = randomUUID();
  const allowedCommand = {
    actorUserId: overrideUser.id,
    requestId: allowedRequestId,
    operationCode: 'SET_SCOPE_POLICY' as const,
    expectedVersion: allowedHead.version,
    expectedRevisionHash: allowedHead.revisionHash,
    reasonCode: 'ENABLEMENT_CHANGE' as const,
    reason: 'Abilitazione desired sintetica mediante override dedicati.',
    confirmed: true as const,
    policy: scopePolicyFor(allowedTarget, true, false),
  };
  const allowed = mutationSucceeded(await mutateAiOrchestratorAdminControlPolicy(db(), allowedCommand));
  assert.equal(allowed.replayed, false);
  assert.deepEqual(allowed.revision.requiredPermissions, [
    'ai.orchestrator.configure',
    'ai.orchestrator.enable',
    'ai.orchestrator.kill',
  ]);
  assert.ok(allowed.revision.permissionDecisions.every((decision) => (
    decision.allowed && decision.source === 'OVERRIDE'
  )));

  const replay = mutationSucceeded(await mutateAiOrchestratorAdminControlPolicy(db(), allowedCommand));
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision.revisionHash, allowed.revision.revisionHash);

  const staleScopeId = randomUUID();
  const staleScope = await mutateAiOrchestratorAdminControlPolicy(db(), {
    ...allowedCommand,
    actorUserId: adminUser.id,
    requestId: staleScopeId,
    policy: scopePolicyFor(allowedTarget, false, false),
  });
  assert.deepEqual({ ok: staleScope.ok, code: staleScope.ok ? null : staleScope.code }, {
    ok: false,
    code: 'CAS_MISMATCH',
  });

  await db().userPermissionOverride.update({
    where: {
      userId_permission: {
        userId: overrideUser.id,
        permission: 'ai.orchestrator.enable',
      },
    },
    data: { allowed: false },
  });
  const revokedTarget = jobTargets[1];
  const revokedHead = await latestRevision(revokedTarget.scopeType, revokedTarget.scopeCode);
  const revokedRequestId = randomUUID();
  const revoked = await mutateAiOrchestratorAdminControlPolicy(db(), {
    ...allowedCommand,
    requestId: revokedRequestId,
    expectedVersion: revokedHead.version,
    expectedRevisionHash: revokedHead.revisionHash,
    policy: scopePolicyFor(revokedTarget, true, false),
  });
  assert.deepEqual({ ok: revoked.ok, code: revoked.ok ? null : revoked.code }, {
    ok: false,
    code: 'ACTOR_NOT_AUTHORIZED',
  });
  assert.equal(await db().aiOrchestratorAdminPolicyRevision.count({
    where: { requestId: revokedRequestId },
  }), 0);
  assert.equal((await auditRowsForRequest(revokedRequestId)).length, 1);

  const plainTarget = jobTargets[2];
  const plainHead = await latestRevision(plainTarget.scopeType, plainTarget.scopeCode);
  const plainRequestId = randomUUID();
  const plain = await mutateAiOrchestratorAdminControlPolicy(db(), {
    actorUserId: plainUser.id,
    requestId: plainRequestId,
    operationCode: 'SET_SCOPE_POLICY',
    expectedVersion: plainHead.version,
    expectedRevisionHash: plainHead.revisionHash,
    reasonCode: 'ENABLEMENT_CHANGE',
    reason: 'Tentativo sintetico senza permessi dedicati richiesti.',
    confirmed: true,
    policy: scopePolicyFor(plainTarget, true, false),
  });
  assert.deepEqual({ ok: plain.ok, code: plain.ok ? null : plain.code }, {
    ok: false,
    code: 'ACTOR_NOT_AUTHORIZED',
  });
  assert.equal(await db().aiOrchestratorAdminPolicyRevision.count({
    where: { requestId: plainRequestId },
  }), 0);
  assert.equal((await auditRowsForRequest(plainRequestId)).length, 1);
});

async function rawGlobalInsert(input: {
  head: AiOrchestratorAdminPolicyRevision;
  policy: unknown;
  requestedPolicyHash: string;
  requiredPermissions?: unknown[];
  permissionDecisions?: unknown[];
}) {
  const globalTarget = target('GLOBAL', 'global');
  return db().$executeRaw(Prisma.sql`
    INSERT INTO "AiOrchestratorAdminPolicyRevision" (
      "id", "scopeType", "scopeCode", "targetDefinitionHash", "version",
      "policy", "policyHash", "previousRevisionHash", "revisionHash",
      "requestId", "requestHash", "requestedPolicyHash", "expectedVersion",
      "expectedRevisionHash", "operationCode", "requiredPermissions",
      "permissionDecisions", "actorUserId", "actorRole", "reasonCode",
      "reason", "confirmed"
    ) VALUES (
      ${randomUUID()}, 'GLOBAL', 'global', ${globalTarget.targetDefinitionHash},
      ${input.head.version + 1}, CAST(${JSON.stringify(input.policy)} AS JSONB),
      ${SHA_A}, ${input.head.revisionHash}, ${SHA_B}, ${randomUUID()}, ${SHA_A},
      ${input.requestedPolicyHash}, ${input.head.version}, ${input.head.revisionHash},
      'SET_GLOBAL_POLICY', CAST(${JSON.stringify(input.requiredPermissions ?? [])} AS JSONB),
      CAST(${JSON.stringify(input.permissionDecisions ?? [])} AS JSONB),
      ${adminUser.id}, 'admin', 'CONFIGURATION_CHANGE',
      'Tentativo raw sintetico intenzionalmente non valido.', true
    )
  `);
}

async function rawScopeReasonInsert(input: {
  head: AiOrchestratorAdminPolicyRevision;
  controlTarget: AiOrchestratorAdminControlTarget;
  reason: string;
}) {
  const policy = scopePolicyFor(input.controlTarget, true, true);
  const requestedPolicyHash = createAiOrchestratorAdminPolicyHash(policy);
  const requiredPermissions = [
    'ai.orchestrator.configure',
    'ai.orchestrator.enable',
  ];
  const permissionDecisions = requiredPermissions.map((permission) => ({
    permission,
    allowed: true,
    source: 'ADMIN',
  }));
  return db().$executeRaw(Prisma.sql`
    INSERT INTO "AiOrchestratorAdminPolicyRevision" (
      "id", "scopeType", "scopeCode", "targetDefinitionHash", "version",
      "policy", "policyHash", "previousRevisionHash", "revisionHash",
      "requestId", "requestHash", "requestedPolicyHash", "expectedVersion",
      "expectedRevisionHash", "operationCode", "requiredPermissions",
      "permissionDecisions", "actorUserId", "actorRole", "reasonCode",
      "reason", "confirmed"
    ) VALUES (
      ${randomUUID()}, ${input.controlTarget.scopeType}, ${input.controlTarget.scopeCode},
      ${input.controlTarget.targetDefinitionHash}, ${input.head.version + 1},
      CAST(${JSON.stringify(policy)} AS JSONB), ${SHA_A}, ${input.head.revisionHash},
      ${SHA_B}, ${randomUUID()}, ${SHA_A}, ${requestedPolicyHash},
      ${input.head.version}, ${input.head.revisionHash}, 'SET_SCOPE_POLICY',
      CAST(${JSON.stringify(requiredPermissions)} AS JSONB),
      CAST(${JSON.stringify(permissionDecisions)} AS JSONB),
      ${adminUser.id}, 'admin', 'ENABLEMENT_CHANGE', ${input.reason}, true
    )
  `);
}

test('trigger DB rifiuta policy, hash richiesto e snapshot permessi forgiati via SQL raw', {
  skip: !runDbTests,
}, async () => {
  const head = await latestRevision('GLOBAL', 'global');
  const before = await db().aiOrchestratorAdminPolicyRevision.count();
  const current = globalPolicy(head);
  const next = AiOrchestratorAdminGlobalPolicySchema.parse({
    ...current,
    desiredMode: 'PAUSED',
  });

  await assert.rejects(rawGlobalInsert({
    head,
    policy: { ...next, desiredDispatchEnabled: true },
    requestedPolicyHash: SHA_A,
  }));
  await assert.rejects(rawGlobalInsert({
    head,
    policy: next,
    requestedPolicyHash: SHA_A,
  }));
  await assert.rejects(rawGlobalInsert({
    head,
    policy: next,
    requestedPolicyHash: createAiOrchestratorAdminPolicyHash(next),
    requiredPermissions: [],
    permissionDecisions: [],
  }));

  assert.equal(await db().aiOrchestratorAdminPolicyRevision.count(), before);
  assert.equal((await latestRevision('GLOBAL', 'global')).revisionHash, head.revisionHash);
});

test('PostgreSQL rifiuta via SQL raw l’intero corpus reason non valido senza riscrivere il ledger', {
  skip: !runDbTests,
}, async () => {
  const controlTarget = jobTargets.at(-1);
  assert.ok(controlTarget);
  const head = await latestRevision(controlTarget.scopeType, controlTarget.scopeCode);
  const before = await db().aiOrchestratorAdminPolicyRevision.count();

  for (const reasonCase of AI_ORCHESTRATOR_ADMIN_FORBIDDEN_CONTENT_REASON_CASES) {
    await assert.rejects(
      rawScopeReasonInsert({ head, controlTarget, reason: reasonCase.reason }),
      (error: unknown) => {
        assert.match(String(error), /AiOAdminPolicy_reason_minimized_v1_check/);
        return true;
      },
      reasonCase.code,
    );
  }

  for (const reasonCase of AI_ORCHESTRATOR_ADMIN_INVALID_SHAPE_REASON_CASES) {
    await assert.rejects(
      rawScopeReasonInsert({ head, controlTarget, reason: reasonCase.reason }),
      (error: unknown) => {
        assert.match(String(error), /AiOAdminPolicy_reason_check/);
        return true;
      },
      reasonCase.code,
    );
  }

  assert.equal(await db().aiOrchestratorAdminPolicyRevision.count(), before);
  assert.equal(
    (await latestRevision(controlTarget.scopeType, controlTarget.scopeCode)).revisionHash,
    head.revisionHash,
  );

  const safeReason = AI_ORCHESTRATOR_ADMIN_VALID_REASON_CASES[0].reason;
  await rawScopeReasonInsert({ head, controlTarget, reason: safeReason });
  const accepted = await latestRevision(controlTarget.scopeType, controlTarget.scopeCode);
  assert.equal(accepted.version, head.version + 1);
  assert.equal(accepted.previousRevisionHash, head.revisionHash);
  assert.equal(accepted.reason, safeReason);
});

class ExpectedProbeRollback extends Error {}

test('ledger rifiuta UPDATE, DELETE e TRUNCATE; la prova TRUNCATE resta in rollback', {
  skip: !runDbTests,
}, async () => {
  const row = await db().aiOrchestratorAdminPolicyRevision.findFirstOrThrow({
    where: { requestId: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
  const before = await db().aiOrchestratorAdminPolicyRevision.count();
  await assert.rejects(db().$executeRaw(Prisma.sql`
    UPDATE "AiOrchestratorAdminPolicyRevision"
    SET "reason" = 'Mutazione vietata della revisione append-only.'
    WHERE "id" = ${row.id}
  `));
  await assert.rejects(db().$executeRaw(Prisma.sql`
    DELETE FROM "AiOrchestratorAdminPolicyRevision" WHERE "id" = ${row.id}
  `));

  let truncateRejected = false;
  await assert.rejects(
    db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SAVEPOINT pr79_truncate_probe');
      try {
        await tx.$executeRawUnsafe('TRUNCATE TABLE "AiOrchestratorAdminPolicyRevision"');
      } catch {
        truncateRejected = true;
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT pr79_truncate_probe');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT pr79_truncate_probe');
      }
      if (!truncateRejected) {
        throw new Error('TRUNCATE_NON_BLOCCATO');
      }
      throw new ExpectedProbeRollback();
    }),
    (error: unknown) => error instanceof ExpectedProbeRollback,
  );
  assert.equal(truncateRejected, true);
  assert.equal(await db().aiOrchestratorAdminPolicyRevision.count(), before);
  assert.equal((await db().aiOrchestratorAdminPolicyRevision.findUnique({
    where: { id: row.id },
  }))?.revisionHash, row.revisionHash);
});

test('due SET concorrenti con lo stesso CAS producono un solo winner', {
  skip: !runDbTests,
}, async () => {
  const concurrentTarget = jobTargets[3];
  const head = await latestRevision(concurrentTarget.scopeType, concurrentTarget.scopeCode);
  const base = {
    actorUserId: adminUser.id,
    operationCode: 'SET_SCOPE_POLICY' as const,
    expectedVersion: head.version,
    expectedRevisionHash: head.revisionHash,
    reasonCode: 'CONFIGURATION_CHANGE' as const,
    confirmed: true as const,
  };
  const [left, right] = await Promise.all([
    mutateAiOrchestratorAdminControlPolicy(db(), {
      ...base,
      requestId: randomUUID(),
      reason: 'Prima proposta concorrente sintetica sullo stesso scope.',
      policy: scopePolicyFor(concurrentTarget, true, true),
    }),
    mutateAiOrchestratorAdminControlPolicy(db(), {
      ...base,
      requestId: randomUUID(),
      reason: 'Seconda proposta concorrente sintetica sullo stesso scope.',
      policy: scopePolicyFor(concurrentTarget, false, false),
    }),
  ]);
  const results = [left, right];
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.code === 'CAS_MISMATCH').length, 1);
  const final = await latestRevision(concurrentTarget.scopeType, concurrentTarget.scopeCode);
  assert.equal(final.version, head.version + 1);
  assert.equal(final.previousRevisionHash, head.revisionHash);
});

test('emergency stop è CAS-less e vince la race contro una proposta espansiva', {
  skip: !runDbTests,
}, async () => {
  const beforeEmergency = await latestRevision('GLOBAL', 'global');
  const emergencyRequestId = randomUUID();
  const emergencyCommand = {
    actorUserId: adminUser.id,
    requestId: emergencyRequestId,
    operationCode: 'EMERGENCY_STOP' as const,
    reasonCode: 'EMERGENCY_STOP' as const,
    reason: 'Arresto di emergenza sintetico confermato per il test.',
    confirmed: true as const,
  };
  const stopped = mutationSucceeded(await mutateAiOrchestratorAdminControlPolicy(db(), emergencyCommand));
  assert.equal(stopped.replayed, false);
  assert.equal(stopped.revision.version, beforeEmergency.version + 1);
  assert.equal(stopped.revision.expectedVersion, null);
  assert.equal(stopped.revision.expectedRevisionHash, null);
  const stoppedPolicy = stopped.revision.policy as AiOrchestratorAdminGlobalPolicy;
  assert.equal(stoppedPolicy.desiredMode, 'STOPPED');
  assert.equal(stoppedPolicy.desiredStateMachineEnabled, false);
  assert.equal(stoppedPolicy.desiredDispatchEnabled, false);
  assert.equal(stoppedPolicy.emergencyStopEngaged, true);
  assert.equal(stoppedPolicy.globalKillSwitch, true);
  assert.equal((await auditRowsForRequest(emergencyRequestId))[0]?.event, 'ai_orchestrator_emergency_stop_activated');

  const exactReplay = mutationSucceeded(await mutateAiOrchestratorAdminControlPolicy(db(), emergencyCommand));
  assert.equal(exactReplay.replayed, true);
  assert.equal(exactReplay.revision.revisionHash, stopped.revision.revisionHash);

  const redundantEmergencyRequestId = randomUUID();
  const redundantEmergency = await mutateAiOrchestratorAdminControlPolicy(db(), {
    ...emergencyCommand,
    requestId: redundantEmergencyRequestId,
    reason: 'Arresto già inserito senza nuova modifica della policy.',
  });
  assert.equal(redundantEmergency.ok, false);
  if (redundantEmergency.ok) return;
  assert.equal(redundantEmergency.code, 'NO_CHANGE');
  assert.equal((await latestRevision('GLOBAL', 'global')).revisionHash, stopped.revision.revisionHash);
  assert.equal((await auditRowsForRequest(redundantEmergencyRequestId))[0]?.event, 'ai_orchestrator_control_change_blocked');

  const reopenPolicy = structuredClone(stoppedPolicy);
  reopenPolicy.desiredMode = 'READY';
  reopenPolicy.desiredStateMachineEnabled = true;
  reopenPolicy.emergencyStopEngaged = false;
  reopenPolicy.globalKillSwitch = false;
  const reopened = mutationSucceeded(await mutateAiOrchestratorAdminControlPolicy(db(), {
    actorUserId: adminUser.id,
    requestId: randomUUID(),
    operationCode: 'SET_GLOBAL_POLICY',
    expectedVersion: stopped.revision.version,
    expectedRevisionHash: stopped.revision.revisionHash,
    reasonCode: 'ENABLEMENT_CHANGE',
    reason: 'Riapertura desired sintetica prima della prova di race.',
    confirmed: true,
    policy: reopenPolicy,
  }));

  const expansive = structuredClone(reopenPolicy);
  expansive.limits.dailyJobLimit = reopenPolicy.limits.dailyJobLimit + 1;
  const raceEmergencyId = randomUUID();
  const [setResult, emergencyResult] = await Promise.all([
    mutateAiOrchestratorAdminControlPolicy(db(), {
      actorUserId: adminUser.id,
      requestId: randomUUID(),
      operationCode: 'SET_GLOBAL_POLICY',
      expectedVersion: reopened.revision.version,
      expectedRevisionHash: reopened.revision.revisionHash,
      reasonCode: 'LIMIT_CHANGE',
      reason: 'Proposta espansiva concorrente sintetica sui limiti.',
      confirmed: true,
      policy: expansive,
    }),
    mutateAiOrchestratorAdminControlPolicy(db(), {
      ...emergencyCommand,
      requestId: raceEmergencyId,
      reason: 'Arresto sintetico concorrente che deve prevalere.',
    }),
  ]);
  assert.equal(emergencyResult.ok, true);
  assert.ok(setResult.ok || setResult.code === 'CAS_MISMATCH');

  const finalHead = await latestRevision('GLOBAL', 'global');
  const finalPolicy = globalPolicy(finalHead);
  assert.equal(finalPolicy.desiredMode, 'STOPPED');
  assert.equal(finalPolicy.desiredStateMachineEnabled, false);
  assert.equal(finalPolicy.desiredDispatchEnabled, false);
  assert.equal(finalPolicy.emergencyStopEngaged, true);
  assert.equal(finalPolicy.globalKillSwitch, true);
  assert.equal(finalHead.requestId, raceEmergencyId);
});

test('Control Plane non modifica gate o record operativi e resta effective fail-closed', {
  skip: !runDbTests,
}, async () => {
  assert.deepEqual(await operationalCounts(), baselineOperationalCounts);
  assert.deepEqual(await gateSnapshot(), baselineGates);

  const snapshot = await getAiOrchestratorAdminControlSnapshot(db(), {
    actorUserId: adminUser.id,
    env: {
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      AI_ORCHESTRATOR_WORKER_ENABLED: '1',
      AI_EXTERNAL_PROVIDERS_ENABLED: 'false',
      AI_ALLOWED_MODELS: '',
    },
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.desired.scopes.length, 35);
  assert.equal(snapshot.effective.operational, false);
  assert.equal(snapshot.effective.databaseEligible, false);
  assert.equal(snapshot.effective.workerEnabled, false);
  assert.equal(snapshot.effective.dispatchEnabled, false);
  assert.equal(snapshot.effective.environmentWorkerGateOpen, true);
  assert.equal(snapshot.effective.physicalDispatchBarrierPresent, true);
  assert.ok(snapshot.effective.blockReasons.includes('FOUNDATION_LOCKED_V1'));
  assert.ok(snapshot.effective.blockReasons.includes('HUMAN_APPROVAL_BARRIER'));
  assert.ok(snapshot.effective.blockReasons.includes('PHYSICAL_DISPATCH_BARRIER'));
});
