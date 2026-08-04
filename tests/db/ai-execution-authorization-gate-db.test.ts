import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  PrismaClient,
  type AiAgentConfigVersion,
  type Prisma,
  type User,
} from '@prisma/client';
import { MockAiAdapter } from '../../src/lib/ai';
import {
  createAiExecutionReplacementRequest,
  reserveAuthorizedAiRun,
} from '../../src/lib/ai-execution-authorization';
import { aiExecutionCanonicalSha256V2, canonicalSha256 } from '../../src/lib/canonical-json';
import type { AuthSession } from '../../src/lib/auth';
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from './ai-orchestrator-db-test-guard';

const requested = process.env.RUN_DB_TESTS === '1';
const confirmed = process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1';
const runDbTests = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested,
  destructiveConfirmed: confirmed,
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const prisma = runDbTests ? new PrismaClient() : null;
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const passwordHash = '$2b$12$pr85.synthetic.db.test.only';

let adminOne: User;
let adminTwo: User;
let collaborator: User;
let agentConfig: AiAgentConfigVersion;

function db() {
  if (!prisma) throw new Error('DB tests disabled');
  return prisma;
}

function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function createRequest(options: {
  requester?: User;
  expiresInMs?: number;
  purposeCode?: string;
  executionInput?: Prisma.InputJsonValue;
  hashCanonicalizationVersion?: 1 | 2;
  supersedesRequestId?: string;
} = {}) {
  const requester = options.requester ?? collaborator;
  const key = randomUUID();
  const version = options.hashCanonicalizationVersion ?? 1;
  const fingerprint = version === 2 ? aiExecutionCanonicalSha256V2({ runId, key }) : sha(`pr85:${runId}:${key}`);
  const executionInput = options.executionInput ?? { synthetic: true };
  const executionInputHash = version === 2 ? aiExecutionCanonicalSha256V2(executionInput) : canonicalSha256(executionInput);
  const request = await db().aiExecutionRequest.create({
    data: {
      origin: 'CRM_UI',
      requesterKind: 'HUMAN_USER',
      requesterUserId: requester.id,
      functionCode: 'PR85_SYNTHETIC_DB_TEST',
      agentId: agentConfig.agentId,
      agentConfigVersion: agentConfig.version,
      provider: 'mock',
      model: 'mock-template-v1',
      purposeCode: options.purposeCode ?? 'SYNTHETIC_TEST',
      dataCategories: ['synthetic_test'],
      correlationId: key,
      idempotencyKey: key,
      inputFingerprint: fingerprint,
      executionInputHash,
      hashCanonicalizationVersion: version,
      supersedesRequestId: options.supersedesRequestId,
      expiresAt: new Date(Date.now() + (options.expiresInMs ?? 60_000)),
    },
  });
  return { request, key, fingerprint, executionInput, executionInputHash, requester };
}

async function decide(
  requestId: string,
  actor: User,
  decisionType: 'APPROVED' | 'REJECTED' | 'NEEDS_INFORMATION' | 'REVOKED',
) {
  return db().aiExecutionDecision.create({
    data: {
      requestId,
      decisionType,
      actorUserId: actor.id,
      actorRole: actor.role,
      reasonCode: `AI_EXECUTION_${decisionType}`,
      reason: `Decisione manuale sintetica ${decisionType.toLowerCase()} per il test PostgreSQL.`,
      requestFingerprint: '0'.repeat(64),
    },
  });
}

async function approvedRequest(options: {
  requester?: User;
  expiresInMs?: number;
  executionInput?: Prisma.InputJsonValue;
  hashCanonicalizationVersion?: 1 | 2;
} = {}) {
  const fixture = await createRequest(options);
  await decide(fixture.request.id, adminOne, 'APPROVED');
  const grant = await db().aiExecutionAuthorizationGrant.findUniqueOrThrow({
    where: { requestId: fixture.request.id },
  });
  return { ...fixture, grant };
}

async function createBoundRun(fixture: Awaited<ReturnType<typeof approvedRequest>>, overrides: {
  requestFingerprint?: string;
  executionInputHash?: string;
  input?: Prisma.InputJsonValue;
  authorizationGrantId?: string;
  requestKey?: string;
  hashCanonicalizationVersion?: number | null;
} = {}) {
  return db().aiRun.create({
    data: {
      reliabilityVersion: 1,
      agentId: agentConfig.agentId,
      agentConfigVersion: agentConfig.version,
      status: 'running',
      provider: 'mock',
      model: 'mock-template-v1',
      promptVersion: agentConfig.promptVersion,
      requestKey: overrides.requestKey ?? fixture.key,
      requestFingerprint: overrides.requestFingerprint ?? fixture.fingerprint,
      executionInputHash: overrides.executionInputHash ?? fixture.executionInputHash,
      hashCanonicalizationVersion: overrides.hashCanonicalizationVersion === undefined
        ? fixture.request.hashCanonicalizationVersion : overrides.hashCanonicalizationVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseTokenHash: sha(`lease:${randomUUID()}`),
      input: overrides.input ?? fixture.executionInput,
      createdById: fixture.requester.id,
      aiExecutionRequestId: fixture.request.id,
      authorizationGrantId: overrides.authorizationGrantId ?? fixture.grant.id,
    },
  });
}

function sessionFor(user: User): AuthSession {
  return {
    userId: user.id,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    role: user.role,
    active: true,
    permissionOverrides: [],
  };
}

function replacementBinding(suffix: string) {
  const key = randomUUID();
  const executionInput = { synthetic: true, integrated: suffix };
  return {
    origin: 'CRM_UI' as const,
    functionCode: 'PR85_SYNTHETIC_DB_TEST',
    agentId: agentConfig.agentId,
    agentConfigVersion: agentConfig.version,
    provider: 'mock',
    model: 'mock-template-v1',
    purposeCode: 'SYNTHETIC_TEST',
    dataCategories: ['synthetic_test'] as const,
    correlationId: key,
    idempotencyKey: key,
    inputFingerprint: aiExecutionCanonicalSha256V2({ runId, key, suffix }),
    executionInputHash: aiExecutionCanonicalSha256V2(executionInput),
    hashCanonicalizationVersion: 2 as const,
  };
}

test.before(async () => {
  if (!runDbTests) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db());
  [adminOne, adminTwo, collaborator] = await Promise.all([
    db().user.create({
      data: {
        email: `pr85-admin-one-${runId}@example.test`,
        name: 'PR85 synthetic Admin one',
        passwordHash,
        role: 'admin',
        active: true,
      },
    }),
    db().user.create({
      data: {
        email: `pr85-admin-two-${runId}@example.test`,
        name: 'PR85 synthetic Admin two',
        passwordHash,
        role: 'admin',
        active: true,
      },
    }),
    db().user.create({
      data: {
        email: `pr85-collaborator-${runId}@example.test`,
        name: 'PR85 synthetic collaborator',
        passwordHash,
        role: 'consulente',
        active: true,
      },
    }),
  ]);
  agentConfig = await db().aiAgentConfigVersion.findFirstOrThrow({
    where: { active: true, provider: 'mock' },
    orderBy: [{ agentId: 'asc' }, { version: 'desc' }],
  });
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});

test('rollback guard PR85 è sicuro prima di dati PR86 incompatibili', { skip: !runDbTests }, async () => {
  await db().$queryRaw`SELECT "assert_ai_execution_pr85_rollback_safe_v2"()`;
});

test('rollback guard PR85 rifiuta NEEDS_INFORMATION anche con scadenza futura', { skip: !runDbTests }, async () => {
  const source = await createRequest({ expiresInMs: 60 * 60 * 1000 });
  await decide(source.request.id, adminOne, 'NEEDS_INFORMATION');
  await assert.rejects(
    db().$queryRaw`SELECT "assert_ai_execution_pr85_rollback_safe_v2"()`,
    /any NEEDS_INFORMATION rows exist/i,
  );
});

test('richiesta, genesis, audit e notifiche Admin sono atomici', { skip: !runDbTests }, async () => {
  const activeAdminCount = await db().user.count({
    where: { role: 'admin', active: true, deletedAt: null },
  });
  const { request, fingerprint } = await createRequest();
  const [decisions, notifications, audits] = await Promise.all([
    db().aiExecutionDecision.findMany({ where: { requestId: request.id } }),
    db().aiExecutionAdminNotification.findMany({ where: { requestId: request.id } }),
    db().auditLog.findMany({ where: { entityType: 'AiExecutionRequest', entityId: request.id } }),
  ]);
  assert.equal(request.status, 'PENDING_ADMIN_APPROVAL');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.decisionType, 'REQUESTED');
  assert.equal(decisions[0]?.requestFingerprint, fingerprint);
  assert.equal(notifications.length, activeAdminCount);
  assert.equal(new Set(notifications.map(({ recipientAdminId }) => recipientAdminId)).size, activeAdminCount);
  assert.ok(notifications.every(({ isRead, approvalPath }) => !isRead && approvalPath.endsWith(request.id)));
  assert.equal(audits.length, 2);
  await assert.rejects(
    db().aiExecutionAdminNotification.delete({ where: { id: notifications[0]!.id } }),
    /append-only and immutable/i,
  );
});

test('nessun Admin attivo impedisce e annulla fisicamente la richiesta', { skip: !runDbTests }, async () => {
  const before = await db().aiExecutionRequest.count();
  await assert.rejects(
    db().$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { role: 'admin', active: true, deletedAt: null },
        data: { active: false },
      });
      const key = randomUUID();
      await tx.aiExecutionRequest.create({
        data: {
          origin: 'CRM_UI',
          requesterKind: 'HUMAN_USER',
          requesterUserId: collaborator.id,
          functionCode: 'PR85_NO_ADMIN_TEST',
          agentId: agentConfig.agentId,
          agentConfigVersion: agentConfig.version,
          provider: 'mock',
          model: 'mock-template-v1',
          purposeCode: 'SYNTHETIC_TEST',
          dataCategories: ['synthetic_test'],
          correlationId: key,
          idempotencyKey: key,
          inputFingerprint: sha(key),
          executionInputHash: sha(`input:${key}`),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    }),
    /no active Admin/i,
  );
  assert.equal(await db().aiExecutionRequest.count(), before);
  assert.equal(await db().user.count({ where: { role: 'admin', active: true, deletedAt: null } }) > 0, true);
});

test('raw SQL non consente a un non-Admin di decidere', { skip: !runDbTests }, async () => {
  const { request } = await createRequest();
  await assert.rejects(
    decide(request.id, collaborator, 'APPROVED'),
    /active Admin actor/i,
  );
  const unchanged = await db().aiExecutionRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(unchanged.status, 'PENDING_ADMIN_APPROVAL');
  assert.equal(await db().aiExecutionAuthorizationGrant.count({ where: { requestId: request.id } }), 0);
});

test('Admin può approvare una propria richiesta solo con una seconda azione', { skip: !runDbTests }, async () => {
  const { request } = await createRequest({ requester: adminOne });
  assert.equal(await db().aiExecutionAuthorizationGrant.count({ where: { requestId: request.id } }), 0);
  await decide(request.id, adminOne, 'APPROVED');
  const approved = await db().aiExecutionRequest.findUniqueOrThrow({
    where: { id: request.id },
    include: { authorizationGrant: true, decisions: { orderBy: { sequence: 'asc' } } },
  });
  assert.equal(approved.status, 'APPROVED');
  assert.ok(approved.authorizationGrant);
  assert.deepEqual(approved.decisions.map(({ decisionType }) => decisionType), ['REQUESTED', 'APPROVED']);
});

test('due approvazioni concorrenti producono un solo grant', { skip: !runDbTests }, async () => {
  const { request } = await createRequest();
  const results = await Promise.allSettled([
    decide(request.id, adminOne, 'APPROVED'),
    decide(request.id, adminTwo, 'APPROVED'),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(await db().aiExecutionAuthorizationGrant.count({ where: { requestId: request.id } }), 1);
  assert.equal(await db().aiExecutionDecision.count({
    where: { requestId: request.id, decisionType: 'APPROVED' },
  }), 1);
});

test('fingerprint, richiesta e grant devono coincidere prima del consumo', { skip: !runDbTests }, async () => {
  const first = await approvedRequest();
  const second = await approvedRequest();
  await assert.rejects(
    createBoundRun(first, { requestFingerprint: 'f'.repeat(64) }),
    /immutable authorization request binding/i,
  );
  await assert.rejects(
    createBoundRun(first, { authorizationGrantId: second.grant.id }),
    /invalid, expired, revoked or mismatched/i,
  );
  await assert.rejects(
    createBoundRun(first, {
      executionInputHash: first.executionInputHash,
      input: { synthetic: false },
    }),
    /immutable authorization request binding/i,
  );
  await assert.rejects(
    db().aiExecutionRequest.update({
      where: { id: first.request.id },
      data: { inputFingerprint: 'e'.repeat(64) },
    }),
    /binding is immutable/i,
  );
  assert.equal(await db().aiRun.count({ where: { aiExecutionRequestId: first.request.id } }), 0);
});

test('revoca e scadenza negano il consumo', { skip: !runDbTests }, async () => {
  const revoked = await approvedRequest();
  await decide(revoked.request.id, adminOne, 'REVOKED');
  await assert.rejects(createBoundRun(revoked), /invalid, expired, revoked or mismatched/i);

  const expiring = await approvedRequest({ expiresInMs: 3_000 });
  await new Promise((resolve) => setTimeout(resolve, 3_100));
  await assert.rejects(createBoundRun(expiring), /invalid, expired, revoked or mismatched/i);
  await db().aiExecutionDecision.create({
    data: {
      requestId: expiring.request.id,
      decisionType: 'EXPIRED',
      actorUserId: null,
      actorRole: null,
      reasonCode: 'AI_EXECUTION_EXPIRED',
      reason: 'Richiesta sintetica scaduta prima del consumo nel test PostgreSQL.',
      requestFingerprint: expiring.fingerprint,
    },
  });
  const expired = await db().aiExecutionRequest.findUniqueOrThrow({ where: { id: expiring.request.id } });
  assert.equal(expired.status, 'EXPIRED');
});

test('consumo è atomico, monouso e vincola un solo AiRun affidabile', { skip: !runDbTests }, async () => {
  const fixture = await approvedRequest();
  const attempts = await Promise.allSettled([
    createBoundRun(fixture),
    createBoundRun(fixture),
  ]);
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);
  const fulfilled = attempts.find(
    (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof createBoundRun>>> =>
      attempt.status === 'fulfilled',
  );
  assert.ok(fulfilled);
  const run = fulfilled.value;
  assert.equal(run.status, 'running');
  const consumed = await db().aiExecutionRequest.findUniqueOrThrow({
    where: { id: fixture.request.id },
    include: { decisions: { orderBy: { sequence: 'asc' } }, runs: true },
  });
  assert.equal(consumed.status, 'CONSUMED');
  assert.equal(consumed.runs.length, 1);
  assert.deepEqual(consumed.decisions.map(({ decisionType }) => decisionType), [
    'REQUESTED',
    'APPROVED',
    'CONSUMED',
  ]);
  await assert.rejects(
    db().aiRun.delete({ where: { id: run.id } }),
    /append-only and cannot be deleted/i,
  );
  assert.equal(await db().aiRun.count({ where: { authorizationGrantId: fixture.grant.id } }), 1);
});

test('input modificato invalida reservation e capability token prima del provider mock', { skip: !runDbTests }, async () => {
  const authorizedInput = { synthetic: true, version: 1 };
  const fixture = await approvedRequest({ executionInput: authorizedInput });
  await assert.rejects(
    reserveAuthorizedAiRun({
      requestId: fixture.request.id,
      authorizationGrantId: fixture.grant.id,
      inputFingerprint: fixture.fingerprint,
      input: { ...authorizedInput, version: 2 },
    }),
    /input modificati/i,
  );
  assert.equal(
    await db().aiRun.count({ where: { authorizationGrantId: fixture.grant.id } }),
    0,
  );
  const reservation = await reserveAuthorizedAiRun({
    requestId: fixture.request.id,
    authorizationGrantId: fixture.grant.id,
    inputFingerprint: fixture.fingerprint,
    input: authorizedInput,
  });
  await assert.rejects(
    new MockAiAdapter().run(
      { code: agentConfig.code, role: agentConfig.name },
      { ...authorizedInput, version: 2 },
      reservation.runtimePermit,
    ),
    /input modificati/i,
  );
  assert.equal(
    await db().aiRun.count({ where: { authorizationGrantId: fixture.grant.id } }),
    1,
  );
});

test('un nuovo AiRun senza richiesta e grant è sempre respinto', { skip: !runDbTests }, async () => {
  await assert.rejects(
    db().aiRun.create({
      data: {
        agentId: agentConfig.agentId,
        agentConfigVersion: agentConfig.version,
        status: 'running',
        provider: 'mock',
        model: 'mock-template-v1',
        promptVersion: agentConfig.promptVersion,
        reliabilityVersion: 1,
        requestKey: randomUUID(),
        requestFingerprint: sha(randomUUID()),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseTokenHash: sha(`lease:${randomUUID()}`),
        createdById: collaborator.id,
      },
    }),
    /manual Admin authorization grant/i,
  );
});

test('una rigenerazione usa una nuova richiesta e non riutilizza il grant precedente', { skip: !runDbTests }, async () => {
  const first = await approvedRequest();
  await createBoundRun(first);
  const second = await createRequest({ requester: first.requester });
  assert.notEqual(second.request.id, first.request.id);
  assert.notEqual(second.key, first.key);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(second.request.status, 'PENDING_ADMIN_APPROVAL');
  assert.equal(await db().aiExecutionAuthorizationGrant.count({ where: { requestId: second.request.id } }), 0);
});

test('NEEDS_INFORMATION è terminale e la sostituzione v2 crea identità, ledger e notifiche indipendenti', { skip: !runDbTests }, async () => {
  const first = await createRequest();
  await decide(first.request.id, adminOne, 'NEEDS_INFORMATION');
  for (const decisionType of ['APPROVED', 'CANCELLED', 'EXPIRED'] as const) {
    await assert.rejects(db().aiExecutionDecision.create({ data: {
      requestId: first.request.id, decisionType,
      actorUserId: decisionType === 'EXPIRED' ? null : adminOne.id,
      actorRole: decisionType === 'EXPIRED' ? null : adminOne.role,
      reasonCode: `AI_EXECUTION_${decisionType}`,
      reason: `Decisione sintetica ${decisionType.toLowerCase()} vietata sul terminale.`,
      requestFingerprint: first.fingerprint,
    } }), /terminal/i);
  }
  const replacements = await Promise.allSettled([
    createRequest({ requester: first.requester, hashCanonicalizationVersion: 2,
      supersedesRequestId: first.request.id, executionInput: { synthetic: true, integrated: 'new' } }),
    createRequest({ requester: first.requester, hashCanonicalizationVersion: 2,
      supersedesRequestId: first.request.id, executionInput: { synthetic: true, integrated: 'concurrent' } }),
  ]);
  assert.equal(replacements.filter(x => x.status === 'fulfilled').length, 1);
  const winner = replacements.find((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof createRequest>>> => x.status === 'fulfilled');
  assert.ok(winner);
  const second = winner.value;
  assert.notEqual(second.request.id, first.request.id);
  assert.notEqual(second.key, first.key);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.notEqual(second.executionInputHash, first.executionInputHash);
  assert.equal(second.request.hashCanonicalizationVersion, 2);
  assert.equal(second.request.supersedesRequestId, first.request.id);
  assert.deepEqual((await db().aiExecutionDecision.findMany({ where: { requestId: second.request.id } })).map(x => x.decisionType), ['REQUESTED']);
  assert.ok(await db().aiExecutionAdminNotification.count({ where: { requestId: second.request.id } }) >= 2);
  assert.equal(await db().aiExecutionAuthorizationGrant.count({ where: { requestId: first.request.id } }), 0);
  await assert.rejects(createRequest({ requester: first.requester, hashCanonicalizationVersion: 2,
    supersedesRequestId: first.request.id, executionInput: { synthetic: true, integrated: 'another' } }), /Unique constraint|supersedes/i);
});

test('il replacement service valida richiedente e continuità e serializza due reinvii concorrenti', { skip: !runDbTests }, async () => {
  const first = await createRequest();
  await decide(first.request.id, adminOne, 'NEEDS_INFORMATION');

  await assert.rejects(
    createAiExecutionReplacementRequest(sessionFor(adminOne), first.request.id, replacementBinding('wrong-requester')),
    /non disponibile.*perimetro autorizzato/i,
  );
  await assert.rejects(
    createAiExecutionReplacementRequest(sessionFor(collaborator), first.request.id, {
      ...replacementBinding('wrong-function'),
      functionCode: 'OTHER_FUNCTION',
    }),
    /non disponibile.*perimetro autorizzato/i,
  );
  assert.equal(await db().aiExecutionRequest.count({ where: { supersedesRequestId: first.request.id } }), 0);

  const concurrent = await Promise.allSettled([
    createAiExecutionReplacementRequest(sessionFor(collaborator), first.request.id, replacementBinding('service-one')),
    createAiExecutionReplacementRequest(sessionFor(collaborator), first.request.id, replacementBinding('service-two')),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
  const winner = concurrent.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createAiExecutionReplacementRequest>>> => result.status === 'fulfilled');
  assert.ok(winner);
  assert.equal(winner.value.supersedesRequestId, first.request.id);
  assert.equal(winner.value.requesterUserId, collaborator.id);
  assert.equal(winner.value.hashCanonicalizationVersion, 2);
  assert.equal(await db().aiExecutionRequest.count({ where: { supersedesRequestId: first.request.id } }), 1);
  assert.deepEqual(
    (await db().aiExecutionDecision.findMany({ where: { requestId: winner.value.id } })).map((decision) => decision.decisionType),
    ['REQUESTED'],
  );
  const activeAdminCount = await db().user.count({ where: { role: 'admin', active: true, deletedAt: null } });
  assert.equal(await db().aiExecutionAdminNotification.count({ where: { requestId: winner.value.id } }), activeAdminCount);
  const unchanged = await db().aiExecutionRequest.findUniqueOrThrow({ where: { id: first.request.id } });
  assert.equal(unchanged.status, 'NEEDS_INFORMATION');
  assert.equal(await db().aiExecutionAuthorizationGrant.count({ where: { requestId: first.request.id } }), 0);
  assert.equal(await db().aiRun.count({ where: { aiExecutionRequestId: first.request.id } }), 0);
});

test('request, grant, AiRun e permit applicano version binding v2 fail-closed', { skip: !runDbTests }, async () => {
  const input = { amount: 1e-7, nested: [1e21, -0, '😀'] };
  const fixture = await approvedRequest({ hashCanonicalizationVersion: 2, executionInput: input });
  assert.equal(fixture.grant.hashCanonicalizationVersion, 2);
  await assert.rejects(createBoundRun(fixture, { hashCanonicalizationVersion: 1 }), /version.*mismatch/i);
  await assert.rejects(createBoundRun(fixture, { hashCanonicalizationVersion: null }), /version.*missing/i);
  const reservation = await reserveAuthorizedAiRun({ requestId: fixture.request.id,
    authorizationGrantId: fixture.grant.id, inputFingerprint: fixture.fingerprint, input });
  assert.equal(reservation.run.hashCanonicalizationVersion, 2);
  const consumed = new MockAiAdapter().run({ code: agentConfig.code, role: agentConfig.name }, input, reservation.runtimePermit);
  assert.ok(consumed);
});
