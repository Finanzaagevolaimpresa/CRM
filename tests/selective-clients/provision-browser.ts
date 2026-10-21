import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { selectiveClientFixture } from './fixtures';
import { savePrivateDocumentFile } from '../../src/lib/storage';
const db = new PrismaClient();
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.SELECTIVE_CLIENT_BROWSER_CONFIRMED, '1');
  const password = process.env.SELECTIVE_CLIENT_BROWSER_PASSWORD!, evidence = process.env.SELECTIVE_CLIENT_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  assert.equal(await db.selectiveClientAuthority.count(), 0);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  await db.selectiveClientAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  const rows: { clientId: string; label: string; readerId: string; readerEmail: string; privateNote: string | null;
    companyId: string; companyName: string; projectId: string; projectTitle: string; leadId: string;
    otherClientId: string; otherLabel: string;
    person?: { id: string; membershipId: string; name: string; email: string };
    documents: { id: string; versionId: string; title: string; content: string; financial: boolean }[] }[] = [];
  for (let i = 0; i < 14; i++) {
    const f = await selectiveClientFixture(db, admin, i === 4 ? 'amministrazione' : 'admin', hash);
    const documents = [];
    if (i >= 3) for (const kind of ['selected', 'unselected', 'financial']) {
      const content = `Synthetic document ${i} ${kind} only`, fileName = `${kind}.txt`;
      const file = new File([content], fileName, { type: 'text/plain' });
      const stored = await savePrivateDocumentFile({ file, fileName, clientId: f.client.id });
      const document = await db.document.create({ data: { ...stored, clientId: f.client.id, uploadedById: admin.user.id,
        title: kind === 'financial' ? 'Contratto sintetico riservato' : `Documento sintetico ${kind}`,
        type: kind === 'financial' ? 'contratto' : 'altro', documentCategory: kind === 'financial' ? 'contratto' : 'altro',
        fileName, mimeType: 'text/plain', status: 'verificato' } });
      const version = await db.documentVersion.create({ data: { documentId: document.id, version: 1,
        storagePath: stored.storagePath, checksum: stored.checksum } });
      documents.push({ id: document.id, versionId: version.id, title: document.title, content, financial: kind === 'financial' });
    }
    let person;
    if (i >= 11) {
      const record = await db.person.create({ data: { firstName: 'Nome riservato', lastName: 'Referente sintetico', email: `selected-${i}@example.invalid`, notes: 'PERSON_NOTE_MUST_NOT_LEAK' } });
      const link = await db.companyPerson.create({ data: { companyId: f.company.id, personId: record.id, role: 'Referente sintetico' } });
      person = { id: record.id, membershipId: link.id, name: `${record.firstName} ${record.lastName}`, email: record.email! };
    }
    rows.push({ clientId: f.client.id, label: f.client.displayName, readerId: f.reader.user.id,
      readerEmail: f.reader.user.email, privateNote: f.client.notes, companyId: f.company.id,
      companyName: f.company.name, projectId: f.project.id, projectTitle: f.project.title,
      leadId: f.lead.id, otherClientId: f.other.id, otherLabel: f.other.displayName, documents, person });
  }
  await db.$transaction(async tx => {
    for (const id of [admin.user.id, ...rows.map(row => row.readerId)]) await revokeAllInternalSessions(tx, id, 'INTERNAL_GLOBAL', admin.user.id);
  });
  await assertRegistryActivationReady(db);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id, adminEmail: admin.user.email, rows }));
  console.log('SELECTIVE_CLIENT_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
