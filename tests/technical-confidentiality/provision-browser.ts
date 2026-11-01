import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from '../selective-sharing/fixtures';
import { technicalFixture, technicalTarget, assignTechnical } from '../technical-assignments/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.TECHNICAL_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(await db.user.count(), 0, 'A fresh isolated fixture is required');
  const password = process.env.TECHNICAL_BROWSER_PASSWORD!, evidence = process.env.TECHNICAL_EVIDENCE!;
  assert(password?.length >= 24 && evidence);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
  const rows = [];
  for (let index = 0; index < 3; index++) {
    const f = await technicalFixture(db, admin, hash);
    const third = await syntheticPerson(db, 'Terzo tecnico sintetico', 'consulente', hash);
    const mixed = await syntheticPerson(db, 'Amministrazione con funzione tecnica sintetica', 'amministrazione', hash);
    const mixedProject = await db.project.create({ data: { clientId: f.client.id, consultantId: mixed.user.id,
      title: 'Progetto seconda funzione tecnica sintetico', description: 'NOTA_SECONDA_FUNZIONE_RISERVATA' } });
    for (const person of [f.techA, f.techB, mixed]) for (const permission of ['contract.read', 'payment.read', 'document.download'])
      await db.userPermissionOverride.create({ data: { userId: person.user.id, permission, allowed: true } });
    const clientDossier = await db.clientDossier.create({ data: { clientId: f.client.id, projectId: f.project.id,
      title: 'Dossier cliente sintetico riservato', content: 'NOTA_DOSSIER_RISERVATA', createdById: admin.user.id } });
    const dossier = await db.dossier.create({ data: { clientId: f.client.id, projectId: f.project.id,
      title: 'Dossier progetto sintetico riservato', type: 'pre_analisi', markdownContent: 'NOTA_DOSSIER_RISERVATA' } });
    const target = technicalTarget(f);
    await assignTechnical(db, admin, target, f.techA, { documents: [{ fileId: f.documents[0].version.id, allowDownload: true }] });
    if (index !== 1) await assignTechnical(db, admin, target, f.techB, { documents: [{ fileId: f.documents[0].version.id, allowDownload: true }] });
    rows.push({ clientId: f.client.id, projectId: f.project.id, practiceId: f.practice.id, leadId: f.lead.id,
      clientDossierId: clientDossier.id, dossierId: dossier.id,
      contractId: f.contract.id, contractNumber: f.contract.contractNumber, paymentId: f.payment.id, mixedProjectId: mixedProject.id,
      techA: { id: f.techA.user.id, email: f.techA.user.email }, techB: { id: f.techB.user.id, email: f.techB.user.email },
      third: { id: third.user.id, email: third.user.email }, mixed: { id: mixed.user.id, email: mixed.user.email },
      sales: { id: f.salesA.user.id, email: f.salesA.user.email },
      documents: f.documents.map(x => ({ id: x.doc.id, versionId: x.version.id, title: x.doc.title, fileName: x.doc.fileName, text: x.bytes.toString() })),
      excluded: [f.practice.internalNotes!, f.project.description!, f.project.scenarioA!, f.contract.serviceName,
        f.contract.serviceDescription!, f.payment.notes!, f.contract.contractNumber, 'NOTA_SECONDA_FUNZIONE_RISERVATA', 'NOTA_DOSSIER_RISERVATA'] });
  }
  // Apply exactly the ordinary registry activation sequence; browser sessions
  // are subsequently created only through the application's login form.
  for (const user of await db.user.findMany({ select: { id: true } }))
    await db.$transaction(tx => revokeAllInternalSessions(tx, user.id, 'INTERNAL_GLOBAL', admin.user.id));
  await assertRegistryActivationReady(db); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id, adminEmail: admin.user.email, rows }));
  console.log('TECHNICAL_CONFIDENTIALITY_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
