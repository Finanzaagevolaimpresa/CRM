import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CONTRACT_SIGNATURE_DB_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  // Synthetic tests use live sessions; retire them before the existing boot guard.
  await db.internalSession.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date() } });
  const password = process.env.CONTRACT_SIGNATURE_BROWSER_PASSWORD!, evidence = process.env.CONTRACT_SIGNATURE_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.create({ data: { name: 'Signature Browser Admin', email: 'signature-admin@example.test', role: 'admin', active: true, passwordHash } });
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Synthetic signature client' } });
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: randomUUID(), serviceName: 'Synthetic service', taxableAmount: '100', vatAmount: '22', totalAmount: '122' } });
  const payment = await db.payment.create({ data: { contractId: contract.id, clientId: client.id, taxableAmount: '100', vatAmount: '22', totalAmount: '122', status: 'da_incassare' } });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, clientId: client.id, contractId: contract.id, paymentId: payment.id }));
}
main().finally(() => db.$disconnect()).catch(() => { console.error('SYNTHETIC_SIGNATURE_FIXTURE_FAILED'); process.exitCode = 1; });
