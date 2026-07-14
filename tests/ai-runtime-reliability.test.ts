import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import {
  canonicalJson,
  canonicalSha256,
  createAiRequestFingerprint,
  createAiRunLeaseWithDbClock,
  getAiRunLeaseBinding,
  resolveIdempotentAiRunState,
} from '../src/lib/ai-run-reliability';
import {
  consumeExternalAiPermit,
  issueExternalAiPermit,
  prepareExternalAiPermit,
} from '../src/lib/ai-control-plane';
import { createOpenAiDiagnosticRequestBody } from '../src/lib/ai';
import { aiRequestKeySchema } from '../src/lib/validation';

const root = process.cwd();

function dbClock(now: Date) {
  return { $queryRaw: async () => [{ now }] } as never;
}

function functionBody(file: string, name: string) {
  const path = resolve(root, file);
  const text = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let declaration: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    if (!declaration) ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(declaration?.body, `Funzione ${name} non trovata in ${file}`);
  return declaration.body.getText(source);
}

test('requestKey accetta soltanto UUID v4 lowercase generati per il form', () => {
  assert.equal(
    aiRequestKeySchema.parse('9c36b1af-c0fc-4f81-a3bb-1798ba19dc4d'),
    '9c36b1af-c0fc-4f81-a3bb-1798ba19dc4d',
  );
  for (const invalid of [
    '9C36B1AF-C0FC-4F81-A3BB-1798BA19DC4D',
    '9c36b1af-c0fc-1f81-a3bb-1798ba19dc4d',
    '9c36b1af-c0fc-4f81-73bb-1798ba19dc4d',
    'not-a-request-key',
  ]) {
    assert.equal(aiRequestKeySchema.safeParse(invalid).success, false, invalid);
  }
});

test('canonicalizzazione e hash vincolano il corpo JSON esatto senza dipendere dall ordine delle chiavi', () => {
  const body = {
    store: false,
    input: [{ role: 'user', content: [{ text: 'Contesto minimo', type: 'input_text' }] }],
    model: 'gpt-approved',
  };
  const sameBodyDifferentKeyOrder = {
    model: 'gpt-approved',
    input: [{ content: [{ type: 'input_text', text: 'Contesto minimo' }], role: 'user' }],
    store: false,
  };
  const canonical = '{"input":[{"content":[{"text":"Contesto minimo","type":"input_text"}],"role":"user"}],"model":"gpt-approved","store":false}';
  const independentDigest = createHash('sha256').update(canonical, 'utf8').digest('hex');

  assert.equal(canonicalJson(body), canonical);
  assert.equal(canonicalJson(sameBodyDifferentKeyOrder), canonical);
  assert.equal(canonicalSha256(body), independentDigest);
  assert.equal(createAiRequestFingerprint(sameBodyDifferentKeyOrder), independentDigest);
  assert.notEqual(canonicalSha256({ ...body, store: true }), independentDigest);
  assert.notEqual(canonicalSha256(['first', 'second']), canonicalSha256(['second', 'first']));
  assert.throws(() => canonicalJson({ field: undefined }), /undefined non JSON/i);
});

test('permit OpenAI verifica la reservation e consuma con CAS DB il digest del corpo esatto', async () => {
  const now = new Date('2026-07-14T12:00:00.000Z');
  const lease = await createAiRunLeaseWithDbClock(dbClock(now), { runId: 'run-egress-1', durationMs: 60_000 });
  const preparedPermit = prepareExternalAiPermit();
  const requestBody = createOpenAiDiagnosticRequestBody('gpt-approved');
  const externalPayloadHash = canonicalSha256(requestBody);
  const requestFingerprint = createAiRequestFingerprint({ kind: 'diagnostic', model: 'gpt-approved' });
  const categories = ['agent_configuration'] as const;
  let reservationWhere: Record<string, unknown> | undefined;
  let egressWhere: Record<string, unknown> | undefined;
  let egressData: Record<string, unknown> | undefined;
  let updateCalls = 0;
  const db = {
    aiControlSetting: {
      findUnique: async () => ({
        externalProvidersEnabled: true,
        maxExternalRunsPerUserPerHour: 10,
        updatedById: 'admin-1',
        updatedAt: now,
      }),
    },
    aiRun: {
      findFirst: async (query: { where: Record<string, unknown> }) => {
        reservationWhere = query.where;
        return { externalDataCategories: [...categories] };
      },
      updateMany: async (query: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updateCalls += 1;
        egressWhere = query.where;
        egressData = query.data;
        return { count: 1 };
      },
    },
  };
  const env = {
    NODE_ENV: 'test',
    AI_EXTERNAL_PROVIDERS_ENABLED: 'true',
    AI_ALLOWED_MODELS: 'gpt-approved',
  } as NodeJS.ProcessEnv;
  const permit = await issueExternalAiPermit({
    seed: preparedPermit.seed,
    lease: lease.lease,
    runId: lease.runId,
    userId: 'user-1',
    requestKey: '9c36b1af-c0fc-4f81-a3bb-1798ba19dc4d',
    requestFingerprint,
    agentId: 'agent-1',
    agentConfigVersion: 4,
    model: 'gpt-approved',
    dataCategories: categories,
    externalPayloadHash,
    db: db as never,
  });

  assert.deepEqual(reservationWhere, {
    id: 'run-egress-1',
    reliabilityVersion: 1,
    status: 'running',
    createdById: 'user-1',
    requestKey: '9c36b1af-c0fc-4f81-a3bb-1798ba19dc4d',
    requestFingerprint,
    agentId: 'agent-1',
    agentConfigVersion: 4,
    provider: 'openai',
    model: 'gpt-approved',
    leaseTokenHash: lease.leaseTokenHash,
    leaseExpiresAt: lease.leaseExpiresAt,
    egressPermitHash: preparedPermit.egressPermitHash,
    egressStartedAt: null,
    externalPayloadHash,
    externalConfirmedAt: { not: null },
  });

  await consumeExternalAiPermit(permit, 'gpt-approved', requestBody, { db: db as never, env, now });
  assert.equal(updateCalls, 1);
  assert.deepEqual(egressWhere, {
    id: 'run-egress-1',
    reliabilityVersion: 1,
    status: 'running',
    createdById: 'user-1',
    requestKey: '9c36b1af-c0fc-4f81-a3bb-1798ba19dc4d',
    requestFingerprint,
    agentId: 'agent-1',
    agentConfigVersion: 4,
    provider: 'openai',
    model: 'gpt-approved',
    leaseTokenHash: lease.leaseTokenHash,
    leaseExpiresAt: { gt: now },
    egressPermitHash: preparedPermit.egressPermitHash,
    egressStartedAt: null,
    externalPayloadHash,
    externalDataCategories: { equals: [...categories] },
  });
  assert.deepEqual(egressData, { egressPermitHash: null, egressStartedAt: now });
  await assert.rejects(
    consumeExternalAiPermit(permit, 'gpt-approved', requestBody, { db: db as never, env, now }),
    /non valida/i,
  );
  assert.equal(updateCalls, 1, 'il riuso della capability non deve raggiungere il DB');
});

test('permit OpenAI nega corpo mutato e CAS perso senza effettuare un secondo egress', async () => {
  const now = new Date('2026-07-14T12:00:00.000Z');
  const env = {
    NODE_ENV: 'test',
    AI_EXTERNAL_PROVIDERS_ENABLED: 'true',
    AI_ALLOWED_MODELS: 'gpt-approved',
  } as NodeJS.ProcessEnv;
  const categories = ['agent_configuration'] as const;
  const makePermit = async (runId: string, updateCount: number) => {
    const lease = await createAiRunLeaseWithDbClock(dbClock(now), { runId, durationMs: 60_000 });
    const prepared = prepareExternalAiPermit();
    const body = createOpenAiDiagnosticRequestBody('gpt-approved');
    let updates = 0;
    const db = {
      aiControlSetting: {
        findUnique: async () => ({
          externalProvidersEnabled: true,
          maxExternalRunsPerUserPerHour: 10,
          updatedById: null,
          updatedAt: now,
        }),
      },
      aiRun: {
        findFirst: async () => ({ externalDataCategories: [...categories] }),
        updateMany: async () => {
          updates += 1;
          return { count: updateCount };
        },
      },
    };
    const permit = await issueExternalAiPermit({
      seed: prepared.seed,
      lease: lease.lease,
      runId,
      userId: 'user-1',
      requestKey: '9c36b1af-c0fc-4f81-a3bb-1798ba19dc4d',
      requestFingerprint: createAiRequestFingerprint({ runId }),
      agentId: 'agent-1',
      agentConfigVersion: 4,
      model: 'gpt-approved',
      dataCategories: categories,
      externalPayloadHash: canonicalSha256(body),
      db: db as never,
    });
    return { body, db, permit, updates: () => updates };
  };

  const changedBody = await makePermit('run-egress-body-change', 1);
  await assert.rejects(
    consumeExternalAiPermit(
      changedBody.permit,
      'gpt-approved',
      { ...changedBody.body, max_output_tokens: 17 },
      { db: changedBody.db as never, env, now },
    ),
    /non valida/i,
  );
  assert.equal(changedBody.updates(), 0, 'un body differente deve fallire prima della CAS');

  const lostCas = await makePermit('run-egress-lost-cas', 0);
  await assert.rejects(
    consumeExternalAiPermit(lostCas.permit, 'gpt-approved', lostCas.body, { db: lostCas.db as never, env, now }),
    /non valida/i,
  );
  assert.equal(lostCas.updates(), 1, 'la CAS persa deve essere tentata una sola volta');
});

test('il ramo egress di produzione ricontrolla policy e reservation con DB-clock in transazione serializable', () => {
  const transition = functionBody('src/lib/ai-control-plane.ts', 'consumeExternalAiPermitWithTransaction');
  const consume = functionBody('src/lib/ai-control-plane.ts', 'consumeExternalAiPermit');
  const lockedPolicy = functionBody('src/lib/ai-control-plane.ts', 'lockAndAssertExternalEgressStillAllowed');
  const policy = transition.indexOf('await lockAndAssertExternalEgressStillAllowed');
  const update = transition.indexOf('db.$queryRaw');

  assert.ok(policy >= 0 && policy < update);
  assert.match(lockedPolicy, /FROM "AiControlSetting"[\s\S]*FOR SHARE/);
  assert.match(lockedPolicy, /isExternalProviderEnvironmentEnabled\(env\)/);
  assert.match(lockedPolicy, /isExternalModelAllowed\(claims\.model, env\)/);
  for (const predicate of [
    '"id" = ${claims.runId}',
    '"createdById" = ${claims.userId}',
    '"requestKey" = ${claims.requestKey}',
    '"requestFingerprint" = ${claims.requestFingerprint}',
    '"agentId" = ${claims.agentId}',
    '"agentConfigVersion" = ${claims.agentConfigVersion}',
    '"model" = ${claims.model}',
    '"leaseTokenHash" = ${claims.leaseTokenHash}',
    '"leaseExpiresAt" = ${claims.leaseExpiresAt}',
    '"egressPermitHash" = ${claims.permitHash}',
    '"externalPayloadHash" = ${expectedPayloadHash}',
    '"externalDataCategories" = CAST(${categoriesJson} AS jsonb)',
  ]) {
    assert.ok(transition.includes(predicate), `predicato egress assente: ${predicate}`);
  }
  assert.match(transition, /"provider" = 'openai'/);
  assert.match(transition, /"leaseExpiresAt" > \(clock_timestamp\(\) AT TIME ZONE 'UTC'\)/);
  assert.match(transition, /"egressStartedAt" = clock_timestamp\(\) AT TIME ZONE 'UTC'/);
  assert.match(transition, /"egressStartedAt" IS NULL/);
  assert.match(consume, /prisma\.\$transaction/);
  assert.match(consume, /consumeExternalAiPermitWithTransaction/);
  assert.match(consume, /isolationLevel: 'Serializable'/);
  assert.match(consume, /if \(env\.NODE_ENV !== 'test'\) invalidRuntimePermit\(\)/);
});

test('lease e finestra rate-limit di produzione derivano dal clock UTC del database', () => {
  const leaseClock = functionBody('src/lib/ai-run-reliability.ts', 'createAiRunLeaseWithDbClock');
  const rateClock = functionBody('src/lib/ai-control-plane.ts', 'databaseUtcNow');
  const policy = functionBody('src/lib/ai-control-plane.ts', 'assertExternalAiRunAllowed');

  assert.match(leaseClock, /clock_timestamp\(\) AT TIME ZONE 'UTC'/);
  assert.match(rateClock, /clock_timestamp\(\) AT TIME ZONE 'UTC'/);
  assert.match(policy, /const now = options\.now \?\? await databaseUtcNow\(db\)/);
  assert.match(policy, /if \(options\.now && env\.NODE_ENV !== 'test'\)/);
});

test('adapter e diagnostica consumano il permit sul medesimo body poi serializzato nel fetch', () => {
  const source = readFileSync(resolve(root, 'src/lib/ai.ts'), 'utf8');
  const adapterStart = source.indexOf('export class OpenAiAdapter');
  const diagnosticStart = source.indexOf('export async function testAiProviderDiagnostic');
  const adapterSection = source.slice(adapterStart, diagnosticStart);
  const diagnosticSection = source.slice(diagnosticStart);

  for (const [label, section] of [['adapter', adapterSection], ['diagnostica', diagnosticSection]] as const) {
    const body = section.indexOf('const requestBody =');
    const consume = section.indexOf('await consumeExternalAiPermit(permit,', body);
    const fetch = section.indexOf("fetch('https://api.openai.com/v1/responses'", consume);
    const serializedBody = section.indexOf('body: JSON.stringify(requestBody)', fetch);
    assert.ok(body >= 0 && body < consume && consume < fetch && fetch < serializedBody, label);
    assert.match(section.slice(consume, fetch), /consumeExternalAiPermit\(permit,[\s\S]*requestBody\)/);
  }
});

test('resolver idempotente riusa solo completed con stesso fingerprint e non autorizza rerun impliciti', () => {
  const fingerprint = createAiRequestFingerprint({ requestKey: 'intent-1', instructions: 'Analizza' });

  assert.equal(resolveIdempotentAiRunState({ status: 'completed', requestFingerprint: fingerprint }, fingerprint), 'completed');
  assert.throws(
    () => resolveIdempotentAiRunState({ status: 'completed', requestFingerprint: createAiRequestFingerprint('altro') }, fingerprint),
    /contenuto differente/i,
  );
  assert.throws(
    () => resolveIdempotentAiRunState({ status: 'running', requestFingerprint: fingerprint }, fingerprint),
    /già in corso/i,
  );
  assert.throws(
    () => resolveIdempotentAiRunState({ status: 'failed', requestFingerprint: fingerprint }, fingerprint),
    /nuovo tentativo/i,
  );
});

test('tutti gli ingressi runtime riservano per utente e requestKey prima di invocare il provider', () => {
  const cases = [
    ['runAiProviderDiagnosticTest', 'testAiProviderDiagnostic(reservation.permit)'],
    ['runClientAiAgent', 'agentRuntime.adapter.run'],
    ['runMockAgent', 'new MockAiAdapter().run'],
  ] as const;

  for (const [name, providerMarker] of cases) {
    const body = functionBody('src/lib/actions.ts', name);
    const reconcile = body.indexOf('reconcileExpiredAiRuns');
    const fingerprint = body.indexOf('createAiRequestFingerprint');
    const firstExistingRead = body.indexOf('existingAiRunForRequest');
    const reservation = body.indexOf('withSerializableAiTransaction');
    const createRun = body.indexOf('tx.aiRun.create', reservation);
    const provider = body.indexOf(providerMarker);

    assert.ok(
      reconcile >= 0
      && reconcile < fingerprint
      && fingerprint < firstExistingRead
      && firstExistingRead < reservation
      && reservation < createRun
      && createRun < provider,
      name,
    );
    assert.match(body, /createdById_requestKey: \{ createdById: s\.userId, requestKey/);
    assert.match(body, /ExistingAiRunReservationError/);
    assert.match(body, /isUniqueConstraintError\(error\)[\s\S]*existingAiRunForRequest/);
    assert.match(body, /reliabilityVersion: AI_RUN_RELIABILITY_VERSION/);
    assert.match(body, /agentConfigVersion:/);
    assert.match(body, /requestKey[:,]/);
    assert.match(body, /requestFingerprint[,\n]/);
    assert.match(body, /createAiRunLeaseWithDbClock\(tx\)/);
    assert.match(body, /createdAt: lease\.leaseStartedAt/);
    assert.match(body, /leaseExpiresAt: lease\.leaseExpiresAt/);
    assert.match(body, /leaseTokenHash: lease\.leaseTokenHash/);
  }
});

test('duplicate completed riusa un solo output dopo ABAC mentre running e failed non raggiungono il provider', () => {
  const resolver = functionBody('src/lib/actions.ts', 'resolveExistingAiOutput');
  const client = functionBody('src/lib/actions.ts', 'runClientAiAgent');
  const quickMock = functionBody('src/lib/actions.ts', 'runMockAgent');
  const diagnostic = functionBody('src/lib/actions.ts', 'runAiProviderDiagnosticTest');

  assert.match(resolver, /assertReliableDuplicate\(run, requestFingerprint\)/);
  assert.match(resolver, /const currentSession = await requirePermission\(permission\)/);
  assert.match(resolver, /currentSession\.userId !== session\.userId/);
  assert.match(resolver, /where: \{ aiRunId: run\.id \}/);
  assert.match(resolver, /select: \{ id: true \}/);
  assert.match(resolver, /outputs\.length !== 1/);
  assert.match(resolver, /requireAiOutputReadAccess\(currentSession, outputs\[0\]\.id\)/);

  const clientExisting = client.indexOf('if (existing) return resolveExistingAiOutput');
  const clientProvider = client.indexOf('agentRuntime.adapter.run');
  const mockExisting = quickMock.indexOf('if (existing) return resolveExistingAiOutput');
  const mockProvider = quickMock.indexOf('new MockAiAdapter().run');
  const diagnosticExisting = diagnostic.indexOf('if (existing)');
  const diagnosticProvider = diagnostic.indexOf('testAiProviderDiagnostic(reservation.permit)');
  assert.ok(clientExisting >= 0 && clientExisting < clientProvider);
  assert.ok(mockExisting >= 0 && mockExisting < mockProvider);
  assert.ok(diagnosticExisting >= 0 && diagnosticExisting < diagnosticProvider);
  assert.match(diagnostic.slice(diagnosticExisting, diagnosticProvider), /assertReliableDuplicate\(existing, requestFingerprint\)/);
});

test('reservation OpenAI deriva e persiste il digest dal body condiviso prima di emettere il permit', () => {
  const cases = [
    ['runAiProviderDiagnosticTest', 'exactDiagnosticBody', 'testAiProviderDiagnostic(reservation.permit)'],
    ['runClientAiAgent', 'exactProviderBody', 'agentRuntime.adapter.run'],
  ] as const;

  for (const [name, bodyVariable, providerMarker] of cases) {
    const body = functionBody('src/lib/actions.ts', name);
    const exactBody = body.indexOf(`const ${bodyVariable}`);
    const digest = body.indexOf(`canonicalSha256(${bodyVariable})`, exactBody);
    const preparePermit = body.indexOf('prepareExternalAiPermit()', digest);
    const createRun = body.indexOf('tx.aiRun.create', preparePermit);
    const persistDigest = body.indexOf('externalPayloadHash', createRun);
    const issuePermit = body.indexOf('issueExternalAiPermit', createRun);
    const provider = body.indexOf(providerMarker, issuePermit);

    assert.ok(
      exactBody >= 0
      && exactBody < digest
      && exactBody < preparePermit
      && Math.max(digest, preparePermit) < createRun
      && createRun < persistDigest
      && persistDigest < issuePermit
      && issuePermit < provider,
      name,
    );
    assert.match(body.slice(issuePermit, provider), /externalPayloadHash/);
    assert.match(body.slice(issuePermit, provider), /lease: lease\.lease/);
    assert.match(body.slice(issuePermit, provider), /agentConfigVersion: currentSnapshot\.version/);
  }
});

test('transizioni terminali di diagnostica, cliente e quick mock sono tutte fenced dalla lease', () => {
  const failure = functionBody('src/lib/actions.ts', 'markAiRunFailedBestEffort');
  const transition = functionBody('src/lib/ai-run-reliability.ts', 'transitionAiRunWithLease');
  assert.match(failure, /failAiRunWithLease\(tx, options\.lease/);
  assert.match(failure, /failureCode: options\.errorCode/);

  for (const name of ['runAiProviderDiagnosticTest', 'runClientAiAgent', 'runMockAgent']) {
    const body = functionBody('src/lib/actions.ts', name);
    assert.match(body, /completeAiRunWithLease\(tx, reservation\.lease/, name);
    assert.match(body, /markAiRunFailedBestEffort\(\{[\s\S]*lease: reservation\.lease/, name);
    assert.doesNotMatch(body, /where: \{ id: [^}]+, status: 'running' \}[\s\S]*status: 'completed'/, name);
  }

  assert.match(transition, /"leaseTokenHash" = \$\{binding\.leaseTokenHash\}/);
  assert.match(transition, /"leaseExpiresAt" = \$\{binding\.leaseExpiresAt\}/);
  assert.match(transition, /"leaseExpiresAt" > \(clock_timestamp\(\) AT TIME ZONE 'UTC'\)/);
  assert.match(transition, /"finishedAt" = GREATEST\(clock_timestamp\(\) AT TIME ZONE 'UTC', "createdAt"\)/);
  for (const field of ['leaseExpiresAt', 'leaseTokenHash', 'egressPermitHash']) {
    assert.match(transition, new RegExp(`"${field}" = NULL`));
  }
});

test('la lease opaca usa il clock UTC del database e non espone il segreto', async () => {
  const now = new Date('2026-07-14T12:00:00.000Z');
  const prepared = await createAiRunLeaseWithDbClock(dbClock(now), { runId: 'run-1', durationMs: 60_000 });
  const binding = getAiRunLeaseBinding(prepared.lease);

  assert.equal(binding.runId, 'run-1');
  assert.equal(binding.leaseTokenHash, prepared.leaseTokenHash);
  assert.match(binding.leaseTokenHash, /^[0-9a-f]{64}$/);
  assert.equal(prepared.leaseStartedAt.toISOString(), now.toISOString());
  assert.equal(binding.leaseExpiresAt.toISOString(), '2026-07-14T12:01:00.000Z');
  assert.throws(() => getAiRunLeaseBinding({} as never), /lease runtime AI assente o non valida/i);
});

test('reconciler usa una CAS sulla lease scaduta e può soltanto terminalizzare come failed', () => {
  const body = functionBody('src/lib/ai-run-reliability.ts', 'reconcileExpiredAiRuns');
  const transition = body.indexOf('tx.$queryRaw');
  const audit = body.indexOf('tx.auditLog.createMany');

  assert.ok(transition >= 0 && transition < audit);
  assert.match(body, /WITH candidates AS/);
  assert.match(body, /"reliabilityVersion" = \$\{AI_RUN_RELIABILITY_VERSION\}/);
  assert.match(body, /"status" = 'running'/);
  assert.match(body, /"leaseExpiresAt" <= \(clock_timestamp\(\) AT TIME ZONE 'UTC'\)/);
  assert.match(body, /FOR UPDATE SKIP LOCKED/);
  assert.match(body, /"status" = 'failed'/);
  assert.match(body, /"failureCode" = 'AI_RUN_LEASE_EXPIRED'/);
  assert.match(body, /"finishedAt" = GREATEST\(clock_timestamp\(\) AT TIME ZONE 'UTC', run\."createdAt"\)/);
  assert.match(body, /externalEgressMayHaveStarted: Boolean\(run\.egressStartedAt\)/);
  assert.match(body, /event: 'ai_run_lease_expired'/);
  assert.doesNotMatch(body, /fetch\(|adapter\.run|testAiProviderDiagnostic|status:\s*'completed'|leaseExpiresAt:\s*\{\s*gt:/);
});

test('il comando schedulabile riconcilia batch limitati senza invocare provider', () => {
  const script = readFileSync(resolve(root, 'scripts/reconcile-ai-runs.ts'), 'utf8');
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.['ai:reconcile'], 'tsx scripts/reconcile-ai-runs.ts');
  assert.match(script, /reconcileExpiredAiRuns\(\{ batchSize: 100 \}\)/);
  assert.match(script, /prisma\.\$disconnect\(\)/);
  assert.doesNotMatch(script, /fetch\(|adapter|OpenAi|provider/i);
});

test('migrazione reliability v1 preserva il legacy e collega ogni nuovo run allo snapshot immutabile', () => {
  const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
  const migration = readFileSync(
    resolve(root, 'prisma/migrations/20260714150000_ai_runtime_reliability_v1/migration.sql'),
    'utf8',
  );

  assert.match(schema, /reliabilityVersion\s+Int\?/);
  assert.match(schema, /agentConfig\s+AiAgentConfigVersion\?[\s\S]*fields: \[agentId, agentConfigVersion\][\s\S]*references: \[agentId, version\]/);
  assert.match(schema, /@@unique\(\[createdById, requestKey\]\)/);
  assert.match(schema, /@@index\(\[status, leaseExpiresAt\]\)/);

  assert.match(migration, /^--[\s\S]*?\nBEGIN;/);
  assert.match(migration, /ADD COLUMN "reliabilityVersion" INTEGER[,;]/);
  assert.doesNotMatch(migration, /ADD COLUMN "reliabilityVersion" INTEGER[^,;]*DEFAULT/i);
  assert.match(migration, /CHECK \("reliabilityVersion" IS NULL OR "reliabilityVersion" = 1\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "AiRun_createdById_requestKey_key"[\s\S]*\("createdById", "requestKey"\)/);
  assert.match(migration, /"reliabilityVersion" IS NULL[\s\S]*"requestKey" IS NOT NULL[\s\S]*"requestFingerprint" IS NOT NULL/);
  assert.match(migration, /"requestKey" ~ '\^\[0-9a-f\][\s\S]*4\[0-9a-f\][\s\S]*\[89ab\][\s\S]*\$'/);
  assert.match(migration, /"requestFingerprint" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /"externalPayloadHash" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /FOREIGN KEY \("agentId", "agentConfigVersion"\)[\s\S]*REFERENCES "AiAgentConfigVersion"\("agentId", "version"\)[\s\S]*ON DELETE RESTRICT ON UPDATE RESTRICT/);

  assert.match(migration, /HAVING COUNT\(DISTINCT candidate\."version"\) = 1/);
  assert.match(migration, /config\."promptVersion" = run\."promptVersion"[\s\S]*HAVING COUNT\(\*\) = 1/);
  assert.match(migration, /"status" = 'running'[\s\S]*"leaseExpiresAt" IS NOT NULL[\s\S]*"leaseTokenHash" IS NOT NULL/);
  assert.match(migration, /"status" <> 'running'[\s\S]*"leaseExpiresAt" IS NULL[\s\S]*"leaseTokenHash" IS NULL/);
  assert.match(migration, /"status" <> 'completed'[\s\S]*OR "egressStartedAt" IS NOT NULL/);
  assert.match(migration, /"egressPermitHash" IS NOT NULL[\s\S]*"egressStartedAt" IS NULL[\s\S]*"egressPermitHash" IS NULL[\s\S]*"egressStartedAt" IS NOT NULL/);
  assert.match(migration, /COMMIT;\s*$/);
});
