import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_ORCHESTRATOR_EPHEMERAL_DB_TEST_SENTINEL,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from './db/ai-orchestrator-db-test-guard';

const validConfiguration = Object.freeze({
  requested: true,
  destructiveConfirmed: true,
  databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/fai_crm_test?schema=public',
  sentinel: AI_ORCHESTRATOR_EPHEMERAL_DB_TEST_SENTINEL,
  appEnvironment: 'test',
  nodeEnvironment: 'test',
});

test('guard DB distruttivo accetta solo il target PostgreSQL effimero canonico', () => {
  assert.equal(assertAiOrchestratorEphemeralDbTestConfiguration(validConfiguration), true);
  assert.equal(assertAiOrchestratorEphemeralDbTestConfiguration({
    requested: false,
    destructiveConfirmed: false,
  }), false);
});

test('guard DB distruttivo rifiuta production, host remoti, schema-only e sentinel assente', () => {
  for (const [override, expectedCode] of [
    [
      { appEnvironment: 'production' },
      'AI_ORCHESTRATOR_DB_TEST_PRODUCTION_ENVIRONMENT_DENIED',
    ],
    [
      { nodeEnvironment: 'production' },
      'AI_ORCHESTRATOR_DB_TEST_PRODUCTION_ENVIRONMENT_DENIED',
    ],
    [
      { appEnvironment: 'Production' },
      'AI_ORCHESTRATOR_DB_TEST_PRODUCTION_ENVIRONMENT_DENIED',
    ],
    [
      { nodeEnvironment: ' production ' },
      'AI_ORCHESTRATOR_DB_TEST_PRODUCTION_ENVIRONMENT_DENIED',
    ],
    [
      {
        databaseUrl:
          'postgresql://postgres:postgres@desk.finanzaagevolaimpresa.it:5432/fai_crm_test?schema=public',
      },
      'AI_ORCHESTRATOR_DB_TEST_DATABASE_TARGET_INVALID',
    ],
    [
      { databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/fai_crm?schema=tenant_test' },
      'AI_ORCHESTRATOR_DB_TEST_DATABASE_TARGET_INVALID',
    ],
    [
      { databaseUrl: 'mysql://root:root@127.0.0.1:3306/fai_crm_test?schema=public' },
      'AI_ORCHESTRATOR_DB_TEST_DATABASE_TARGET_INVALID',
    ],
    [
      { sentinel: undefined },
      'AI_ORCHESTRATOR_DB_TEST_SENTINEL_INVALID',
    ],
    [
      { destructiveConfirmed: false },
      'AI_ORCHESTRATOR_DB_TEST_CONFIRMATION_REQUIRED',
    ],
  ] as const) {
    assert.throws(
      () => assertAiOrchestratorEphemeralDbTestConfiguration({
        ...validConfiguration,
        ...override,
      }),
      new RegExp(expectedCode),
    );
  }
});
