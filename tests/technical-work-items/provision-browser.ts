import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { technicalFixture } from '../technical-assignments/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.TECHNICAL_ITEM_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.TECHNICAL_ITEM_BROWSER_PASSWORD!, evidence = process.env.TECHNICAL_ITEM_EVIDENCE!;
  assert(password?.length >= 24 && evidence);
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "TechnicalAssignmentAuthority"`, []);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash), rows = [];
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
  for (let index = 0; index < 6; index++) {
    const f = await technicalFixture(db, admin, hash, 'consulente');
    const task = await db.task.create({ data: { clientId: f.client.id, projectId: f.project.id, assignedToId: f.techA.user.id,
      title: 'Attività tecnica scelta', description: 'DESCRIZIONE_TASK_NON_SCELTA', priority: 'alta', dueAt: new Date(Date.now() + 86400000) } });
    const check = await db.documentChecklistItem.create({ data: { clientId: f.client.id, projectId: f.project.id,
      title: 'Checklist scelta', notes: 'Nota iniziale' } });
    await db.documentChecklistItem.create({ data: { clientId: f.client.id, projectId: f.project.id,
      title: 'Checklist finanziaria esclusa', documentId: f.documents[2].doc.id } });
    const catalogTaskIds: string[] = [];
    if (index === 3 || index === 4) {
      for (let i = 0; i < 65; i++) catalogTaskIds.push(`catalog-${f.client.id}-${String(i).padStart(2, '0')}`);
      await db.task.createMany({ data: catalogTaskIds.map((id, i) => ({ id, clientId: f.client.id, projectId: f.project.id,
        title: `Catalogo sintetico ${String(i).padStart(2, '0')}`, priority: 'media' })) });
      await db.task.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ id: `catalog-hidden-${f.client.id}-${i}`,
        clientId: f.client.id, projectId: f.otherProject.id, title: `Catalogo sintetico ESCLUSO ${i}` })) });
    }
    rows.push({ clientId: f.client.id, projectId: f.project.id, practiceId: f.practice.id,
      taskId: task.id, checklistId: check.id, catalogTaskIds, techA: { id: f.techA.user.id, email: f.techA.user.email },
      techB: { id: f.techB.user.id, email: f.techB.user.email }, salesA: { id: f.salesA.user.id, email: f.salesA.user.email },
      salesB: { id: f.salesB.user.id, email: f.salesB.user.email },
      excluded: [task.description, f.practice.internalNotes, f.project.scenarioA, f.contract.serviceName, f.payment.notes] });
    await db.$transaction(async tx => { for (const person of [f.techA, f.techB, f.salesA, f.salesB])
      await revokeAllInternalSessions(tx, person.user.id, 'INTERNAL_GLOBAL', admin.user.id); });
  }
  await db.$transaction(tx => revokeAllInternalSessions(tx, admin.user.id, 'INTERNAL_GLOBAL', admin.user.id));
  await assertRegistryActivationReady(db); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminEmail: admin.user.email, rows }));
  console.log('TECHNICAL_ITEMS_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
