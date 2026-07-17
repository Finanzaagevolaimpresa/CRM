import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { canonicalSha256 } from '../../src/lib/canonical-json';
import {
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  getAuditWorkflowTransition,
} from '../../src/lib/ai-orchestrator/audit-workflow-v1-1';
import {
  FAI_AUDIT_JOB_CATALOG_HASH,
  FAI_AUDIT_JOB_CATALOG_KEY,
} from '../../src/lib/ai-orchestrator/job-catalog-v1';
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
let limitedId = '';
let roleRunnerId = '';
let overrideRunnerId = '';
let agentId = '';
let migrationDefaults: {
  stateMachineEnabled: boolean;
  dispatchEnabled: boolean;
  syntheticDataOnly: boolean;
  provider: string;
} | null = null;

function db() {
  if (!prisma) throw new Error('DB tests disabled');
  return prisma;
}

async function createUser(name: string, role: 'admin' | 'collaboratore_limitato' | 'consulente') {
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
    stateMachineEnabled: setting.stateMachineEnabled,
    dispatchEnabled: setting.dispatchEnabled,
    syntheticDataOnly: setting.syntheticDataOnly,
    provider: setting.provider,
  };
  await db().aiOrchestratorSetting.update({
    where: { id: 'global' },
    data: {
      stateMachineEnabled: true,
      dispatchEnabled: false,
      syntheticDataOnly: true,
      provider: 'mock',
    },
  });
  await db().aiControlSetting.upsert({
    where: { id: 'global' },
    create: { id: 'global', externalProvidersEnabled: false, maxExternalRunsPerUserPerHour: 10 },
    update: { externalProvidersEnabled: false },
  });

  const [runner, reviewer, limited, roleRunner, overrideRunner] = await Promise.all([
    createUser('orchestrator-runner', 'admin'),
    createUser('orchestrator-reviewer', 'admin'),
    createUser('orchestrator-limited', 'collaboratore_limitato'),
    createUser('orchestrator-role-runner', 'consulente'),
    createUser('orchestrator-override-runner', 'collaboratore_limitato'),
  ]);
  runnerId = runner.id;
  reviewerId = reviewer.id;
  limitedId = limited.id;
  roleRunnerId = roleRunner.id;
  overrideRunnerId = overrideRunner.id;
  await db().userPermissionOverride.create({
    data: { userId: overrideRunnerId, permission: 'ai.run', allowed: true },
  });

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

async function canonicalTransitionInput(
  workflowInstanceId: string,
  transitionCode: string,
  actor: AuditWorkflowActor,
  overrides: Partial<ApplyAuditWorkflowTransitionInput> = {},
): Promise<ApplyAuditWorkflowTransitionInput> {
  const definition = getAuditWorkflowTransition(transitionCode);
  assert.ok(definition, `Transizione ${transitionCode} non trovata`);
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id: workflowInstanceId } });
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
  return canonicalTransitionInput(workflowInstanceId, transitionCode, actor, overrides);
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

async function completeDataValidation(workflowInstanceId: string) {
  await applyOk(workflowInstanceId, 'WF-005', agent());
  await applyOk(workflowInstanceId, 'WF-006', agent());
  await applyOk(workflowInstanceId, 'WF-007', agent());
  await applyOk(workflowInstanceId, 'WF-010', human(runnerId));
}

async function advanceToIndependentReview(workflowInstanceId: string) {
  await advanceToDataValidation(workflowInstanceId);
  await completeDataValidation(workflowInstanceId);
  await applyOk(workflowInstanceId, 'WF-011', system());
  await applyOk(workflowInstanceId, 'WF-012', agent());
  await applyOk(workflowInstanceId, 'WF-013', agent());
}

function asJsonObject(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} deve essere un oggetto JSON`);
  return value as Record<string, unknown>;
}

function asJsonArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} deve essere un array JSON`);
  return value;
}

function collectJsonKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, item] of Object.entries(value)) {
    keys.push(key);
    collectJsonKeys(item, keys);
  }
  return keys;
}

type DirectActor =
  | { kind: 'HUMAN'; userId: string }
  | { kind: 'AGENT'; agentId: string; version: number }
  | { kind: 'SYSTEM'; systemCode: 'AI_ORCHESTRATOR' };

const directMilestonePolicy: Record<string, {
  phase: 'DATA_VALIDATION' | 'AI_DRAFT' | 'INDEPENDENT_REVIEW';
  canonical: string[];
  required: string[];
}> = {
  'WF-005': { phase: 'DATA_VALIDATION', canonical: ['WF-005', 'WF-006', 'WF-007'], required: [] },
  'WF-006': { phase: 'DATA_VALIDATION', canonical: ['WF-005', 'WF-006', 'WF-007'], required: ['WF-005'] },
  'WF-007': { phase: 'DATA_VALIDATION', canonical: ['WF-005', 'WF-006', 'WF-007'], required: ['WF-005', 'WF-006'] },
  'WF-010': { phase: 'DATA_VALIDATION', canonical: ['WF-005', 'WF-006', 'WF-007'], required: ['WF-005', 'WF-006', 'WF-007'] },
  'WF-012': { phase: 'AI_DRAFT', canonical: ['WF-012'], required: [] },
  'WF-013': { phase: 'AI_DRAFT', canonical: ['WF-012'], required: ['WF-012'] },
  'WF-014': { phase: 'INDEPENDENT_REVIEW', canonical: ['WF-014'], required: [] },
  'WF-015': { phase: 'INDEPENDENT_REVIEW', canonical: ['WF-014'], required: ['WF-014'] },
  'WF-017': { phase: 'INDEPENDENT_REVIEW', canonical: ['WF-014'], required: ['WF-014'] },
};

function directGuardSnapshot(
  transitionCode: string,
  actorKind: DirectActor['kind'],
  correctionCycle = 0,
  phaseEntrySequence = 1,
): Prisma.InputJsonObject {
  const definition = getAuditWorkflowTransition(transitionCode);
  assert.ok(definition, `Transizione snapshot ${transitionCode} non trovata`);
  const milestonePolicy = directMilestonePolicy[transitionCode];
  return {
    schemaVersion: 1,
    actor: { kind: actorKind, humanRole: actorKind === 'HUMAN' ? 'admin' : null },
    permission: {
      required: definition.requiredPermission,
      granted: true,
      source: definition.requiredPermission === null ? 'NOT_REQUIRED' : 'ADMIN',
    },
    correctionCycle,
    orchestratorSetting: {
      id: 'global',
      stateMachineEnabled: true,
      dispatchEnabled: false,
      provider: 'mock',
      syntheticDataOnly: true,
      version: 1,
      updatedAt: '2026-07-17T12:00:00.000Z',
    },
    providerPolicy: {
      databaseExternalProvidersEnabled: false,
      environmentExternalProvidersEnabled: false,
      effectiveExternalProvidersEnabled: false,
    },
    foundationPolicy: { transitionInScope: true, automaticDispatchAllowed: false },
    gate: { code: definition.gate, result: 'PASS', passed: true },
    preconditions: definition.preconditions.map((code) => ({ code, result: true, passed: true })),
    milestone: milestonePolicy
      ? {
          phase: milestonePolicy.phase,
          phaseEntrySequence,
          canonicalTransitionCodes: milestonePolicy.canonical,
          requiredTransitionCodes: milestonePolicy.required,
          completedTransitionCodes: milestonePolicy.required,
          decision: 'SATISFIED',
        }
      : {
          phase: null,
          phaseEntrySequence: null,
          canonicalTransitionCodes: [],
          requiredTransitionCodes: [],
          completedTransitionCodes: [],
          decision: 'NOT_REQUIRED',
        },
    separationChecks: [
      {
        code: 'HUMAN_REVIEW_BOUNDARY',
        applied: transitionCode === 'WF-017',
        result: transitionCode === 'WF-017' ? 'PASSED' : 'NOT_APPLICABLE',
      },
      {
        code: 'REVIEWER_APPROVER_SEPARATION',
        applied: false,
        result: 'NOT_APPLICABLE_FOUNDATION_SCOPE',
      },
      {
        code: 'APPROVER_RELEASE_SEPARATION',
        applied: false,
        result: 'NOT_APPLICABLE_FOUNDATION_SCOPE',
      },
    ],
  };
}

async function attemptDirectLedgerAppend(
  tx: Prisma.TransactionClient,
  workflowInstanceId: string,
  transitionCode: string,
  actor: DirectActor,
  snapshotOverride?: {
    guardSnapshot?: Prisma.InputJsonObject;
    guardSnapshotHash?: string;
  },
) {
  const definition = getAuditWorkflowTransition(transitionCode);
  assert.ok(definition, `Transizione diretta ${transitionCode} non trovata`);
  const instance = await tx.aiWorkflowInstance.findUniqueOrThrow({ where: { id: workflowInstanceId } });
  const previous = await tx.aiWorkflowTransition.findFirst({
    where: { workflowInstanceId },
    orderBy: { sequence: 'desc' },
  });
  const now = new Date();
  const correlationId = randomUUID();
  const command = await tx.aiWorkflowCommand.create({
    data: {
      workflowInstanceId,
      transitionCode: definition.transitionCode,
      eventType: definition.event,
      idempotencyKey: randomUUID(),
      requestHash: canonicalSha256({ fixture: 'direct-command', correlationId }),
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      expectedState: definition.from,
      expectedStateVersion: instance.stateVersion,
      actorKind: actor.kind,
      requestedByUserId: actor.kind === 'HUMAN' ? actor.userId : null,
      requestedByAgentId: actor.kind === 'AGENT' ? actor.agentId : null,
      requestedByAgentConfigVersion: actor.kind === 'AGENT' ? actor.version : null,
      requestedBySystemCode: actor.kind === 'SYSTEM' ? actor.systemCode : null,
      correlationId,
      status: 'PENDING',
      createdAt: now,
    },
  });
  const nextCorrectionCycle = definition.incrementsCorrectionCycle
    ? instance.correctionCycle + 1
    : instance.correctionCycle;
  let phaseEntrySequence = 1;
  if (directMilestonePolicy[transitionCode]) {
    const phaseEntryCodes = directMilestonePolicy[transitionCode]?.phase === 'DATA_VALIDATION'
      ? ['WF-004', 'WF-009']
      : directMilestonePolicy[transitionCode]?.phase === 'AI_DRAFT'
        ? ['WF-011']
        : ['WF-013', 'WF-016'];
    const phaseEntry = await tx.aiWorkflowTransition.findFirst({
      where: { workflowInstanceId, transitionCode: { in: phaseEntryCodes } },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    phaseEntrySequence = phaseEntry?.sequence ?? 1;
  }
  await tx.aiWorkflowInstance.update({
    where: { id: workflowInstanceId },
    data: {
      currentState: definition.to,
      stateVersion: instance.stateVersion + 1,
      correctionCycle: nextCorrectionCycle,
      lastTransitionAt: now,
    },
  });
  const guardSnapshot = snapshotOverride?.guardSnapshot ?? directGuardSnapshot(
    transitionCode,
    actor.kind,
    instance.correctionCycle,
    phaseEntrySequence,
  );
  const guardSnapshotHash = snapshotOverride?.guardSnapshotHash ?? canonicalSha256(guardSnapshot);
  await tx.aiWorkflowTransition.create({
    data: {
      workflowInstanceId,
      commandId: command.id,
      transitionCode: definition.transitionCode,
      eventType: definition.event,
      sequence: instance.stateVersion,
      fromState: definition.from,
      toState: definition.to,
      fromVersion: instance.stateVersion,
      toVersion: instance.stateVersion + 1,
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      guardSnapshot,
      guardSnapshotHash,
      previousTransitionHash: previous?.transitionHash ?? null,
      transitionHash: canonicalSha256({ fixture: 'direct-transition', correlationId }),
      actorKind: actor.kind,
      actorUserId: actor.kind === 'HUMAN' ? actor.userId : null,
      actorAgentId: actor.kind === 'AGENT' ? actor.agentId : null,
      actorAgentConfigVersion: actor.kind === 'AGENT' ? actor.version : null,
      actorSystemCode: actor.kind === 'SYSTEM' ? actor.systemCode : null,
      reasonCode: definition.reasonCodeRequired ? 'SYNTHETIC_DIRECT_TEST' : null,
      correlationId,
      metadata: { automaticDispatchAllowed: false, fixture: 'synthetic-db-negative-test' },
      createdAt: now,
    },
  });
  await tx.aiWorkflowCommand.update({
    where: { id: command.id },
    data: {
      status: 'APPLIED',
      resultState: definition.to,
      resultStateVersion: instance.stateVersion + 1,
      resolvedAt: now,
    },
  });
}

test('la migration crea il singleton fail-closed con state machine e dispatch disabilitati', { skip: !runDbTests }, () => {
  assert.deepEqual(migrationDefaults, {
    stateMachineEnabled: false,
    dispatchEnabled: false,
    syntheticDataOnly: true,
    provider: 'mock',
  });
});

test('state machine e dispatch sono flag distinti e la foundation non autorizza mai dispatch', { skip: !runDbTests }, async () => {
  const enabledCreationKey = randomUUID();
  const enabledCase = await createCase(runnerId, enabledCreationKey);
  const enabledId = enabledCase.value.workflowInstanceId;
  const enabledInput = await transitionInput(enabledId, 'WF-001', human(runnerId));

  await db().aiOrchestratorSetting.update({
    where: { id: 'global' },
    data: { stateMachineEnabled: false, dispatchEnabled: false },
  });
  try {
    const deniedCreation = await createAuditWorkflowInstance(db(), {
      creationKey: randomUUID(),
      expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      actor: { kind: 'HUMAN', userId: runnerId },
    }, { env: safeEnv });
    assert.equal(deniedCreation.ok, false);
    if (!deniedCreation.ok) assert.equal(deniedCreation.code, 'ORCHESTRATOR_DISABLED');

    const deniedCreationReplay = await createAuditWorkflowInstance(db(), {
      creationKey: enabledCreationKey,
      expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      actor: { kind: 'HUMAN', userId: runnerId },
    }, { env: safeEnv });
    assert.equal(deniedCreationReplay.ok, false);
    if (!deniedCreationReplay.ok) assert.equal(deniedCreationReplay.code, 'ORCHESTRATOR_DISABLED');

    const deniedTransition = await applyAuditWorkflowTransition(db(), enabledInput, { env: safeEnv });
    assert.equal(deniedTransition.ok, false);
    if (!deniedTransition.ok) assert.equal(deniedTransition.code, 'ORCHESTRATOR_DISABLED');
    assert.deepEqual(
      await db().aiWorkflowInstance.findUniqueOrThrow({
        where: { id: enabledId },
        select: { currentState: true, stateVersion: true, correctionCycle: true },
      }),
      { currentState: 'CREATED', stateVersion: 1, correctionCycle: 0 },
    );
    assert.equal(await db().aiWorkflowCommand.count({ where: { workflowInstanceId: enabledId } }), 0);
    assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: enabledId } }), 0);
  } finally {
    await db().aiOrchestratorSetting.update({
      where: { id: 'global' },
      data: { stateMachineEnabled: true, dispatchEnabled: false },
    });
  }

  const allowed = await applyAuditWorkflowTransition(db(), enabledInput, { env: safeEnv });
  assert.equal(allowed.ok, true);
  if (!allowed.ok) return;
  const transition = await db().aiWorkflowTransition.findUniqueOrThrow({
    where: { id: allowed.value.transitionId },
  });
  const metadata = asJsonObject(transition.metadata, 'metadata');
  assert.equal(metadata.automaticDispatchAllowed, false);
  const currentSetting = await db().aiOrchestratorSetting.findUniqueOrThrow({ where: { id: 'global' } });
  assert.equal(currentSetting.stateMachineEnabled, true);
  assert.equal(currentSetting.dispatchEnabled, false);

  await db().aiOrchestratorSetting.update({
    where: { id: 'global' },
    data: { stateMachineEnabled: false, dispatchEnabled: false },
  });
  try {
    const deniedTransitionReplay = await applyAuditWorkflowTransition(db(), enabledInput, { env: safeEnv });
    assert.equal(deniedTransitionReplay.ok, false);
    if (!deniedTransitionReplay.ok) assert.equal(deniedTransitionReplay.code, 'ORCHESTRATOR_DISABLED');
    assert.equal(await db().aiWorkflowCommand.count({ where: { workflowInstanceId: enabledId } }), 1);
    assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: enabledId } }), 1);
  } finally {
    await db().aiOrchestratorSetting.update({
      where: { id: 'global' },
      data: { stateMachineEnabled: true, dispatchEnabled: false },
    });
  }
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

test('WF-004 pianifica job e outbox atomici; il replay non duplica la coda', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await applyOk(id, 'WF-001', human(runnerId));
  await applyOk(id, 'WF-002', human(runnerId));
  await applyOk(id, 'WF-003', human(runnerId));
  const input = await transitionInput(id, 'WF-004', human(runnerId));
  const aiRunCountBefore = await db().aiRun.count();
  const first = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
  const replay = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok) return;
  assert.equal(first.value.plannedJobCount, 1);
  assert.equal(replay.value.plannedJobCount, 1);
  assert.equal(replay.value.jobPlanHash, first.value.jobPlanHash);
  assert.equal(replay.value.transitionId, first.value.transitionId);

  const jobs = await db().aiWorkflowJob.findMany({ where: { sourceTransitionId: first.value.transitionId } });
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.ok(job);
  assert.equal(job.catalogCode, 'FAI-AUDIT-JOB-CATALOG');
  assert.equal(job.catalogVersion, '1.0');
  assert.equal(job.catalogHash, FAI_AUDIT_JOB_CATALOG_HASH);
  assert.equal(job.jobCode, 'DOCUMENT_INGESTION');
  assert.equal(job.completionTransitionCode, 'WF-005');
  assert.equal(job.status, 'PLANNED');
  assert.equal(job.provider, 'mock');
  assert.equal(job.dataMode, 'synthetic');
  assert.equal(job.automaticDispatchAllowed, false);
  assert.match(job.dedupeKey, /^[0-9a-f]{64}$/);
  assert.equal(canonicalSha256(job.payload), job.payloadHash);

  const outbox = await db().aiWorkflowJobOutboxEvent.findMany({ where: { jobId: job.id } });
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.eventType, 'AI_JOB_PLANNED');
  assert.equal(outbox[0]?.deliveryState, 'PENDING');
  assert.equal(canonicalSha256(outbox[0]?.payload), outbox[0]?.payloadHash);
  const transition = await db().aiWorkflowTransition.findUniqueOrThrow({ where: { id: first.value.transitionId } });
  const planning = asJsonObject(asJsonObject(transition.metadata, 'metadata').jobPlanning, 'jobPlanning');
  assert.equal(planning.catalogKey, FAI_AUDIT_JOB_CATALOG_KEY);
  assert.equal(planning.catalogHash, FAI_AUDIT_JOB_CATALOG_HASH);
  assert.equal(planning.planHash, first.value.jobPlanHash);
  assert.equal(planning.plannedJobCount, 1);
  assert.equal(planning.automaticDispatchAllowed, false);
  assert.equal(await db().aiRun.count(), aiRunCountBefore);
});

test('bundle analysis e review hanno cardinalità canonica e outbox uno-a-uno', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  await completeDataValidation(id);
  await applyOk(id, 'WF-011', system());
  await applyOk(id, 'WF-012', agent());
  await applyOk(id, 'WF-013', agent());

  const jobs = await db().aiWorkflowJob.findMany({
    where: { workflowInstanceId: id },
    orderBy: [{ sourceTransitionSequence: 'asc' }, { slotKey: 'asc' }],
  });
  const countFor = (code: string) => jobs.filter(({ sourceTransitionCode }) => sourceTransitionCode === code).length;
  assert.equal(countFor('WF-004'), 1);
  assert.equal(countFor('WF-005'), 1);
  assert.equal(countFor('WF-006'), 1);
  assert.equal(countFor('WF-007'), 0);
  assert.equal(countFor('WF-010'), 3);
  assert.equal(countFor('WF-011'), 1);
  assert.equal(countFor('WF-012'), 1);
  assert.equal(countFor('WF-013'), 4);
  assert.equal(new Set(jobs.filter(({ sourceTransitionCode }) => sourceTransitionCode === 'WF-010')
    .map(({ bundleKey }) => bundleKey)).size, 1);
  assert.equal(new Set(jobs.filter(({ sourceTransitionCode }) => sourceTransitionCode === 'WF-013')
    .map(({ bundleKey }) => bundleKey)).size, 1);
  assert.ok(jobs.every(({ status, provider, dataMode, automaticDispatchAllowed }) => (
    status === 'PLANNED'
    && provider === 'mock'
    && dataMode === 'synthetic'
    && automaticDispatchAllowed === false
  )));
  assert.equal(await db().aiWorkflowJobOutboxEvent.count({ where: { workflowInstanceId: id } }), jobs.length);
});

test('la coda consente soltanto PLANNED→BLOCKED e l’outbox resta append-only', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  const job = await db().aiWorkflowJob.findFirstOrThrow({ where: { workflowInstanceId: id } });
  const blockedAt = new Date();
  const blocked = await db().aiWorkflowJob.update({
    where: { id: job.id },
    data: { status: 'BLOCKED', blockedAt, blockedReasonCode: 'FOUNDATION_HOLD' },
  });
  assert.equal(blocked.status, 'BLOCKED');
  await assert.rejects(db().aiWorkflowJob.update({
    where: { id: job.id },
    data: { status: 'PLANNED', blockedAt: null, blockedReasonCode: null },
  }));
  await assert.rejects(db().aiWorkflowJob.update({
    where: { id: job.id },
    data: { status: 'RUNNING' },
  }));
  const event = await db().aiWorkflowJobOutboxEvent.findFirstOrThrow({ where: { jobId: job.id } });
  await assert.rejects(db().aiWorkflowJobOutboxEvent.update({
    where: { id: event.id },
    data: { deliveryState: 'DELIVERED' },
  }));
  await assert.rejects(db().aiWorkflowJobOutboxEvent.delete({ where: { id: event.id } }));
  await assert.rejects(db().aiWorkflowJob.delete({ where: { id: job.id } }));
});

test('una transizione schedulabile senza piano e outbox viene interamente rollbackata', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await applyOk(id, 'WF-001', human(runnerId));
  await applyOk(id, 'WF-002', human(runnerId));
  await applyOk(id, 'WF-003', human(runnerId));
  const before = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  const commandCount = await db().aiWorkflowCommand.count({ where: { workflowInstanceId: id } });
  const transitionCount = await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } });
  await assert.rejects(db().$transaction(async (tx) => {
    await attemptDirectLedgerAppend(
      tx,
      id,
      'WF-004',
      { kind: 'HUMAN', userId: runnerId },
    );
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  }));
  const after = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.deepEqual(
    { currentState: after.currentState, stateVersion: after.stateVersion, correctionCycle: after.correctionCycle },
    { currentState: before.currentState, stateVersion: before.stateVersion, correctionCycle: before.correctionCycle },
  );
  assert.equal(await db().aiWorkflowCommand.count({ where: { workflowInstanceId: id } }), commandCount);
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), transitionCount);
  assert.equal(await db().aiWorkflowJob.count({ where: { workflowInstanceId: id } }), 0);
  assert.equal(await db().aiWorkflowJobOutboxEvent.count({ where: { workflowInstanceId: id } }), 0);
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

test('milestone DATA_VALIDATION: missing, fuori ordine, replay esatto e duplicato con nuova key', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);

  const skipped = await applyCode(id, 'WF-010', human(runnerId));
  assert.equal(skipped.ok, false);
  if (!skipped.ok) assert.equal(skipped.code, 'MILESTONE_NOT_COMPLETED');

  const outOfOrder = await applyCode(id, 'WF-006', agent());
  assert.equal(outOfOrder.ok, false);
  if (!outOfOrder.ok) assert.equal(outOfOrder.code, 'MILESTONE_OUT_OF_ORDER');

  const firstInput = await transitionInput(id, 'WF-005', agent());
  const first = await applyAuditWorkflowTransition(db(), firstInput, { env: safeEnv });
  const exactReplay = await applyAuditWorkflowTransition(db(), firstInput, { env: safeEnv });
  assert.equal(first.ok, true);
  assert.equal(exactReplay.ok, true);
  if (first.ok && exactReplay.ok) {
    assert.equal(first.replayed, false);
    assert.equal(exactReplay.replayed, true);
    assert.equal(exactReplay.value.transitionId, first.value.transitionId);
  }

  const extractBeforeClassification = await applyCode(id, 'WF-007', agent());
  assert.equal(extractBeforeClassification.ok, false);
  if (!extractBeforeClassification.ok) {
    assert.equal(extractBeforeClassification.code, 'MILESTONE_OUT_OF_ORDER');
  }

  const duplicateWithNewKey = await applyCode(id, 'WF-005', agent());
  assert.equal(duplicateWithNewKey.ok, false);
  if (!duplicateWithNewKey.ok) assert.equal(duplicateWithNewKey.code, 'MILESTONE_DUPLICATE');

  await applyOk(id, 'WF-006', agent());
  await applyOk(id, 'WF-007', agent());
  await applyOk(id, 'WF-010', human(runnerId));
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(instance.currentState, 'READY_FOR_ANALYSIS');
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), 8);
});

test('le milestone DATA_VALIDATION della fase precedente non superano WF-008/WF-009', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  await applyOk(id, 'WF-005', agent());
  await applyOk(id, 'WF-006', agent());
  await applyOk(id, 'WF-007', agent());
  await applyOk(id, 'WF-008', system());
  await applyOk(id, 'WF-009', human(runnerId));

  const staleMilestones = await applyCode(id, 'WF-010', human(runnerId));
  assert.equal(staleMilestones.ok, false);
  if (!staleMilestones.ok) assert.equal(staleMilestones.code, 'MILESTONE_NOT_COMPLETED');

  await completeDataValidation(id);
  assert.equal(
    (await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } })).currentState,
    'READY_FOR_ANALYSIS',
  );
});

test('milestone AI_DRAFT e review sono uniche e limitate alla fase o al ciclo corrente', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  await completeDataValidation(id);
  await applyOk(id, 'WF-011', system());

  const reportWithoutFindings = await applyCode(id, 'WF-013', agent());
  assert.equal(reportWithoutFindings.ok, false);
  if (!reportWithoutFindings.ok) assert.equal(reportWithoutFindings.code, 'MILESTONE_NOT_COMPLETED');

  const findingsInput = await transitionInput(id, 'WF-012', agent());
  const findings = await applyAuditWorkflowTransition(db(), findingsInput, { env: safeEnv });
  const findingsReplay = await applyAuditWorkflowTransition(db(), findingsInput, { env: safeEnv });
  assert.equal(findings.ok, true);
  assert.equal(findingsReplay.ok, true);
  if (findingsReplay.ok) assert.equal(findingsReplay.replayed, true);
  const duplicateFindings = await applyCode(id, 'WF-012', agent());
  assert.equal(duplicateFindings.ok, false);
  if (!duplicateFindings.ok) assert.equal(duplicateFindings.code, 'MILESTONE_DUPLICATE');

  await applyOk(id, 'WF-013', agent());
  const correctionWithoutBundle = await applyCode(id, 'WF-015', system());
  assert.equal(correctionWithoutBundle.ok, false);
  if (!correctionWithoutBundle.ok) assert.equal(correctionWithoutBundle.code, 'MILESTONE_NOT_COMPLETED');
  const reviewWithoutBundle = await applyCode(id, 'WF-017', human(reviewerId));
  assert.equal(reviewWithoutBundle.ok, false);
  if (!reviewWithoutBundle.ok) assert.equal(reviewWithoutBundle.code, 'MILESTONE_NOT_COMPLETED');

  await applyOk(id, 'WF-014', system());
  const duplicateReview = await applyCode(id, 'WF-014', system());
  assert.equal(duplicateReview.ok, false);
  if (!duplicateReview.ok) assert.equal(duplicateReview.code, 'MILESTONE_DUPLICATE');
  await applyOk(id, 'WF-015', system());
  await applyOk(id, 'WF-016', agent());

  const staleReview = await applyCode(id, 'WF-017', human(reviewerId));
  assert.equal(staleReview.ok, false);
  if (!staleReview.ok) assert.equal(staleReview.code, 'MILESTONE_NOT_COMPLETED');
  await applyOk(id, 'WF-014', system());
  await applyOk(id, 'WF-017', human(reviewerId));
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(instance.currentState, 'HUMAN_APPROVAL');
  assert.equal(instance.correctionCycle, 1);
});

test('vertical slice sintetica termina a HUMAN_APPROVAL e rifiuta WF-018..WF-023', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToIndependentReview(id);
  await applyOk(id, 'WF-014', system());

  for (let expectedCycle = 1; expectedCycle <= 2; expectedCycle += 1) {
    await applyOk(id, 'WF-015', system());
    let instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
    assert.equal(instance.currentState, 'NEEDS_CORRECTION');
    assert.equal(instance.correctionCycle, expectedCycle);
    await applyOk(id, 'WF-016', agent());
    await applyOk(id, 'WF-014', system());
    instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
    assert.equal(instance.currentState, 'INDEPENDENT_REVIEW');
  }

  const thirdCorrection = await applyCode(id, 'WF-015', system());
  assert.equal(thirdCorrection.ok, false);
  if (!thirdCorrection.ok) assert.equal(thirdCorrection.code, 'CORRECTION_LIMIT_REACHED');
  await applyOk(id, 'WF-017', human(reviewerId));

  const beforeScopeDenials = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(beforeScopeDenials.currentState, 'HUMAN_APPROVAL');
  const ledgerCountAtBoundary = await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } });
  for (const transitionCode of ['WF-018', 'WF-019', 'WF-020', 'WF-021', 'WF-022', 'WF-023']) {
    const input = await canonicalTransitionInput(id, transitionCode, human(reviewerId));
    const denied = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
    assert.equal(denied.ok, false, transitionCode);
    if (!denied.ok) assert.equal(denied.code, 'FOUNDATION_SCOPE_LIMIT', transitionCode);
  }
  const malformedOutOfScope = await canonicalTransitionInput(id, 'WF-018', human(reviewerId), {
    gateResults: { UNEXPECTED_GATE: 'PASS' },
    preconditions: { UNEXPECTED_PRECONDITION: true },
  });
  const malformedOutOfScopeDenied = await applyAuditWorkflowTransition(
    db(),
    malformedOutOfScope,
    { env: safeEnv },
  );
  assert.equal(malformedOutOfScopeDenied.ok, false);
  if (!malformedOutOfScopeDenied.ok) {
    assert.equal(malformedOutOfScopeDenied.code, 'FOUNDATION_SCOPE_LIMIT');
  }

  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(instance.currentState, 'HUMAN_APPROVAL');
  assert.equal(instance.correctionCycle, 2);
  assert.equal(instance.stateVersion, beforeScopeDenials.stateVersion);
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), ledgerCountAtBoundary);
  const ledger = await db().aiWorkflowTransition.findMany({
    where: { workflowInstanceId: id },
    orderBy: { sequence: 'asc' },
  });
  assert.equal(ledger.length, 19);
  for (const [index, row] of ledger.entries()) {
    assert.equal(row.sequence, index + 1);
    assert.equal(row.fromVersion, index + 1);
    assert.equal(row.toVersion, index + 2);
    assert.equal(row.previousTransitionHash, index === 0 ? null : ledger[index - 1]?.transitionHash);
    assert.equal(row.definitionHash, FAI_AUDIT_WORKFLOW_DEFINITION_HASH);
    assert.equal(canonicalSha256(row.guardSnapshot), row.guardSnapshotHash);
    assert.equal(asJsonObject(row.metadata, `${row.transitionCode}.metadata`).automaticDispatchAllowed, false);
  }
  assert.equal(await db().auditLog.count({ where: { entityId: id, event: 'ai_workflow_step_completed' } }), 7);
  assert.equal(await db().auditLog.count({ where: { entityId: id, event: 'ai_workflow_state_changed' } }), 12);

  const immutable = ledger[0];
  assert.ok(immutable);
  await assert.rejects(db().aiWorkflowTransition.update({
    where: { id: immutable.id },
    data: { reasonCode: 'TAMPER_ATTEMPT' },
  }));
  await assert.rejects(db().aiWorkflowTransition.delete({ where: { id: immutable.id } }));
});

test('guard snapshot persistito è minimo, ricostruibile, hashato esattamente e immutabile', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const applied = await applyOk(created.value.workflowInstanceId, 'WF-001', human(runnerId));
  const row = await db().aiWorkflowTransition.findUniqueOrThrow({
    where: { id: applied.value.transitionId },
  });
  assert.equal(canonicalSha256(row.guardSnapshot), row.guardSnapshotHash);

  const snapshot = asJsonObject(row.guardSnapshot, 'guardSnapshot');
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.correctionCycle, 0);

  const actorSnapshot = asJsonObject(snapshot.actor, 'guardSnapshot.actor');
  assert.deepEqual(actorSnapshot, { kind: 'HUMAN', humanRole: 'admin' });
  const permission = asJsonObject(snapshot.permission, 'guardSnapshot.permission');
  assert.deepEqual(permission, { required: 'ai.run', granted: true, source: 'ADMIN' });

  const setting = asJsonObject(snapshot.orchestratorSetting, 'guardSnapshot.orchestratorSetting');
  assert.equal(setting.id, 'global');
  assert.equal(setting.stateMachineEnabled, true);
  assert.equal(setting.dispatchEnabled, false);
  assert.equal(setting.syntheticDataOnly, true);
  assert.equal(setting.provider, 'mock');
  assert.equal(typeof setting.version, 'number');
  assert.equal(typeof setting.updatedAt, 'string');

  const gate = asJsonObject(snapshot.gate, 'guardSnapshot.gate');
  assert.deepEqual(gate, { code: 'G0_ORDER', result: 'PASS', passed: true });
  const preconditions = asJsonArray(snapshot.preconditions, 'guardSnapshot.preconditions')
    .map((item, index) => asJsonObject(item, `guardSnapshot.preconditions[${index}]`));
  assert.deepEqual(preconditions, [
    { code: 'ORDER_ACTIVE', result: true, passed: true },
    { code: 'CONTRACT_COHERENT', result: true, passed: true },
  ]);

  const milestone = asJsonObject(snapshot.milestone, 'guardSnapshot.milestone');
  assert.equal(milestone.decision, 'NOT_REQUIRED');
  assert.deepEqual(milestone.completedTransitionCodes, []);
  const separationChecks = asJsonArray(snapshot.separationChecks, 'guardSnapshot.separationChecks')
    .map((item, index) => asJsonObject(item, `guardSnapshot.separationChecks[${index}]`));
  assert.deepEqual(separationChecks, [
    { code: 'HUMAN_REVIEW_BOUNDARY', applied: false, result: 'NOT_APPLICABLE' },
    {
      code: 'REVIEWER_APPROVER_SEPARATION',
      applied: false,
      result: 'NOT_APPLICABLE_FOUNDATION_SCOPE',
    },
    {
      code: 'APPROVER_RELEASE_SEPARATION',
      applied: false,
      result: 'NOT_APPLICABLE_FOUNDATION_SCOPE',
    },
  ]);
  const foundationPolicy = asJsonObject(snapshot.foundationPolicy, 'guardSnapshot.foundationPolicy');
  assert.deepEqual(foundationPolicy, { transitionInScope: true, automaticDispatchAllowed: false });

  const providerPolicy = asJsonObject(snapshot.providerPolicy, 'guardSnapshot.providerPolicy');
  assert.deepEqual(providerPolicy, {
    databaseExternalProvidersEnabled: false,
    environmentExternalProvidersEnabled: false,
    effectiveExternalProvidersEnabled: false,
  });
  const metadata = asJsonObject(row.metadata, 'transition.metadata');
  assert.equal(metadata.automaticDispatchAllowed, false);

  const forbiddenKey = /^(?:clientId|companyId|projectId|clientServiceId|document|documents|prompt|output|cookie|password|token|apiKey|credentials?|secrets?)$/i;
  for (const key of collectJsonKeys(snapshot)) assert.doesNotMatch(key, forbiddenKey);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(runnerId), false);
  assert.equal(serialized.includes(runId), false);
  assert.equal(serialized.includes(passwordHash), false);

  await assert.rejects(db().aiWorkflowTransition.update({
    where: { id: row.id },
    data: { guardSnapshot: { tampered: true } },
  }));
});

test('guard snapshot distingue la fonte effettiva ROLE e OVERRIDE', { skip: !runDbTests }, async () => {
  const fixtures = [
    { userId: roleRunnerId, expectedRole: 'consulente', expectedSource: 'ROLE' },
    { userId: overrideRunnerId, expectedRole: 'collaboratore_limitato', expectedSource: 'OVERRIDE' },
  ] as const;

  for (const fixture of fixtures) {
    const created = await createCase(fixture.userId);
    const applied = await applyOk(created.value.workflowInstanceId, 'WF-001', human(fixture.userId));
    const row = await db().aiWorkflowTransition.findUniqueOrThrow({ where: { id: applied.value.transitionId } });
    assert.equal(canonicalSha256(row.guardSnapshot), row.guardSnapshotHash);
    const snapshot = asJsonObject(row.guardSnapshot, `${fixture.expectedSource}.guardSnapshot`);
    const actorSnapshot = asJsonObject(snapshot.actor, `${fixture.expectedSource}.actor`);
    const permissionSnapshot = asJsonObject(snapshot.permission, `${fixture.expectedSource}.permission`);
    assert.equal(actorSnapshot.humanRole, fixture.expectedRole);
    assert.deepEqual(permissionSnapshot, {
      required: 'ai.run',
      granted: true,
      source: fixture.expectedSource,
    });
  }
});

test('due comandi concorrenti sulla stessa stateVersion producono un solo vincitore', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  const [firstInput, secondInput] = await Promise.all([
    transitionInput(id, 'WF-005', agent()),
    transitionInput(id, 'WF-005', agent()),
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

test('i vincoli DB impediscono il bypass diretto delle milestone e del limite Foundation', { skip: !runDbTests }, async () => {
  const milestoneCase = await createCase();
  const milestoneId = milestoneCase.value.workflowInstanceId;
  await advanceToDataValidation(milestoneId);
  await assert.rejects(
    db().$transaction((tx) => attemptDirectLedgerAppend(
      tx,
      milestoneId,
      'WF-006',
      { kind: 'AGENT', agentId, version: 1 },
    )),
    /MILESTONE_OUT_OF_ORDER/i,
  );
  assert.deepEqual(
    await db().aiWorkflowInstance.findUniqueOrThrow({
      where: { id: milestoneId },
      select: { currentState: true, stateVersion: true, correctionCycle: true },
    }),
    { currentState: 'DATA_VALIDATION', stateVersion: 5, correctionCycle: 0 },
  );
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: milestoneId } }), 4);

  const scopeCase = await createCase();
  const scopeId = scopeCase.value.workflowInstanceId;
  await advanceToIndependentReview(scopeId);
  await applyOk(scopeId, 'WF-014', system());
  await applyOk(scopeId, 'WF-017', human(reviewerId));
  const boundary = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id: scopeId } });
  assert.equal(boundary.currentState, 'HUMAN_APPROVAL');
  const boundaryLedgerCount = await db().aiWorkflowTransition.count({ where: { workflowInstanceId: scopeId } });
  await assert.rejects(
    db().$transaction((tx) => attemptDirectLedgerAppend(
      tx,
      scopeId,
      'WF-018',
      { kind: 'HUMAN', userId: runnerId },
    )),
    /foundation|scope|constraint/i,
  );
  assert.deepEqual(
    await db().aiWorkflowInstance.findUniqueOrThrow({
      where: { id: scopeId },
      select: { currentState: true, stateVersion: true, correctionCycle: true },
    }),
    {
      currentState: 'HUMAN_APPROVAL',
      stateVersion: boundary.stateVersion,
      correctionCycle: boundary.correctionCycle,
    },
  );
  assert.equal(
    await db().aiWorkflowTransition.count({ where: { workflowInstanceId: scopeId } }),
    boundaryLedgerCount,
  );
});

test('il DB rifiuta snapshot guard incompleti e hash non calcolati sul JSON persistito', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  const actor: DirectActor = { kind: 'HUMAN', userId: runnerId };

  const malformedSnapshot: Prisma.InputJsonObject = {
    schemaVersion: 1,
    fixture: 'synthetic-malformed-guard',
  };
  await assert.rejects(
    db().$transaction((tx) => attemptDirectLedgerAppend(tx, id, 'WF-001', actor, {
      guardSnapshot: malformedSnapshot,
      guardSnapshotHash: canonicalSha256(malformedSnapshot),
    })),
    /guard|snapshot|constraint/i,
  );

  const validSnapshot = directGuardSnapshot('WF-001', 'HUMAN');
  const numericAlias = await db().$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
    SELECT "validate_ai_workflow_guard_snapshot"(
      JSONB_SET(
        CAST(${JSON.stringify(validSnapshot)} AS JSONB),
        '{schemaVersion}',
        '1.0'::JSONB
      ),
      'WF-001',
      'HUMAN'
    ) AS "valid"
  `);
  assert.equal(numericAlias[0]?.valid, false, 'schemaVersion 1.0 non deve aliasare la versione intera 1');
  const unsafeInteger = await db().$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
    SELECT "validate_ai_workflow_guard_snapshot"(
      JSONB_SET(
        CAST(${JSON.stringify(validSnapshot)} AS JSONB),
        '{orchestratorSetting,version}',
        '9007199254740993'::JSONB
      ),
      'WF-001',
      'HUMAN'
    ) AS "valid"
  `);
  assert.equal(unsafeInteger[0]?.valid, false, 'interi oltre il range PostgreSQL non devono essere accettati');

  await assert.rejects(
    db().$transaction((tx) => attemptDirectLedgerAppend(tx, id, 'WF-001', actor, {
      guardSnapshot: validSnapshot,
      guardSnapshotHash: 'f'.repeat(64),
    })),
    /guard|snapshot|constraint/i,
  );

  assert.deepEqual(
    await db().aiWorkflowInstance.findUniqueOrThrow({
      where: { id },
      select: { currentState: true, stateVersion: true, correctionCycle: true },
    }),
    { currentState: 'CREATED', stateVersion: 1, correctionCycle: 0 },
  );
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), 0);
});

test('trigger ledger rifiuta command cross-workflow e predecessore non immediato', { skip: !runDbTests }, async () => {
  const firstCase = await createCase();
  const secondCase = await createCase();
  const firstId = firstCase.value.workflowInstanceId;
  const secondId = secondCase.value.workflowInstanceId;
  const crossNow = new Date();
  await assert.rejects(db().$transaction(async (tx) => {
    const guardSnapshot = directGuardSnapshot('WF-001', 'HUMAN');
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
        guardSnapshot,
        guardSnapshotHash: canonicalSha256(guardSnapshot),
        previousTransitionHash: null,
        transitionHash: '6'.repeat(64),
        actorKind: 'HUMAN',
        actorUserId: runnerId,
        correlationId: command.correlationId,
        metadata: { automaticDispatchAllowed: false, fixture: 'synthetic-db-negative-test' },
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
    const guardSnapshot = directGuardSnapshot('WF-003', 'HUMAN');
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
        guardSnapshot,
        guardSnapshotHash: canonicalSha256(guardSnapshot),
        previousTransitionHash: chain[0]?.transitionHash ?? null,
        transitionHash: '9'.repeat(64),
        actorKind: 'HUMAN',
        actorUserId: runnerId,
        correlationId: command.correlationId,
        metadata: { automaticDispatchAllowed: false, fixture: 'synthetic-db-negative-test' },
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
