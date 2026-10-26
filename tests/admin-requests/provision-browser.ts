import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { syntheticUpdateMailbox } from '../record-updates/email-fixtures';
import { requestFixture } from './fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.ADMIN_REQUEST_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.ADMIN_REQUEST_BROWSER_PASSWORD!, evidence = process.env.ADMIN_REQUEST_EVIDENCE!;
  assert(password?.length >= 24 && evidence);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  const mailbox = await syntheticUpdateMailbox(db, admin.session), rows = [];
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
  for (let index = 0; index < 6; index++) {
    const f = await requestFixture(db, admin, hash);
    rows.push({ clientId: f.client.id, leadId: f.lead.id, projectId: f.project.id, practiceId: f.practice.id,
      otherClientId: f.otherClient.id, otherProjectId: f.otherProject.id,
      techA: { id: f.techA.user.id, email: f.techA.user.email }, techB: { id: f.techB.user.id, email: f.techB.user.email },
      salesA: { id: f.salesA.user.id, email: f.salesA.user.email }, salesB: { id: f.salesB.user.id, email: f.salesB.user.email },
      excluded: [f.practice.internalNotes!, f.project.scenarioA!, f.contract.serviceName, f.payment.notes!] });
    await db.$transaction(async tx => {
      for (const person of [f.techA, f.techB, f.salesA, f.salesB]) await revokeAllInternalSessions(tx, person.user.id, 'INTERNAL_GLOBAL', admin.user.id);
    });
  }
  await db.$transaction(tx => revokeAllInternalSessions(tx, admin.user.id, 'INTERNAL_GLOBAL', admin.user.id));
  await assertRegistryActivationReady(db); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true,
    adminId: admin.user.id, adminEmail: admin.user.email, mailboxId: mailbox.id, mailboxAddress: mailbox.address, rows }));
  console.log('ADMIN_REQUEST_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
