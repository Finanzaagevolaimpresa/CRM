import { Prisma, type PrismaClient } from '@prisma/client';

export const AI_ORCHESTRATOR_EPHEMERAL_DB_TEST_SENTINEL =
  'FAI_CRM_EPHEMERAL_TEST_ONLY_V1' as const;
export const AI_ORCHESTRATOR_EPHEMERAL_DB_TEST_NAME = 'fai_crm_test' as const;
export const AI_ORCHESTRATOR_DISPATCH_CONSTRAINT_NAME =
  'AiOrchestratorSetting_dispatch_disabled_check' as const;
export const AI_ORCHESTRATOR_DISPATCH_CONSTRAINT_DEFINITION =
  'CHECK (("dispatchEnabled" = false))' as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface AiOrchestratorDbTestConfiguration {
  readonly requested: boolean;
  readonly destructiveConfirmed: boolean;
  readonly databaseUrl?: string;
  readonly sentinel?: string;
  readonly appEnvironment?: string;
  readonly nodeEnvironment?: string;
}

function isProductionEnvironment(value: string | undefined) {
  return value?.trim().toLowerCase() === 'production';
}

export function assertAiOrchestratorEphemeralDbTestConfiguration(
  input: AiOrchestratorDbTestConfiguration,
) {
  if (!input.requested) return false;
  if (!input.destructiveConfirmed) {
    throw new Error('AI_ORCHESTRATOR_DB_TEST_CONFIRMATION_REQUIRED');
  }
  if (
    isProductionEnvironment(input.appEnvironment)
    || isProductionEnvironment(input.nodeEnvironment)
  ) {
    throw new Error('AI_ORCHESTRATOR_DB_TEST_PRODUCTION_ENVIRONMENT_DENIED');
  }
  if (input.sentinel !== AI_ORCHESTRATOR_EPHEMERAL_DB_TEST_SENTINEL) {
    throw new Error('AI_ORCHESTRATOR_DB_TEST_SENTINEL_INVALID');
  }
  if (!input.databaseUrl) throw new Error('AI_ORCHESTRATOR_DB_TEST_DATABASE_URL_INVALID');

  let parsed: URL;
  try {
    parsed = new URL(input.databaseUrl);
  } catch {
    throw new Error('AI_ORCHESTRATOR_DB_TEST_DATABASE_URL_INVALID');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const schemaName = parsed.searchParams.get('schema') ?? 'public';
  if (
    (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:')
    || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    || databaseName !== AI_ORCHESTRATOR_EPHEMERAL_DB_TEST_NAME
    || schemaName !== 'public'
  ) throw new Error('AI_ORCHESTRATOR_DB_TEST_DATABASE_TARGET_INVALID');

  return true;
}

function currentConfiguration(): AiOrchestratorDbTestConfiguration {
  return {
    requested: process.env.RUN_DB_TESTS === '1',
    destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
    databaseUrl: process.env.DATABASE_URL,
    sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
    appEnvironment: process.env.APP_ENV,
    nodeEnvironment: process.env.NODE_ENV,
  };
}

export async function assertAiOrchestratorEphemeralDatabaseIdentity(
  client: PrismaClient,
) {
  if (!assertAiOrchestratorEphemeralDbTestConfiguration(currentConfiguration())) {
    throw new Error('AI_ORCHESTRATOR_DB_TEST_NOT_REQUESTED');
  }
  const rows = await client.$queryRaw<Array<{
    databaseName: string;
    schemaName: string | null;
    serverAddress: string | null;
    sentinel: string | null;
  }>>(Prisma.sql`
    SELECT
      CURRENT_DATABASE() AS "databaseName",
      CURRENT_SCHEMA() AS "schemaName",
      INET_SERVER_ADDR()::TEXT AS "serverAddress",
      SHOBJ_DESCRIPTION(database_row.oid, 'pg_database') AS "sentinel"
    FROM pg_database database_row
    WHERE database_row.datname = CURRENT_DATABASE()
  `);
  const identity = rows[0];
  if (
    !identity
    || identity.databaseName !== AI_ORCHESTRATOR_EPHEMERAL_DB_TEST_NAME
    || identity.schemaName !== 'public'
    || !identity.serverAddress
    || identity.sentinel !== AI_ORCHESTRATOR_EPHEMERAL_DB_TEST_SENTINEL
  ) throw new Error('AI_ORCHESTRATOR_DB_TEST_SERVER_IDENTITY_INVALID');
  return Object.freeze(identity);
}

export async function readAiOrchestratorDispatchConstraintState(
  client: PrismaClient,
) {
  const rows = await client.$queryRaw<Array<{
    present: boolean;
    validated: boolean;
    definition: string | null;
  }>>(Prisma.sql`
    SELECT
      true AS "present",
      constraint_row."convalidated" AS "validated",
      PG_GET_CONSTRAINTDEF(constraint_row.oid) AS "definition"
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row."conrelid"
    WHERE table_row."relname" = 'AiOrchestratorSetting'
      AND table_row."relnamespace" = TO_REGNAMESPACE(CURRENT_SCHEMA())
      AND constraint_row."conname" = ${AI_ORCHESTRATOR_DISPATCH_CONSTRAINT_NAME}
  `);
  return rows[0] ?? Object.freeze({
    present: false,
    validated: false,
    definition: null,
  });
}

export async function assertAiOrchestratorPhysicalDispatchBarrier(
  client: PrismaClient,
) {
  const [constraint, gateRows] = await Promise.all([
    readAiOrchestratorDispatchConstraintState(client),
    client.$queryRaw<Array<{
      dispatchEnabled: boolean;
      enabledCapabilityCount: number;
    }>>(Prisma.sql`
      SELECT
        orchestrator."dispatchEnabled",
        (
          SELECT COUNT(*)::INTEGER
          FROM "AiOrchestratorWorkerCapabilitySetting"
          WHERE "enabled" = true
        ) AS "enabledCapabilityCount"
      FROM "AiOrchestratorSetting" orchestrator
      WHERE orchestrator."id" = 'global'
    `),
  ]);
  const gate = gateRows[0];
  if (
    !constraint.present
    || !constraint.validated
    || constraint.definition !== AI_ORCHESTRATOR_DISPATCH_CONSTRAINT_DEFINITION
    || !gate
    || gate.dispatchEnabled !== false
    || gate.enabledCapabilityCount !== 0
  ) throw new Error('AI_ORCHESTRATOR_DB_TEST_PHYSICAL_DISPATCH_BARRIER_INVALID');
}
