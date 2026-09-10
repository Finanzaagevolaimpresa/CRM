import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const password = process.env.VNX03_COMMERCIAL_PASSWORD;

async function main() {
  assert.equal(process.env.VNX03_SYNTHETIC_E2E_CONFIRMED, '1');
  assert.equal(process.env.COMMERCIAL_LEAD_INBOX_MODE, 'enforced');
  assert.ok(password && password.length >= 24);
  const identity = await db.$queryRaw<Array<{ database: string; sentinel: string | null }>>(Prisma.sql`
    SELECT current_database() AS database, shobj_description(oid, 'pg_database') AS sentinel
    FROM pg_database WHERE datname = current_database()
  `);
  assert.deepEqual(identity, [{
    database: 'fai_vnx03_e2e', sentinel: 'FAI_CRM_VNX03_EPHEMERAL_TEST_ONLY_V1',
  }]);
  assert.equal(await db.commercialLeadInboxItem.count(), 0);
  assert.equal(await db.communicationIntentRecord.count(), 0);

  const passwordHash = await bcrypt.hash(password, 12);
  await db.user.createMany({ data: [
    { id: 'vnx03-n14-commercial-one', email: 'commercial.one@vnx03.invalid', name: 'Commerciale Sintetico Uno', passwordHash, role: 'commerciale', active: true },
    { id: 'vnx03-n14-commercial-two', email: 'commercial.two@vnx03.invalid', name: 'Commerciale Sintetico Due', passwordHash, role: 'commerciale', active: true },
    { id: 'vnx03-n14-commercial-inactive', email: 'commercial.inactive@vnx03.invalid', name: 'Commerciale Sintetico Inattivo', passwordHash, role: 'commerciale', active: false },
  ] });
  await db.commercialLeadSlaPolicyVersion.create({ data: {
    id: '00000000-0000-4000-8000-000000030014', version: 1, status: 'ACTIVE',
    responseTargetSeconds: 86_400,
  } });
  process.stdout.write('{"n14Provision":"ready","registryLogin":true,"synthetic":true}\n');
}

void main().catch(() => {
  process.stderr.write('VNX03_N14_PROVISION_FAILED\n');
  process.exitCode = 1;
}).finally(async () => db.$disconnect());
