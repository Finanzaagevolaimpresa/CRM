import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { technicalFixture } from './fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { localPathFromStoragePath } from '../../src/lib/storage';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.TECHNICAL_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.TECHNICAL_BROWSER_PASSWORD!, evidence = process.env.TECHNICAL_EVIDENCE!;
  assert(password?.length >= 24 && evidence);
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "TechnicalAssignmentAuthority"`, []);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash), rows = [];
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
  for (let index = 0; index < 5; index++) {
    const f = await technicalFixture(db, admin, hash, index >= 3 ? 'consulente' : 'backoffice');
    for (const doc of f.documents) {
      const dest = localPathFromStoragePath(doc.doc.storagePath);
      await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, doc.bytes, { flag: 'wx', mode: 0o600 });
    }
    rows.push({ clientId: f.client.id, projectId: f.project.id, practiceId: f.practice.id, otherProjectId: f.otherProject.id,
      techA: { id: f.techA.user.id, email: f.techA.user.email }, techB: { id: f.techB.user.id, email: f.techB.user.email },
      salesA: { id: f.salesA.user.id, email: f.salesA.user.email }, salesB: { id: f.salesB.user.id, email: f.salesB.user.email },
      documents: f.documents.map(row => ({ id: row.doc.id, fileId: row.version.id, title: row.doc.title, fileName: row.doc.fileName, text: row.bytes.toString() })),
      excluded: [f.practice.internalNotes!, f.project.scenarioA!, f.contract.serviceName, f.payment.notes!] });
    await db.$transaction(async tx => {
      for (const person of [f.techA, f.techB, f.salesA, f.salesB]) await revokeAllInternalSessions(tx, person.user.id, 'INTERNAL_GLOBAL', admin.user.id);
    });
  }
  await db.$transaction(tx => revokeAllInternalSessions(tx, admin.user.id, 'INTERNAL_GLOBAL', admin.user.id));
  await assertRegistryActivationReady(db); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id, adminEmail: admin.user.email, rows }));
  console.log('TECHNICAL_ASSIGNMENTS_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
