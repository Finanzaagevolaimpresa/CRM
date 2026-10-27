import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { technicalFixture, technicalTarget, assignTechnical, revokeTechnical, workInput } from '../technical-assignments/fixtures';
import { previewTechnicalWork, confirmTechnicalWork } from '../../src/lib/technical-work-service';
import { readTechnicalWork } from '../../src/lib/technical-assignment-access';
import { readTechnicalAssignmentManagement } from '../../src/lib/technical-assignment-management';
import { readTechnicalWorkItem, previewTechnicalWorkItem, confirmTechnicalWorkItem } from '../../src/lib/technical-work-item-service';
import { technicalWorkItemGrant } from '../../src/lib/technical-work-item-grant';
import { localPathFromStoragePath } from '../../src/lib/storage';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { leadProof } from '../selective-leads/fixtures';
import { loadTechnicalPrivateItemCreationContext, previewPrivateTechnicalItem, confirmPrivateTechnicalItem } from '../../src/lib/technical-private-item-service';
import type { TechnicalPrivateItemCommand } from '../../src/lib/technical-private-item-contract';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD!;
  assert(password.length >= 24 && process.env.R05_TECHNICAL_RECOVERY_FIXTURE);
  const admin = await syntheticPerson(db, 'Synthetic technical recovery authority', 'admin', await bcrypt.hash(password, 10));
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "TechnicalAssignmentAuthority"`, []);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
  const f = await technicalFixture(db, admin, await bcrypt.hash(password, 10));
  for (const doc of f.documents) {
    const file = localPathFromStoragePath(doc.doc.storagePath);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, doc.bytes, { flag: 'wx', mode: 0o600 });
  }
  const previous = process.env.PRIVILEGED_ACCESS_MODE; process.env.PRIVILEGED_ACCESS_MODE = 'enforced';
  try {
    const target = technicalTarget(f), project = technicalTarget(f, 'Project');
    const creationContext = await loadTechnicalPrivateItemCreationContext(db, admin.session, target);
    const creationProof = leadProof(admin);
    const taskCommand: TechnicalPrivateItemCommand = { commandId: randomUUID(), itemId: randomUUID(), kind: 'Task', target,
      expectedContextSha256: creationContext.contextSha256, values: { title: 'Recovery selected technical task',
        description: 'RECOVERY_ITEM_UNSELECTED_DESCRIPTION', priority: 'alta', dueAt: null } };
    const creationPreview = await previewPrivateTechnicalItem(db, admin.session, creationProof, taskCommand);
    await confirmPrivateTechnicalItem(db, admin.session, creationProof, taskCommand, creationPreview.token, true);
    const checkCommand: TechnicalPrivateItemCommand = { commandId: randomUUID(), itemId: randomUUID(), kind: 'ChecklistItem', target,
      expectedContextSha256: creationContext.contextSha256, values: { title: 'Recovery private unassigned checklist', notes: 'RECOVERY_PRIVATE_CHECKLIST_NOTE' } };
    const checkPreview = await previewPrivateTechnicalItem(db, admin.session, creationProof, checkCommand);
    await confirmPrivateTechnicalItem(db, admin.session, creationProof, checkCommand, checkPreview.token, true);
    const task = await db.task.findUniqueOrThrow({ where: { id: taskCommand.itemId } });
    assert(task.technicalPrivate); assert.equal(task.assignedToId, null);
    const setup = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id);
    const option = setup.workItemOptions.find(item => item.itemId === task.id); assert(option);
    const choice = technicalWorkItemGrant.parse({ kind: option.kind, itemId: option.itemId, generation: option.generation,
      scopeGeneration: option.scopeGeneration, scopeSha256: option.scopeSha256, readableFields: ['title','priority'], editableFields: ['priority'] });
    const options = { documents: [{ fileId: f.documents[0].version.id, allowDownload: false },
      { fileId: f.documents[1].version.id, allowDownload: true }], workItems: [choice] };
    await assignTechnical(db, admin, target, f.techA, options);
    await assignTechnical(db, admin, target, f.techB, options);
    await assignTechnical(db, admin, project, f.techA, { documents: options.documents });
    const input = await workInput(db, f.techA, target, { clientVisibleStatus: 'RECOVERY_TECHNICAL_PROGRESS_SAVED' });
    const preview = await previewTechnicalWork(db, f.techA.session, target, input);
    const receipt = await confirmTechnicalWork(db, f.techA.session, target, input, preview.token, true);
    const view = await readTechnicalWorkItem(db, f.techA.session, target, { kind: 'Task', itemId: task.id });
    const { fields, editableFields, ...identity } = view; void fields; void editableFields;
    const itemPreview = await previewTechnicalWorkItem(db, f.techA.session, target, { ...identity,
      commandId: randomUUID(), action: 'update_fields', patch: { priority: 'urgente' } });
    const itemReceipt = await confirmTechnicalWorkItem(db, f.techA.session, target, itemPreview.command, itemPreview.token, true);
    await revokeTechnical(db, admin, target, f.techB);
    assert.equal((await readTechnicalWork(db, f.techA.session, target)).documents.length, 2);
    await assert.rejects(readTechnicalWork(db, f.techB.session, target));
    await writeFile(process.env.R05_TECHNICAL_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true,
      clientId: f.client.id, projectId: f.project.id, practiceId: f.practice.id, otherProjectId: f.otherProject.id,
      liveEmail: f.techA.user.email, revokedEmail: f.techB.user.email, salesEmail: f.salesA.user.email,
      receiptId: receipt.commandId, itemReceiptId: itemReceipt.commandId, taskId: task.id, privateChecklistId: checkCommand.itemId,
      title: f.practice.title, progress: 'RECOVERY_TECHNICAL_PROGRESS_SAVED',
      documents: f.documents.map(row => ({ fileId: row.version.id, bytes: row.bytes.toString() })),
      excluded: [task.description, f.practice.internalNotes, f.project.scenarioA, f.contract.serviceName, f.payment.notes] }) + '\n');
  } finally { if (previous === undefined) delete process.env.PRIVILEGED_ACCESS_MODE; else process.env.PRIVILEGED_ACCESS_MODE = previous; }
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
