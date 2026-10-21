import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from './fixtures';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

/** Keep the original schema58 enrollment qualification on its exact schema.
 * Schema60 upgrade fixtures and immutable history remain in the primary DB.
 * Both databases belong only to the isolated CI service, disposed by the job. */
export async function withHistoricalEnrollment(main: PrismaClient, kind: 'lead' | 'client' | 'practice',
  work: (fixture: { db: PrismaClient; admin: Awaited<ReturnType<typeof syntheticPerson>>; url: string }) => Promise<void>) {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.APP_ENV, 'test'); assert.notEqual(process.env.NODE_ENV, 'production');
  const mainIdentity = await assertAiOrchestratorEphemeralDatabaseIdentity(main);
  const original = new URL(process.env.DATABASE_URL!);
  assert.equal(original.hostname, '127.0.0.1'); assert.equal(original.port, '5432');
  assert.equal(original.pathname, '/fai_crm_test');
  assert.equal(original.searchParams.get('schema') ?? 'public', 'public'); original.searchParams.delete('schema');
  const name = 'fai_enrollment_' + kind + '_' + randomUUID().replaceAll('-', '');
  assert.match(name, /^fai_enrollment_(lead|client|practice)_[a-f0-9]{32}$/);
  const target = new URL(original); target.pathname = '/' + name;
  execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', original.toString()], {
    input: `CREATE DATABASE "${name}" TEMPLATE template0;\nCOMMENT ON DATABASE "${name}" IS 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1';`,
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000,
  });
  const directory = mkdtempSync(path.join(process.env.RUNNER_TEMP!, 'historical-enrollment-'));
  const baseline = JSON.parse(readFileSync('scripts/selective-client-documents/schema-binding.json', 'utf8')).baseline;
  assert.equal(baseline, '21fe9a7e34997e4e4ce5a70dea4c711670994850');
  const archive = execFileSync('git', ['archive', baseline, 'prisma'], { maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', directory], { input: archive });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', path.join(directory, 'prisma/schema.prisma')], {
    env: { ...process.env, DATABASE_URL: target.toString() }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  const db = new PrismaClient({ datasourceUrl: target.toString() });
  try {
    const rows = await db.$queryRaw<Array<{ name: string; schema: string; address: string; sentinel: string; migrations: bigint }>>`
      SELECT current_database() AS name, current_schema() AS schema, inet_server_addr()::text AS address,
        shobj_description(oid,'pg_database') AS sentinel,
        (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrations
      FROM pg_database WHERE datname=current_database()`;
    assert.deepEqual(rows, [{ name, schema: 'public', address: mainIdentity.serverAddress,
      sentinel: 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1', migrations: 58n }]);
    // This distinct database has just been created and identified above. Keep
    // the primary database's fixed-name guard unchanged and seed only here.
    const admin = await syntheticPerson(db, 'Autorità sintetica schema58');
    await db.selectiveAccessAuthority.create({ data: { userId: admin.user.id, enabled: true } });
    await db.applicationKeyVersion.create({ data: { purpose: 'PRIVILEGED_STEP_UP',
      version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION),
      keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!),
      status: 'ACTIVE', activatedAt: new Date() } });
    await work({ db, admin, url: target.toString() });
  } finally { await db.$disconnect(); }
}
