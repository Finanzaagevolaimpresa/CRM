import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { technicalFixture, technicalTarget, assignTechnical, assignmentInput } from '../technical-assignments/fixtures';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../../src/lib/technical-assignment-service';
import { leadProof } from '../selective-leads/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { localPathFromStoragePath } from '../../src/lib/storage';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.OPERATIONAL_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.TECHNICAL_BROWSER_PASSWORD!, evidence = process.env.OPERATIONAL_EVIDENCE!;
  assert(password?.length >= 24 && evidence);
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "TechnicalAssignmentAuthority"`, []);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
  const f = await technicalFixture(db, admin, hash);
  await assignTechnical(db, admin, technicalTarget(f), f.techA, { documents: [{ fileId: f.documents[0].version.id, allowDownload: false }] });
  await assignTechnical(db, admin, technicalTarget(f, 'Project'), f.techA);
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente ordinario R04',
    consultantId: f.techA.user.id, salesOwnerId: f.salesA.user.id } });
  const project = await db.project.create({ data: { clientId: client.id, consultantId: f.techA.user.id, title: 'Progetto ordinario R04' } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id,
    title: 'Pratica ordinaria R04', practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
    technicalOwnerId: f.techA.user.id, commercialOwnerId: f.salesA.user.id, createdById: admin.user.id,
    dueDate: new Date('2026-11-26T17:00:00Z') } });
  const hidden = await db.technicalPractice.create({ data: { clientId: f.client.id, projectId: f.project.id,
    title: 'TITOLO_ESCLUSO_R04', practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
    status: 'in_istruttoria', technicalOwnerId: f.techA.user.id, createdById: admin.user.id } });
  const target = { kind: 'TechnicalPractice' as const, targetId: hidden.id };
  const input = await assignmentInput(db, admin, target, f.techA);
  assert(input.selection.kind === 'TechnicalPractice');
  input.selection = { ...input.selection, readableFields: ['priority'], editableFields: [], actions: ['request_admin'] };
  const ref = { ...target, recipientId: f.techA.user.id };
  const preview = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, preview.token, true);
  const bytes = Buffer.from('DOCUMENTO_ORDINARIO_R04'), doc = await db.document.create({ data: {
    clientId: client.id, projectId: project.id, title: 'Documento ordinario R04', fileName: 'ordinario.txt',
    storagePath: 'operational-r04/ordinary.txt', checksum: null, sizeBytes: bytes.length,
    type: 'text/plain', mimeType: 'text/plain', documentCategory: 'altro', uploadedById: admin.user.id,
  } });
  for (const item of [...f.documents.map(row => ({ doc: row.doc, bytes: row.bytes })), { doc, bytes }]) {
    const dest = localPathFromStoragePath(item.doc.storagePath);
    await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, item.bytes, { flag: 'wx', mode: 0o600 });
  }
  const person = (p: typeof f.techA) => ({ id: p.user.id, email: p.user.email });
  const fixture = { synthetic: true, admin: person(admin), techA: person(f.techA), techB: person(f.techB),
    salesA: person(f.salesA), salesB: person(f.salesB), ordinary: { clientId: client.id, projectId: project.id,
      practiceId: practice.id, documentId: doc.id }, selective: { clientId: f.client.id, projectId: f.project.id,
      practiceId: f.practice.id, hiddenId: hidden.id, fileId: f.documents[0].version.id,
      deniedDocumentId: f.documents[1].doc.id, financialDocumentId: f.documents[2].doc.id }, otherPracticeId: f.otherPractice.id };
  await db.$transaction(async tx => {
    for (const p of [admin, f.techA, f.techB, f.salesA, f.salesB])
      await revokeAllInternalSessions(tx, p.user.id, 'INTERNAL_GLOBAL', admin.user.id);
  });
  await assertRegistryActivationReady(db); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify(fixture));
  console.log('OPERATIONAL_WORK_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
