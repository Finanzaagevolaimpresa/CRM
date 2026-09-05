import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  readSecureLeadGatewayKeyring,
} from '../../src/lib/secure-lead-gateway';
import {
  digestSecureLeadGatewayKey,
} from '../../src/lib/secure-lead-gateway-protocol';
import {
  calculateLeadIdentityKeyDigest,
  LEAD_NORMALIZATION_VERSION,
  readLeadIdentityKeyFile,
} from '../../src/lib/lead-identity';

const DATABASE_NAME = 'fai_vnx03_e2e';
const DATABASE_SENTINEL = 'FAI_CRM_VNX03_EPHEMERAL_TEST_ONLY_V1';
const GATEWAY_KEY_ID = 'vnx03-wordpress-key-v1';
const GATEWAY_PRODUCER = 'WORDPRESS_VNX03_SYNTHETIC';
const db = new PrismaClient();

async function main() {
  assert.equal(process.env.VNX03_SYNTHETIC_E2E_CONFIRMED, '1');
  assert.equal(process.env.APP_ENV, 'test');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.WEBSITE_LEAD_MODE, 'disabled');
  assert.equal(process.env.COMMERCIAL_LEAD_INBOX_MODE, 'disabled');
  assert.equal(process.env.FEATURE_AI_WORKER_ENABLED, 'false');
  assert.equal(process.env.FEATURE_AI_DISPATCH_ENABLED, 'false');
  assert.equal(process.env.FEATURE_AI_EGRESS_ENABLED, 'false');
  assert.equal(process.env.AI_ORCHESTRATOR_WORKER_ENABLED, '0');
  assert.equal(process.env.AI_EXTERNAL_PROVIDERS_ENABLED, 'false');

  const identity = await db.$queryRaw<Array<{
    database: string;
    address: string | null;
    port: number | null;
  }>>(Prisma.sql`
    SELECT current_database() AS database,
      inet_server_addr()::TEXT AS address,
      inet_server_port() AS port
  `);
  assert.equal(identity.length, 1);
  assert.equal(identity[0]?.database, DATABASE_NAME);
  assert.equal(identity[0]?.port, 5432);

  const migrations = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::BIGINT AS count
    FROM "_prisma_migrations"
    WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
  `);
  assert.equal(Number(migrations[0]?.count), 43);

  await db.$executeRawUnsafe(
    `COMMENT ON DATABASE "${DATABASE_NAME}" IS '${DATABASE_SENTINEL}'`,
  );

  const keyring = await readSecureLeadGatewayKeyring('/run/secrets/n12-keyring.json', {
    allowedRoot: '/run/secrets',
  });
  const gatewaySecret = keyring.get(GATEWAY_KEY_ID);
  assert.ok(gatewaySecret);
  const identityKey = await readLeadIdentityKeyFile('/run/secrets/n13-identity.json', {
    allowedRoot: '/run/secrets',
  });

  await db.applicationFeatureGate.update({
    where: { code: 'INTEGRATIONS' },
    data: { enabled: true, version: { increment: 1 } },
  });

  const gatewayKey = await db.secureLeadGatewayKeyVersion.create({
    data: {
      producerCode: GATEWAY_PRODUCER,
      keyId: GATEWAY_KEY_ID,
      version: 1,
      secretDigest: digestSecureLeadGatewayKey(gatewaySecret),
      status: 'STAGED',
      acceptFrom: new Date(Date.now() - 60_000),
    },
  });
  await db.$executeRaw(Prisma.sql`
    UPDATE "SecureLeadGatewayKeyVersion"
    SET "status" = 'ACTIVE'
    WHERE "id" = ${gatewayKey.id}::UUID
  `);

  await db.privacyNoticeVersion.createMany({
    data: [
      {
        noticeCode: 'SYNTHETIC_PRIVACY_NOTICE',
        noticeVersion: 'v1',
        purposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
        legalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
        evidenceKind: 'NOTICE_ACKNOWLEDGEMENT',
        contentHash: '1'.repeat(64),
      },
      {
        noticeCode: 'SYNTHETIC_MARKETING_NOTICE',
        noticeVersion: 'v1',
        purposeCode: 'DIRECT_MARKETING',
        legalBasisCode: 'CONSENT',
        evidenceKind: 'CONSENT',
        contentHash: '2'.repeat(64),
      },
    ],
  });
  await db.privacyNoticeVersion.updateMany({
    where: { status: 'DRAFT' },
    data: {
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    },
  });

  const identityVersion = await db.leadIdentityKeyVersion.create({
    data: {
      normalizationVersion: LEAD_NORMALIZATION_VERSION,
      version: identityKey.version,
      keyDigest: calculateLeadIdentityKeyDigest(identityKey.secret),
      status: 'STAGED',
    },
  });
  await db.leadIdentityKeyVersion.update({
    where: { id: identityVersion.id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });

  const gates = await db.applicationFeatureGate.findMany({
    orderBy: { code: 'asc' },
    select: { code: true, enabled: true },
  });
  assert.equal(gates.find(({ code }) => code === 'INTEGRATIONS')?.enabled, true);
  for (const code of ['AI_DISPATCH', 'AI_EGRESS', 'AI_WORKER']) {
    assert.equal(gates.find((gate) => gate.code === code)?.enabled, false);
  }
  assert.equal(await db.secureLeadGatewayKeyVersion.count({ where: { status: 'ACTIVE' } }), 1);
  assert.equal(await db.leadIdentityKeyVersion.count({ where: { status: 'ACTIVE' } }), 1);
  assert.equal(await db.privacyNoticeVersion.count({ where: { status: 'ACTIVE' } }), 2);
  assert.equal(await db.businessInboxEvent.count(), 0);
  assert.equal(await db.lead.count(), 0);

  gatewaySecret.fill(0);
  identityKey.secret.fill(0);
  process.stdout.write('{"provision":"ready","migrations":43,"synthetic":true}\n');
}

void main()
  .catch(() => {
    process.stderr.write('VNX03_PROVISION_FAILED\n');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
