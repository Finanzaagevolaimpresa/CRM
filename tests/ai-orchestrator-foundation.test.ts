import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  getAuditWorkflowTransition,
} from '../src/lib/ai-orchestrator/audit-workflow-v1-1';
import {
  createAuditWorkflowCommandRequestHash,
  createAuditWorkflowCreationRequestHash,
  WORKFLOW_SERVICE_REJECTION_CODES,
  type ApplyAuditWorkflowTransitionInput,
} from '../src/lib/ai-orchestrator/workflow-service';

const root = process.cwd();
const migrationPath = resolve(
  root,
  'prisma/migrations/20260717120000_ai_orchestrator_state_machine_foundation/migration.sql',
);

function wf001Input(): ApplyAuditWorkflowTransitionInput {
  const definition = getAuditWorkflowTransition('WF-001');
  assert.ok(definition);
  return {
    workflowInstanceId: 'synthetic-workflow-id',
    transitionCode: definition.transitionCode,
    idempotencyKey: '57e59d22-3d58-4a53-bb26-a542cff9994a',
    correlationId: '07d1d21f-c34b-4d0c-864e-e50ae77ba25f',
    expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    expectedState: definition.from,
    expectedStateVersion: 1,
    actor: { kind: 'HUMAN', userId: 'user-1' },
    gateResults: { [definition.gate]: 'PASS' },
    preconditions: Object.fromEntries(definition.preconditions.map((item) => [item, true])),
  };
}

test('gli hash di creazione e comando sono canonici e legano tutti gli input decisionali', () => {
  const creation = {
    creationKey: '90c5c92e-fd0e-46c7-bd1b-8f69f0035ec2',
    expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    actor: { kind: 'HUMAN' as const, userId: 'user-1' },
  };
  assert.equal(
    createAuditWorkflowCreationRequestHash(creation),
    createAuditWorkflowCreationRequestHash({ ...creation, clientId: null, projectId: null }),
  );
  assert.notEqual(
    createAuditWorkflowCreationRequestHash(creation),
    createAuditWorkflowCreationRequestHash({ ...creation, actor: { kind: 'HUMAN', userId: 'user-2' } }),
  );

  const input = wf001Input();
  const reversedPreconditions = Object.fromEntries(Object.entries(input.preconditions ?? {}).reverse());
  assert.equal(
    createAuditWorkflowCommandRequestHash(input),
    createAuditWorkflowCommandRequestHash({ ...input, preconditions: reversedPreconditions }),
  );
  assert.notEqual(
    createAuditWorkflowCommandRequestHash(input),
    createAuditWorkflowCommandRequestHash({ ...input, expectedStateVersion: 2 }),
  );
  assert.notEqual(
    createAuditWorkflowCommandRequestHash(input),
    createAuditWorkflowCommandRequestHash({ ...input, actor: { kind: 'HUMAN', userId: 'user-2' } }),
  );
});

test('la migration è additiva, fail-closed e vincola il medesimo definition hash del motore', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  assert.equal(sql.split(FAI_AUDIT_WORKFLOW_DEFINITION_HASH).length - 1, 3);
  assert.match(sql, /"dispatchEnabled" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /"syntheticDataOnly" BOOLEAN NOT NULL DEFAULT true/);
  assert.match(sql, /"provider" TEXT NOT NULL DEFAULT 'mock'/);
  assert.match(sql, /"dataMode" = 'synthetic'[\s\S]*"clientId" IS NULL[\s\S]*"clientServiceId" IS NULL/);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+(?:TABLE\s+)?"?(?:User|Client|AiRun)"?/i);
});

test('i vincoli PostgreSQL chiudono NULL bypass, cross-workflow e actor confusion', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  for (const required of [
    '"requestedByAgentConfigVersion" IS NOT NULL',
    '"requestedBySystemCode" IS NOT NULL',
    '"resultStateVersion" IS NOT NULL',
    '"rejectionCode" IS NOT NULL',
    '"actorAgentConfigVersion" IS NOT NULL',
    '"actorSystemCode" IS NOT NULL',
  ]) assert.match(sql, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.match(
    sql,
    /FOREIGN KEY \("commandId", "workflowInstanceId"\)[\s\S]*REFERENCES "AiWorkflowCommand"\("id", "workflowInstanceId"\)/,
  );
  assert.match(sql, /AiWorkflowCommand_actor_transition_check/);
  assert.match(sql, /AiWorkflowTransition_actor_transition_check/);
  assert.match(sql, /AiWorkflowTransition_reason_code_required_check/);

  const rejectionAllowlist = sql.match(
    /CONSTRAINT "AiWorkflowCommand_rejection_code_allowlist_check"[\s\S]*?"rejectionCode" IN \(([\s\S]*?)\)\s*\),\s*CONSTRAINT "AiWorkflowCommand_applied_transition_check"/,
  );
  assert.ok(rejectionAllowlist);
  const persistedCodes = [...rejectionAllowlist[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(persistedCodes)].sort(), [...WORKFLOW_SERVICE_REJECTION_CODES].sort());
});

test('istanza, command e ledger sono protetti da trigger di integrità e immutabilità', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  for (const trigger of [
    'AiWorkflowInstance_canonical_insert',
    'AiWorkflowInstance_immutable_identity',
    'AiWorkflowInstance_state_requires_ledger',
    'AiWorkflowInstance_immutable_delete',
    'AiWorkflowCommand_pending_insert',
    'AiWorkflowCommand_resolve_once',
    'AiWorkflowCommand_terminal_requires_ledger',
    'AiWorkflowCommand_immutable_delete',
    'AiWorkflowTransition_validate_insert',
    'AiWorkflowTransition_requires_applied_command',
    'AiWorkflowTransition_immutable_update',
    'AiWorkflowTransition_immutable_delete',
  ]) assert.match(sql, new RegExp(trigger));

  assert.match(sql, /predecessor\."sequence" <> NEW\."sequence" - 1/);
  assert.match(sql, /"previousTransitionHash" <> "transitionHash"/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
});

test('PR1 non introduce coda, worker, route o provider esterno', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  const service = readFileSync(resolve(root, 'src/lib/ai-orchestrator/workflow-service.ts'), 'utf8');
  const canonicalJson = readFileSync(resolve(root, 'src/lib/canonical-json.ts'), 'utf8');
  const permissionEvaluator = readFileSync(resolve(root, 'src/lib/permission-evaluator.ts'), 'utf8');
  assert.doesNotMatch(sql, /CREATE TABLE "AiWorkflow(?:Job|Attempt|Outbox|Queue)"/);
  assert.doesNotMatch(service, /\bfetch\s*\(/);
  assert.doesNotMatch(service, /openai/i);
  assert.doesNotMatch(service, /next\/headers|next\/server/);
  assert.match(service, /from '\.\.\/canonical-json'/);
  assert.match(service, /from '\.\.\/permission-evaluator'/);
  assert.doesNotMatch(service, /from '\.\.\/auth'/);
  assert.doesNotMatch(canonicalJson, /next\/|\.\/prisma/);
  assert.doesNotMatch(permissionEvaluator, /next\/|\.\/prisma/);
});

test('i test DB immutabili richiedono conferma esplicita e database dedicato', () => {
  const dbTest = readFileSync(resolve(root, 'tests/db/ai-orchestrator-foundation-db.test.ts'), 'utf8');
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(dbTest, /AI_ORCHESTRATOR_DB_TESTS_CONFIRMED/);
  assert.match(dbTest, /testNamePattern/);
  assert.match(ci, /fai_crm_test/);
  assert.match(ci, /RUN_DB_TESTS=1 AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1 npm run test:db/);
});
