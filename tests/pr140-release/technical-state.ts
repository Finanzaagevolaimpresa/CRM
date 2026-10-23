import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { technicalFixture, technicalTarget, assignTechnical, revokeTechnical, workInput } from '../technical-assignments/fixtures';
import { previewTechnicalWork, confirmTechnicalWork } from '../../src/lib/technical-work-service';
import { readTechnicalWork } from '../../src/lib/technical-assignment-access';
import { localPathFromStoragePath } from '../../src/lib/storage';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
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
    const options = { documents: [{ fileId: f.documents[0].version.id, allowDownload: false },
      { fileId: f.documents[1].version.id, allowDownload: true }] };
    await assignTechnical(db, admin, target, f.techA, options);
    await assignTechnical(db, admin, target, f.techB, options);
    await assignTechnical(db, admin, project, f.techA, options);
    const input = await workInput(db, f.techA, target, { clientVisibleStatus: 'RECOVERY_TECHNICAL_PROGRESS_SAVED' });
    const preview = await previewTechnicalWork(db, f.techA.session, target, input);
    const receipt = await confirmTechnicalWork(db, f.techA.session, target, input, preview.token, true);
    await revokeTechnical(db, admin, target, f.techB);
    assert.equal((await readTechnicalWork(db, f.techA.session, target)).documents.length, 2);
    await assert.rejects(readTechnicalWork(db, f.techB.session, target));
    await writeFile(process.env.R05_TECHNICAL_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true,
      clientId: f.client.id, projectId: f.project.id, practiceId: f.practice.id, otherProjectId: f.otherProject.id,
      liveEmail: f.techA.user.email, revokedEmail: f.techB.user.email, salesEmail: f.salesA.user.email,
      receiptId: receipt.commandId, title: f.practice.title, progress: 'RECOVERY_TECHNICAL_PROGRESS_SAVED',
      documents: f.documents.map(row => ({ fileId: row.version.id, bytes: row.bytes.toString() })),
      excluded: [f.practice.internalNotes, f.project.scenarioA, f.contract.serviceName, f.payment.notes] }) + '\n');
  } finally { if (previous === undefined) delete process.env.PRIVILEGED_ACCESS_MODE; else process.env.PRIVILEGED_ACCESS_MODE = previous; }
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
