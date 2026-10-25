import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { syntheticSession } from '../selective-sharing/fixtures';
import { leadProof } from '../selective-leads/fixtures';
import { technicalFixture, technicalTarget, assignmentInput, revokeTechnical } from '../technical-assignments/fixtures';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../../src/lib/technical-assignment-service';
import { readOwnTechnicalUploads, previewTechnicalUpload, confirmTechnicalUpload, readOwnTechnicalUpload } from '../../src/lib/technical-upload-service';
import { readTechnicalUploadReviewQueue, previewTechnicalUploadReview, confirmTechnicalUploadReview, readTechnicalUploadForAdmin } from '../../src/lib/technical-upload-review-service';
import { localPathFromStoragePath } from '../../src/lib/storage';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { previewTechnicalDocumentAcquisition, confirmTechnicalDocumentAcquisition } from '../../src/lib/technical-document-acquisition-service';
import { readPersonalAcquiredDocument } from '../../src/lib/technical-document-acquired-access';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert(process.env.R05_UPLOAD_RECOVERY_FIXTURE);
  const authorities = await db.$queryRawUnsafe<Array<{ userId: string }>>('SELECT "userId" FROM "TechnicalAssignmentAuthority" WHERE enabled');
  assert.equal(authorities.length, 1);
  const user = await db.user.findUniqueOrThrow({ where: { id: authorities[0].userId } });
  const admin = { user, ...await syntheticSession(db, user) };
  const f = await technicalFixture(db, admin, user.passwordHash, 'consulente'), target = technicalTarget(f);
  for (const doc of f.documents) {
    const file = localPathFromStoragePath(doc.doc.storagePath);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, doc.bytes, { flag: 'wx', mode: 0o600 });
  }
  const previous = process.env.PRIVILEGED_ACCESS_MODE; process.env.PRIVILEGED_ACCESS_MODE = 'enforced';
  try {
    const documentsBefore = await db.document.count(), versionsBefore = await db.documentVersion.count();
    const uploads = [];
    let acquisition: { commandId: string; documentId: string; versionId: string; title: string; bytes: string } | null = null;
    for (const person of [f.techA, f.techB]) {
      const original = await assignmentInput(db, admin, target, person);
      const input = { ...original, selection: { ...original.selection, actions: ['upload_document'], readableFields: ['title'],
        editableFields: [], documents: [], uploadProfile: { purpose: 'Elaborati per revisione privata',
          formats: ['.txt'], visibility: 'PRIVATE_PENDING_ADMIN_REVIEW', maxFileBytes: 1024, maxFilesPerRevision: 3, maxBytesPerRevision: 3072 } } };
      const ref = { ...target, recipientId: person.user.id };
      const shown = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
      await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, shown.token, true);
      const states = person === f.techA ? ['PENDING', 'APPROVE_PRIVATE', 'REJECT_PRIVATE'] as const : ['REVOKED'] as const;
      for (const status of states) {
        const title = 'RECOVERY_PRIVATE_UPLOAD_' + status, bytes = Buffer.from(title + '_EXACT_BYTES');
        const view = await readOwnTechnicalUploads(db, person.session, target);
        const preview = await previewTechnicalUpload(db, person.session, target, { commandId: randomUUID(),
          assignmentId: view.assignmentId, assignmentRevision: view.assignmentRevision, expectedContextSha256: view.contextSha256,
          action: 'deposit_private_document', title }, status + '.txt', bytes);
        await confirmTechnicalUpload(db, person.session, target, preview.command, preview.token, bytes, true);
        assert.deepEqual((await readOwnTechnicalUpload(db, person.session, target, preview.command.commandId)).bytes, bytes);
        let reviewId: string | null = null;
        if (status === 'APPROVE_PRIVATE' || status === 'REJECT_PRIVATE') {
          const queue = await readTechnicalUploadReviewQueue(db, admin.session, ref);
          const row = queue.deposits.find(item => item.commandId === preview.command.commandId); assert(row);
          const review = await previewTechnicalUploadReview(db, admin.session, ref, { commandId: randomUUID(),
            submissionCommandId: row.commandId, sourceSha256: row.sourceSha256, verdict: status, reason: 'Verifica sintetica prima del riavvio' });
          const receipt = await confirmTechnicalUploadReview(db, admin.session, leadProof(admin), ref, review.command, review.token, true);
          reviewId = receipt.commandId;
          if (status === 'APPROVE_PRIVATE') {
            const reviewed = (await readTechnicalUploadReviewQueue(db, admin.session, ref)).deposits.find(d => d.commandId === row.commandId)!;
            const command = { commandId: randomUUID(), submissionCommandId: row.commandId, sourceSha256: row.sourceSha256,
              reviewCommandId: reviewed.review!.commandId, reviewSha256: reviewed.review!.sha256,
              classification: 'TECHNICAL_DOCUMENT', title: 'RECOVERY_ACQUIRED_PRIVATE', expiresAt: null, visibility: 'ADMIN_PRIVATE' };
            const prepared = await previewTechnicalDocumentAcquisition(db, admin.session, ref, command);
            const acquired = await confirmTechnicalDocumentAcquisition(db, admin.session, leadProof(admin), ref, prepared.command, prepared.token, true);
            assert.deepEqual((await readPersonalAcquiredDocument(db, admin.session, acquired.documentId)).bytes, bytes);
            acquisition = { commandId: acquired.commandId, documentId: acquired.documentId, versionId: acquired.versionId, title: command.title, bytes: bytes.toString() };
          }
        }
        uploads.push({ commandId: preview.command.commandId, reviewId, status, title, bytes: bytes.toString(),
          sha256: createHash('sha256').update(bytes).digest('hex'), authorId: person.user.id });
      }
    }
    await revokeTechnical(db, admin, target, f.techB);
    const revoked = uploads.find(row => row.status === 'REVOKED')!;
    await assert.rejects(readOwnTechnicalUpload(db, f.techB.session, target, revoked.commandId));
    await assert.rejects(readTechnicalUploadForAdmin(db, admin.session, { ...target, recipientId: f.techB.user.id }, revoked.commandId));
    assert(acquisition); assert.equal(await db.document.count(), documentsBefore + 1); assert.equal(await db.documentVersion.count(), versionsBefore + 1);
    await writeFile(process.env.R05_UPLOAD_RECOVERY_FIXTURE, JSON.stringify({ synthetic: true, practiceId: f.practice.id,
      adminEmail: user.email, liveEmail: f.techA.user.email, revokedEmail: f.techB.user.email,
      liveId: f.techA.user.id, revokedId: f.techB.user.id, salesEmails: [f.salesA.user.email, f.salesB.user.email], uploads, acquisition, clientId: f.client.id }));
  } finally { if (previous === undefined) delete process.env.PRIVILEGED_ACCESS_MODE; else process.env.PRIVILEGED_ACCESS_MODE = previous; }
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
