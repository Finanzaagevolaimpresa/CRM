import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import {
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  getAuditWorkflowTransition,
} from '../../src/lib/ai-orchestrator/audit-workflow-v1-1';
import {
  applyAuditWorkflowTransition,
  createAuditWorkflowInstance,
  type ApplyAuditWorkflowTransitionInput,
  type AuditWorkflowActor,
} from '../../src/lib/ai-orchestrator/workflow-service';

const dbTestsRequested = process.env.RUN_DB_TESTS === '1';
const destructiveDbTestsConfirmed = process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1';

function assertDedicatedTestDatabase(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error('DATABASE_URL obbligatorio per i test DB AI Orchestrator.');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL non valido per i test DB AI Orchestrator.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const schemaName = parsed.searchParams.get('schema') ?? 'public';
  const testNamePattern = /(^|[_-])test($|[_-])/i;
  if (!testNamePattern.test(databaseName) && !testNamePattern.test(schemaName)) {
    throw new Error('I test DB AI Orchestrator richiedono un database o schema dedicato con "test" nel nome.');
  }
}

if (dbTestsRequested && !destructiveDbTestsConfirmed) {
  throw new Error('Impostare AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1 per confermare il database effimero dedicato.');
}
if (dbTestsRequested) assertDedicatedTestDatabase(process.env.DATABASE_URL);

const runDbTests = dbTestsRequested && destructiveDbTestsConfirmed;
const prisma = runDbTests ? new PrismaClient() : null;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const safeEnv = { ...process.env, AI_EXTERNAL_PROVIDERS_ENABLED: 'false' };
const passwordHash = 'not-a-real-login-hash';

let runnerId = '';
let reviewerId = '';
let approverId = '';
let releaserId = '';
let limitedId = '';
let agentId = '';
let migrationDefaults: { dispatchEnabled: boolean; syntheticDataOnly: boolean; provider: string } | null = null;

function db() {
  if (!prisma) throw new Error('DB tests disabled');
  return prisma;
}

async function createUser(name: string, role: 'admin' | 'collaboratore_limitato') {
  return db().user.create({
    data: {
      email: `${name}-${runId}@example.test`,
      name: `${name}-${runId}`,
      passwordHash,
      role,
      active: true,
    },
  });
}

test.before(async () => {
  if (!runDbTests) return;
  const setting = await db().aiOrchestratorSetting.findUniqueOrThrow({ where: { id: 'global' } });
  migrationDefaults = {
    dispatchEnabled: setting.dispatchEnabled,
    syntheticDataOnly: setting.syntheticDataOnly,
    provider: setting.provider,
  };
  await db().aiOrchestratorSetting.update({
    where: { id: 'global' },
    data: { dispatchEnabled: true, syntheticDataOnly: true, provider: 'mock' },
  });
  await db().aiControlSetting.upsert({
    where: { id: 'global' },
    create: { id: 'global', externalProvidersEnabled: false, maxExternalRunsPerUserPerHour: 10 },
    update: { externalProvidersEnabled: false },
  });

  const [runner, reviewer, approver, releaser, limited] = await Promise.all([
    createUser('orchestrator-runner', 'admin'),
    createUser('orchestrator-reviewer', 'admin'),
    createUser('orchestrator-approver', 'admin'),
    createUser('orchestrator-releaser', 'admin'),
    createUser('orchestrator-limited', 'collaboratore_limitato'),
  ]);
  runnerId = runner.id;
  reviewerId = reviewer.id;
  approverId = approver.id;
  releaserId = releaser.id;
  limitedId = limited.id;

  const agent = await db().aiAgent.create({
    data: {
      code: `orchestrator-mock-${runId}`,
      name: 'Orchestrator mock test agent',
      description: 'Synthetic DB test only',
      operationalScope: 'Synthetic workflow transition tests',
      systemPrompt: 'No external calls.',
      requiredDataChecklist: [],
      expectedOutput: 'Synthetic result',
      toneStyle: 'technical',
      active: true,
      provider: 'mock',
      promptVersion: 'test-v1',
      configVersion: 1,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    },
  });
  agentId = agent.id;
  await db().aiAgentConfigVersion.create({
    data: {
      agentId,
      version: 1,
      code: agent.code,
      name: agent.name,
      description: agent.description,
      operationalScope: agent.operationalScope,
      systemPrompt: agent.systemPrompt,
      requiredDataChecklist: [],
      expectedOutput: agent.expectedOutput,
      toneStyle: agent.toneStyle,
      active: true,
      provider: 'mock',
      model: null,
      promptVersion: agent.promptVersion,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      createdById: runnerId,
    },
  });
});

test.after(async () => {
  if (!runDbTests || !prisma) return;
  if (migrationDefaults) {
    await db().aiOrchestratorSetting.update({ where: { id: 'global' }, data: migrationDefaults });
  }
  await db().aiControlSetting.updateMany({ where: { id: 'global' }, data: { externalProvidersEnabled: false } });
  await db().$disconnect();
});

const human = (userId: string): AuditWorkflowActor => ({ kind: 'HUMAN', userId });
const agent = (): AuditWorkflowActor => ({ kind: 'AGENT', agentId, agentConfigVersion: 1 });
const system = (): AuditWorkflowActor => ({
  kind: 'SYSTEM',
  systemCode: 'AI_ORCHESTRATOR',
  executionMode: 'WORKER',
});

async function createCase(userId = runnerId, creationKey = randomUUID()) {
  const result = await createAuditWorkflowInstance(db(), {
    creationKey,
    expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    actor: { kind: 'HUMAN', userId },
  }, { env: safeEnv });
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result;
}

async function transitionInput(
  workflowInstanceId: string,
  transitionCode: string,
  actor: AuditWorkflowActor,
  overrides: Partial<ApplyAuditWorkflowTransitionInput> = {},
): Promise<ApplyAuditWorkflowTransitionInput> {
  const definition = getAuditWorkflowTransition(transitionCode);
  assert.ok(definition, `Transizione ${transitionCode} non trovata`);
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id: workflowInstanceId } });
  assert.equal(instance.currentState, definition.from, `${transitionCode} non applicabile da ${instance.currentState}`);
  return {
    workflowInstanceId,
    transitionCode,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
    expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    expectedState: definition.from,
    expectedStateVersion: instance.stateVersion,
    actor,
    gateResults: { [definition.gate]: 'PASS' },
    preconditions: Object.fromEntries(definition.preconditions.map((item) => [item, true])),
    manualReleaseConfirmed: definition.manualReleaseOnly ? true : undefined,
    reasonCode: definition.reasonCodeRequired ? 'SYNTHETIC_TEST_REASON' : undefined,
    ...overrides,
  };
}

async function applyCode(
  workflowInstanceId: string,
  transitionCode: string,
  actor: AuditWorkflowActor,
  overrides: Partial<ApplyAuditWorkflowTransitionInput> = {},
) {
  const input = await transitionInput(workflowInstanceId, transitionCode, actor, overrides);
  return applyAuditWorkflowTransition(db(), input, { env: safeEnv });
}

async function applyOk(workflowInstanceId: string, transitionCode: string, actor: AuditWorkflowActor) {
  const result = await applyCode(workflowInstanceId, transitionCode, actor);
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result;
}

async function advanceToDataValidation(workflowInstanceId: string) {
  await applyOk(workflowInstanceId, 'WF-001', human(runnerId));
  await applyOk(workflowInstanceId, 'WF-002', human(runnerId));
  await applyOk(workflowInstanceId, 'WF-003', human(runnerId));
  await applyOk(workflowInstanceId, 'WF-004', human(runnerId));
}

test('la migration crea il singleton fail-closed mock e synthetic-only', { skip: !runDbTests }, () => {
  assert.deepEqual(migrationDefaults, {
    dispatchEnabled: false,
    syntheticDataOnly: true,
    provider: 'mock',
  });
});

test('creazione concorrente usa una sola istanza e restituisce replay idempotente', { skip: !runDbTests }, async () => {
  const creationKey = randomUUID();
  const input = {
    creationKey,
    expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    actor: { kind: 'HUMAN' as const, userId: runnerId },
  };
  const [first, second] = await Promise.all([
    createAuditWorkflowInstance(db(), input, { env: safeEnv }),
    createAuditWorkflowInstance(db(), input, { env: safeEnv }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value.workflowInstanceId, second.value.workflowInstanceId);
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
  assert.equal(await db().aiWorkflowInstance.count({ where: { creationKey } }), 1);
  assert.equal(await db().auditLog.count({
    where: { entityId: first.value.workflowInstanceId, event: 'ai_workflow_created' },
  }), 1);
});

test('stesso comando/hash è replay; stessa chiave con hash diverso è conflitto senza duplicati', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const input = await transitionInput(created.value.workflowInstanceId, 'WF-001', human(runnerId));
  const first = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
  const replay = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
  const conflict = await applyAuditWorkflowTransition(db(), {
    ...input,
    reasonCode: 'DIFFERENT_SYNTHETIC_REASON',
  }, { env: safeEnv });

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(first.value.transitionId, replay.value.transitionId);
  }
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await db().aiWorkflowCommand.count({
    where: { workflowInstanceId: created.value.workflowInstanceId, idempotencyKey: input.idempotencyKey },
  }), 1);
  assert.equal(await db().aiWorkflowTransition.count({
    where: { workflowInstanceId: created.value.workflowInstanceId },
  }), 1);
  assert.equal(await db().auditLog.count({
    where: { entityId: created.value.workflowInstanceId, event: 'ai_workflow_state_changed' },
  }), 1);
});

test('diniego RBAC è persistito senza mutare stato o creare una transizione', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const result = await applyCode(created.value.workflowInstanceId, 'WF-001', human(limitedId));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'PERMISSION_DENIED');
    assert.ok(result.commandId);
    const command = await db().aiWorkflowCommand.findUniqueOrThrow({ where: { id: result.commandId } });
    assert.equal(command.status, 'REJECTED');
    assert.equal(command.rejectionCode, 'PERMISSION_DENIED');
  }
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id: created.value.workflowInstanceId } });
  assert.equal(instance.currentState, 'CREATED');
  assert.equal(instance.stateVersion, 1);
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: instance.id } }), 0);
});

test('vertical slice sintetica, correzioni, separazione umana e release manuale sono atomiche', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  await applyOk(id, 'WF-005', agent());
  await applyOk(id, 'WF-006', agent());
  await applyOk(id, 'WF-007', agent());
  await applyOk(id, 'WF-010', human(runnerId));
  await applyOk(id, 'WF-011', system());
  await applyOk(id, 'WF-012', agent());
  await applyOk(id, 'WF-013', agent());
  await applyOk(id, 'WF-014', system());
  await applyOk(id, 'WF-017', human(reviewerId));

  for (let expectedCycle = 1; expectedCycle <= 2; expectedCycle += 1) {
    await applyOk(id, 'WF-019', human(approverId));
    let instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
    assert.equal(instance.currentState, 'NEEDS_CORRECTION');
    assert.equal(instance.correctionCycle, expectedCycle);
    await applyOk(id, 'WF-016', agent());
    await applyOk(id, 'WF-014', system());
    await applyOk(id, 'WF-017', human(reviewerId));
    instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
    assert.equal(instance.currentState, 'HUMAN_APPROVAL');
  }

  const thirdCorrection = await applyCode(id, 'WF-019', human(approverId));
  assert.equal(thirdCorrection.ok, false);
  if (!thirdCorrection.ok) assert.equal(thirdCorrection.code, 'CORRECTION_LIMIT_REACHED');

  const reviewerCannotApprove = await applyCode(id, 'WF-018', human(reviewerId));
  assert.equal(reviewerCannotApprove.ok, false);
  if (!reviewerCannotApprove.ok) assert.equal(reviewerCannotApprove.code, 'APPROVER_SEPARATION_FAILED');
  await applyOk(id, 'WF-018', human(approverId));

  const approverCannotRelease = await applyCode(id, 'WF-020', human(approverId));
  assert.equal(approverCannotRelease.ok, false);
  if (!approverCannotRelease.ok) assert.equal(approverCannotRelease.code, 'RELEASE_DUAL_CONTROL_FAILED');
  await applyOk(id, 'WF-020', human(releaserId));

  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(instance.currentState, 'RELEASED');
  assert.equal(instance.correctionCycle, 2);
  const ledger = await db().aiWorkflowTransition.findMany({
    where: { workflowInstanceId: id },
    orderBy: { sequence: 'asc' },
  });
  assert.equal(ledger.length, 23);
  for (const [index, row] of ledger.entries()) {
    assert.equal(row.sequence, index + 1);
    assert.equal(row.fromVersion, index + 1);
    assert.equal(row.toVersion, index + 2);
    assert.equal(row.previousTransitionHash, index === 0 ? null : ledger[index - 1]?.transitionHash);
    assert.equal(row.definitionHash, FAI_AUDIT_WORKFLOW_DEFINITION_HASH);
  }
  assert.equal(await db().auditLog.count({ where: { entityId: id, event: 'ai_workflow_step_completed' } }), 7);
  assert.equal(await db().auditLog.count({ where: { entityId: id, event: 'ai_workflow_state_changed' } }), 16);

  const immutable = ledger[0];
  assert.ok(immutable);
  await assert.rejects(db().aiWorkflowTransition.update({
    where: { id: immutable.id },
    data: { reasonCode: 'TAMPER_ATTEMPT' },
  }));
  await assert.rejects(db().aiWorkflowTransition.delete({ where: { id: immutable.id } }));
});

test('due comandi concorrenti sulla stessa stateVersion producono un solo vincitore', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  const [firstInput, secondInput] = await Promise.all([
    transitionInput(id, 'WF-005', agent()),
    transitionInput(id, 'WF-006', agent()),
  ]);
  const settled = await Promise.allSettled([
    applyAuditWorkflowTransition(db(), firstInput, { env: safeEnv }),
    applyAuditWorkflowTransition(db(), secondInput, { env: safeEnv }),
  ]);
  assert.equal(settled.every((item) => item.status === 'fulfilled'), true);
  const results = settled.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => !item.ok && item.code === 'STATE_VERSION_MISMATCH').length, 1);
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(instance.currentState, 'DATA_VALIDATION');
  assert.equal(instance.stateVersion, 6);
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), 5);
});

test('vincoli e trigger DB chiudono NULL bypass, stato diretto e riscrittura idempotenza', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  const now = new Date();
  const baseCommand = {
    workflowInstanceId: id,
    transitionCode: 'WF-001',
    eventType: 'CASE_STARTED',
    requestHash: 'a'.repeat(64),
    definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    expectedState: 'CREATED',
    expectedStateVersion: 1,
    correlationId: randomUUID(),
    createdAt: now,
  };

  await assert.rejects(db().aiWorkflowInstance.create({
    data: {
      creationKey: randomUUID(),
      creationRequestHash: '1'.repeat(64),
      workflowCode: 'FAI-AUDIT-WORKFLOW',
      workflowVersion: '1.1',
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      dataMode: 'synthetic',
      currentState: 'APPROVED',
      stateVersion: 2,
      correctionCycle: 0,
      lastTransitionAt: now,
      createdById: runnerId,
    },
  }));
  await assert.rejects(db().aiWorkflowInstance.create({
    data: {
      creationKey: randomUUID(),
      creationRequestHash: '2'.repeat(64),
      workflowCode: 'FAI-AUDIT-WORKFLOW',
      workflowVersion: '1.1',
      definitionHash: '0'.repeat(64),
      dataMode: 'synthetic',
      currentState: 'CREATED',
      stateVersion: 1,
      correctionCycle: 0,
      createdById: runnerId,
    },
  }));
  const linkedClient = await db().client.create({
    data: { type: 'societa', displayName: `synthetic-link-rejected-${runId}` },
  });
  await assert.rejects(db().aiWorkflowInstance.create({
    data: {
      creationKey: randomUUID(),
      creationRequestHash: '3'.repeat(64),
      workflowCode: 'FAI-AUDIT-WORKFLOW',
      workflowVersion: '1.1',
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      dataMode: 'synthetic',
      clientId: linkedClient.id,
      currentState: 'CREATED',
      stateVersion: 1,
      correctionCycle: 0,
      createdById: runnerId,
    },
  }));
  await db().client.delete({ where: { id: linkedClient.id } });

  await assert.rejects(db().aiWorkflowCommand.create({
    data: {
      ...baseCommand,
      transitionCode: 'WF-005',
      eventType: 'DOCUMENT_INGESTED',
      expectedState: 'DATA_VALIDATION',
      idempotencyKey: randomUUID(),
      actorKind: 'AGENT',
      requestedByAgentId: agentId,
      requestedByAgentConfigVersion: null,
      status: 'PENDING',
    },
  }));
  await assert.rejects(db().aiWorkflowCommand.create({
    data: {
      ...baseCommand,
      idempotencyKey: randomUUID(),
      actorKind: 'HUMAN',
      requestedByUserId: runnerId,
      status: 'APPLIED',
      resultState: 'WAITING_FOR_PAYMENT',
      resultStateVersion: null,
      resolvedAt: now,
    },
  }));
  await assert.rejects(db().aiWorkflowCommand.create({
    data: {
      ...baseCommand,
      idempotencyKey: randomUUID(),
      actorKind: 'SYSTEM',
      requestedBySystemCode: 'AI_ORCHESTRATOR',
      status: 'PENDING',
    },
  }), /actor/i);

  await assert.rejects(db().aiWorkflowInstance.update({
    where: { id },
    data: {
      currentState: 'WAITING_FOR_PAYMENT',
      stateVersion: 2,
      lastTransitionAt: now,
    },
  }));
  await assert.rejects(db().aiWorkflowInstance.update({
    where: { id },
    data: { creationKey: randomUUID() },
  }));

  const pending = await db().aiWorkflowCommand.create({
    data: {
      ...baseCommand,
      idempotencyKey: randomUUID(),
      actorKind: 'HUMAN',
      requestedByUserId: runnerId,
      status: 'PENDING',
    },
  });
  await assert.rejects(db().aiWorkflowCommand.update({
    where: { id: pending.id },
    data: {
      status: 'APPLIED',
      resultState: 'WAITING_FOR_PAYMENT',
      resultStateVersion: 2,
      resolvedAt: now,
    },
  }));
  await assert.rejects(db().aiWorkflowCommand.update({
    where: { id: pending.id },
    data: { requestHash: 'b'.repeat(64) },
  }));
  await assert.rejects(db().aiWorkflowCommand.delete({ where: { id: pending.id } }));
  await assert.rejects(db().aiWorkflowInstance.delete({ where: { id } }));
});

test('trigger ledger rifiuta command cross-workflow e predecessore non immediato', { skip: !runDbTests }, async () => {
  const firstCase = await createCase();
  const secondCase = await createCase();
  const firstId = firstCase.value.workflowInstanceId;
  const secondId = secondCase.value.workflowInstanceId;
  const crossNow = new Date();
  await assert.rejects(db().$transaction(async (tx) => {
    const command = await tx.aiWorkflowCommand.create({
      data: {
        workflowInstanceId: firstId,
        transitionCode: 'WF-001',
        eventType: 'CASE_STARTED',
        idempotencyKey: randomUUID(),
        requestHash: '4'.repeat(64),
        definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
        expectedState: 'CREATED',
        expectedStateVersion: 1,
        actorKind: 'HUMAN',
        requestedByUserId: runnerId,
        correlationId: randomUUID(),
        status: 'PENDING',
        createdAt: crossNow,
      },
    });
    await tx.aiWorkflowInstance.update({
      where: { id: secondId },
      data: { currentState: 'WAITING_FOR_PAYMENT', stateVersion: 2, lastTransitionAt: crossNow },
    });
    await tx.aiWorkflowTransition.create({
      data: {
        workflowInstanceId: secondId,
        commandId: command.id,
        transitionCode: 'WF-001',
        eventType: 'CASE_STARTED',
        sequence: 1,
        fromState: 'CREATED',
        toState: 'WAITING_FOR_PAYMENT',
        fromVersion: 1,
        toVersion: 2,
        definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
        guardSnapshotHash: '5'.repeat(64),
        previousTransitionHash: null,
        transitionHash: '6'.repeat(64),
        actorKind: 'HUMAN',
        actorUserId: runnerId,
        correlationId: command.correlationId,
        createdAt: crossNow,
      },
    });
  }));
  assert.deepEqual(
    await db().aiWorkflowInstance.findUniqueOrThrow({
      where: { id: secondId },
      select: { currentState: true, stateVersion: true },
    }),
    { currentState: 'CREATED', stateVersion: 1 },
  );

  await applyOk(firstId, 'WF-001', human(runnerId));
  await applyOk(firstId, 'WF-002', human(runnerId));
  const chain = await db().aiWorkflowTransition.findMany({
    where: { workflowInstanceId: firstId },
    orderBy: { sequence: 'asc' },
  });
  assert.equal(chain.length, 2);
  const gapNow = new Date();
  await assert.rejects(db().$transaction(async (tx) => {
    const command = await tx.aiWorkflowCommand.create({
      data: {
        workflowInstanceId: firstId,
        transitionCode: 'WF-003',
        eventType: 'AUTHORITY_VERIFIED',
        idempotencyKey: randomUUID(),
        requestHash: '7'.repeat(64),
        definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
        expectedState: 'WAITING_FOR_AUTHORITY',
        expectedStateVersion: 3,
        actorKind: 'HUMAN',
        requestedByUserId: runnerId,
        correlationId: randomUUID(),
        status: 'PENDING',
        createdAt: gapNow,
      },
    });
    await tx.aiWorkflowInstance.update({
      where: { id: firstId },
      data: { currentState: 'NEEDS_DOCUMENTS', stateVersion: 4, lastTransitionAt: gapNow },
    });
    await tx.aiWorkflowTransition.create({
      data: {
        workflowInstanceId: firstId,
        commandId: command.id,
        transitionCode: 'WF-003',
        eventType: 'AUTHORITY_VERIFIED',
        sequence: 3,
        fromState: 'WAITING_FOR_AUTHORITY',
        toState: 'NEEDS_DOCUMENTS',
        fromVersion: 3,
        toVersion: 4,
        definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
        guardSnapshotHash: '8'.repeat(64),
        previousTransitionHash: chain[0]?.transitionHash ?? null,
        transitionHash: '9'.repeat(64),
        actorKind: 'HUMAN',
        actorUserId: runnerId,
        correlationId: command.correlationId,
        createdAt: gapNow,
      },
    });
  }));
  assert.deepEqual(
    await db().aiWorkflowInstance.findUniqueOrThrow({
      where: { id: firstId },
      select: { currentState: true, stateVersion: true },
    }),
    { currentState: 'WAITING_FOR_AUTHORITY', stateVersion: 3 },
  );
});
