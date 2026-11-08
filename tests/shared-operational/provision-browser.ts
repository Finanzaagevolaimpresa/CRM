import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { sharedFixture, shareAssignment } from './fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.SHARED_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(await db.user.count(), 0, 'Fresh synthetic browser database required');
  const password = process.env.SHARED_BROWSER_PASSWORD!, evidence = process.env.SHARED_EVIDENCE!;
  assert(password?.length >= 24 && evidence);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
  const f = await sharedFixture(db, admin, hash);
  for (const person of [f.tech, f.second]) {
    await shareAssignment(db, admin, { kind: 'PRACTICE', id: f.practice.id }, person);
  }
  await shareAssignment(db, admin, { kind: 'PROJECT', id: f.project.id }, f.tech);
  // Native registry activation; subsequent browser login uses only the UI.
  for (const user of await db.user.findMany({ select: { id: true } }))
    await db.$transaction(tx => revokeAllInternalSessions(tx, user.id, 'INTERNAL_GLOBAL', admin.user.id));
  await assertRegistryActivationReady(db);
  const person = (p: typeof admin) => ({ id: p.user.id, email: p.user.email });
  const data = { synthetic: true, admin: person(admin), tech: person(f.tech), second: person(f.second),
    sales: person(f.sales), otherSales: person(f.otherSales), stranger: person(f.stranger),
    clientId: f.client.id, projectId: f.project.id, practiceId: f.practice.id, siblingId: f.sibling.id,
    leadId: f.lead.id, contractId: f.contract.id, paymentId: f.payment.id };
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify(data, null, 2));
  console.log('SHARED_OPERATIONAL_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
