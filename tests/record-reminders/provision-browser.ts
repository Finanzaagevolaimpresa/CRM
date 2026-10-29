import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from '../selective-sharing/fixtures';
import { leadProof } from '../selective-leads/fixtures';
import { technicalFixture, assignTechnical } from '../technical-assignments/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { loadTechnicalPrivateItemCreationContext, previewPrivateTechnicalItem, confirmPrivateTechnicalItem } from '../../src/lib/technical-private-item-service';
import type { TechnicalPrivateItemCommand } from '../../src/lib/technical-private-item-contract';
import { readTechnicalAssignmentManagement } from '../../src/lib/technical-assignment-management';
import type { TechnicalWorkItemGrant } from '../../src/lib/technical-work-item-grant';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.RECORD_REMINDER_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.RECORD_REMINDER_BROWSER_PASSWORD!, evidence = process.env.RECORD_REMINDER_EVIDENCE!;
  assert(password?.length >= 24 && evidence);
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "TechnicalAssignmentAuthority"`, []);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
  const f = await technicalFixture(db, admin, hash, 'consulente');
  const otherAdmin = await syntheticPerson(db, 'Altro Admin sintetico', 'admin', hash), rows = [];
  for (let index = 0; index < 6; index++) {
    const project = await db.project.create({ data: { clientId: f.client.id, title: 'Progetto promemoria sintetico ' + index } });
    const practice = await db.technicalPractice.create({ data: { clientId: f.client.id, projectId: project.id,
      title: 'Pratica promemoria sintetica ' + index, practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
      commercialOwnerId: f.salesA.user.id, technicalOwnerId: f.techA.user.id, createdById: admin.user.id } });
    const target = { kind: 'TechnicalPractice' as const, targetId: practice.id };
    const context = await loadTechnicalPrivateItemCreationContext(db, admin.session, target);
    const command: TechnicalPrivateItemCommand = { commandId: randomUUID(), itemId: randomUUID(), target,
      expectedContextSha256: context.contextSha256, kind: 'Task', values: { title: 'Scadenza riservata sintetica ' + index,
        description: 'DESCRIZIONE_PRIVATA_DA_NON_NOTIFICARE', priority: 'media', dueAt: new Date(Date.now() + 86_400_000).toISOString() } };
    const proof = leadProof(admin), preview = await previewPrivateTechnicalItem(db, admin.session, proof, command);
    await confirmPrivateTechnicalItem(db, admin.session, proof, command, preview.token, true);
    for (const person of [f.techA, f.techB]) {
      const setup = await readTechnicalAssignmentManagement(db, admin.session, target, person.user.id);
      const option = setup.workItemOptions.find(row => row.kind === 'Task' && row.itemId === command.itemId); assert(option);
      const item: TechnicalWorkItemGrant = { kind: 'Task', itemId: command.itemId, generation: option.generation,
        scopeGeneration: option.scopeGeneration, scopeSha256: option.scopeSha256, readableFields: ['dueAt'], editableFields: [] };
      await assignTechnical(db, admin, target, person, { workItems: [item] });
    }
    const excluded = await db.task.create({ data: { clientId: f.client.id, projectId: project.id,
      title: 'Pagamento contratto riservato sintetico ' + index, createdById: admin.user.id, dueAt: new Date(Date.now() + 86_400_000) } });
    rows.push({ projectId: project.id, practiceId: practice.id, taskId: command.itemId,
      title: command.values.title, excludedTaskId: excluded.id });
  }
  const clientTask = await db.task.create({ data: { clientId: f.client.id, assignedToId: f.salesA.user.id,
    title: 'Prossima azione commerciale sintetica', createdById: admin.user.id, dueAt: new Date(Date.now() + 86_400_000) } });
  const person = (p: typeof f.techA) => ({ id: p.user.id, email: p.user.email, name: p.user.name });
  for (const actor of [admin, otherAdmin, f.techA, f.techB, f.salesA, f.salesB])
    await db.$transaction(tx => revokeAllInternalSessions(tx, actor.user.id, 'INTERNAL_GLOBAL', admin.user.id));
  await assertRegistryActivationReady(db); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, admin: person(admin),
    otherAdmin: person(otherAdmin), techA: person(f.techA), techB: person(f.techB), salesA: person(f.salesA),
    salesB: person(f.salesB), clientId: f.client.id, otherClientId: f.otherClient.id, clientTaskId: clientTask.id, rows }));
  console.log('RECORD_REMINDER_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
