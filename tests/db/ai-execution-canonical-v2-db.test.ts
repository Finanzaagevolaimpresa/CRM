import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { canonicalAiExecutionJsonV2 } from '../../src/lib/canonical-json';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from './ai-orchestrator-db-test-guard';

const runDbTests = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV,
});
const prisma = runDbTests ? new PrismaClient() : null;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function deterministicNumbers() {
  const bits = new BigUint64Array(1); const floats = new Float64Array(bits.buffer); const values: number[] = [];
  const fixed = [0n, 1n, 2n, 0x000fffffffffffffn, 0x0010000000000000n, 0x3eb0c6f7a0b5ed8dn,
    0x3eb0c6f7a0b5ed8cn, 0x3ff0000000000000n, 0x4340000000000000n, 0x7fefffffffffffffn,
    0x8000000000000000n, 0xffefffffffffffffn];
  let state = 0x9e3779b97f4a7c15n;
  for (let i=0;i<1200;i+=1) { state ^= state << 13n; state ^= state >> 7n; state ^= state << 17n; fixed.push(state & 0xffffffffffffffffn); }
  for (const bit of fixed) { bits[0]=bit; if (Number.isFinite(floats[0])) values.push(floats[0]); }
  return values;
}

test.before(async () => { if (prisma) await assertAiOrchestratorEphemeralDatabaseIdentity(prisma); });
test.after(async () => { await prisma?.$disconnect(); });

test('corpus differenziale ECMAScript/PostgreSQL coincide per canonical text e SHA-256', { skip: !runDbTests }, async () => {
  const numbers = deterministicNumbers();
  const values: unknown[] = [...numbers, 1e-7, 1e21, 1e-6, Number.MIN_VALUE, Number.MAX_VALUE,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 333333333.33333329, 0.10000000000000002,
    { z: 1e21, a: [1e-7, -0, true, null, { '😀': 'astrale', '\uE000': 'BMP', é: 'combining' }] }];
  for (const value of values) {
    const json = JSON.stringify(value);
    const rows = await prisma!.$queryRaw<Array<{ canonical: string; digest: string }>>(Prisma.sql`
      SELECT "canonicalize_ai_execution_jsonb_v2"(${json}::jsonb) canonical,
             encode(sha256(convert_to("canonicalize_ai_execution_jsonb_v2"(${json}::jsonb),'UTF8')),'hex') digest`);
    const expected = canonicalAiExecutionJsonV2(value);
    assert.equal(rows[0]?.canonical, expected, `canonical mismatch for ${json}`);
    assert.equal(rows[0]?.digest, sha(expected), `digest mismatch for ${json}`);
  }
});

test('PostgreSQL respinge numeri JSONB fuori dal dominio IEEE-754 accettato', { skip: !runDbTests }, async () => {
  await assert.rejects(prisma!.$queryRaw`SELECT "canonicalize_ai_execution_jsonb_v2"('1e1000'::jsonb)`, /IEEE-754|range/i);
  await assert.rejects(prisma!.$queryRaw`SELECT "canonicalize_ai_execution_jsonb_v2"('0.1000000000000000000001'::jsonb)`, /IEEE-754/i);
});
