import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { grantPractice, practiceProof, selectivePracticeFixture } from './fixtures';
import { revokePracticeSharing } from '../../src/lib/selective-practice-access';
import { savePrivateDocumentFile } from '../../src/lib/storage';
const db = new PrismaClient();
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.SELECTIVE_PRACTICE_BROWSER_CONFIRMED, '1');
  const password = process.env.SELECTIVE_PRACTICE_BROWSER_PASSWORD!, evidence = process.env.SELECTIVE_PRACTICE_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  assert.equal(await db.selectivePracticeAuthority.count(), 0);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  await db.selectivePracticeAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  const rows: { practiceId: string; label: string; readerId: string; readerEmail: string; privateNote: string | null;
    clientId: string; clientLabel: string; projectId: string; projectTitle: string; otherPracticeId: string; otherLabel: string; documents: { id: string; versionId: string; title: string; content: string; financial: boolean }[] }[] = [];
  for (let i = 0; i < 8; i++) {
    const f = await selectivePracticeFixture(db, admin, i === 4 ? 'amministrazione' : 'admin', hash);
    const documents = [];
    if (i >= 3) for (const kind of ['selected', 'unselected', 'financial']) {
      const content = `Synthetic document ${i} ${kind} only`, fileName = `${kind}.txt`;
      const file = new File([content], fileName, { type: 'text/plain' });
      const stored = await savePrivateDocumentFile({ file, fileName, clientId: f.client.id });
      const document = await db.document.create({ data: { ...stored, clientId: f.client.id, projectId: f.project.id, uploadedById: admin.user.id,
        title: kind === 'financial' ? 'Contratto sintetico riservato' : `Documento sintetico ${kind}`,
        type: kind === 'financial' ? 'contratto' : 'altro', documentCategory: kind === 'financial' ? 'contratto' : 'altro',
        fileName, mimeType: 'text/plain', status: 'verificato' } });
      const version = await db.documentVersion.create({ data: { documentId: document.id, version: 1,
        storagePath: stored.storagePath, checksum: stored.checksum } });
      documents.push({ id: document.id, versionId: version.id, title: document.title, content, financial: kind === 'financial' });
    }
    rows.push({ practiceId: f.practice.id, label: f.practice.title, readerId: f.reader.user.id,
      readerEmail: f.reader.user.email, privateNote: f.practice.internalNotes, clientId: f.client.id,
      clientLabel: f.client.displayName, projectId: f.project.id, projectTitle: f.project.title,
      otherPracticeId: f.other.id, otherLabel: f.other.title, documents });
  }
  const assignments: { owner: 'technical' | 'commercial'; state: 'active' | 'revoked' | 'expired'; readerId: string; readerEmail: string;
    expiresAt: string | null; restricted: { id: string; title: string; grantId: string }[]; siblings: { id: string; title: string }[] }[] = [];
  for (const owner of ['technical', 'commercial'] as const) {
    for (const state of ['active', 'revoked', 'expired'] as const) {
      const reader = await syntheticPerson(db, 'Referente assegnazioni sintetico', owner === 'technical' ? 'consulente' : 'commerciale', hash);
      const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente assegnazioni sintetico ' + randomUUID(),
        salesOwnerId: reader.user.id, consultantId: reader.user.id } });
      const project = await db.project.create({ data: { clientId: client.id, title: 'Progetto assegnazioni sintetico ' + randomUUID() } });
      const prefix = 'assignments-' + randomUUID(), paginated = owner === 'technical' && state === 'active';
      const restricted = [], siblings = [];
      const expiresAt = state === 'expired' ? new Date(Date.now() + 15_000).toISOString() : null;
      const data = { clientId: client.id, projectId: project.id, practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
        technicalOwnerId: owner === 'technical' ? reader.user.id : null,
        commercialOwnerId: owner === 'commercial' ? reader.user.id : null, createdById: admin.user.id };
      // Twenty-six restricted rows precede the allowed siblings: a filter after
      // take would incorrectly leave the first page empty or advance its cursor.
      for (let index = 0; index < (paginated ? 26 : 1); index++) {
        const practice = await db.technicalPractice.create({ data: { ...data, id: `${prefix}-0-${String(index).padStart(2, '0')}`,
          title: `TITOLO_NON_SELEZIONATO_${prefix}_${index}` } });
        const input = { practiceId: practice.id, recipientId: reader.user.id, revision: 0,
          commandId: randomUUID(), fields: ['status'], expiresAt };
        const { receipt } = await grantPractice(db, admin, input);
        if (state === 'revoked') await revokePracticeSharing(db, admin.session,
          { grantId: receipt.grantId, revision: receipt.revision, commandId: randomUUID() }, practiceProof(admin));
        restricted.push({ id: practice.id, title: practice.title, grantId: receipt.grantId });
      }
      for (let index = 0; index < (paginated ? 27 : 1); index++) {
        const practice = await db.technicalPractice.create({ data: { ...data, id: `${prefix}-1-${String(index).padStart(2, '0')}`,
          title: `Pratica sorella ammessa ${prefix} ${index}` } });
        siblings.push({ id: practice.id, title: practice.title });
      }
      assignments.push({ owner, state, readerId: reader.user.id, readerEmail: reader.user.email, expiresAt, restricted, siblings });
    }
  }
  await db.$transaction(async tx => {
    for (const id of [admin.user.id, ...rows.map(row => row.readerId), ...assignments.map(row => row.readerId)]) await revokeAllInternalSessions(tx, id, 'INTERNAL_GLOBAL', admin.user.id);
  });
  await assertRegistryActivationReady(db);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id, adminEmail: admin.user.email, rows, assignments }));
  console.log('SELECTIVE_PRACTICE_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
