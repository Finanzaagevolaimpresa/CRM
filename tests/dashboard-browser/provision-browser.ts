import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
const db = new PrismaClient();
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.DASHBOARD_BROWSER_CONFIRMED, '1'); assert.equal(await db.user.count(), 0);
  const password = process.env.DASHBOARD_BROWSER_PASSWORD!, evidence = process.env.DASHBOARD_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticPerson(db, 'Antonio · profilo sintetico', 'admin', hash);
  const reader = await syntheticPerson(db, 'Commerciale dashboard sintetico', 'commerciale', hash);
  const technical = await syntheticPerson(db, 'Tecnico dashboard sintetico', 'consulente', hash);
  const other = await syntheticPerson(db, 'Altro profilo sintetico', 'consulente', hash);
  const restricted = await syntheticPerson(db, 'Profilo senza aree sintetico', 'collaboratore_limitato', hash);
  await db.userPermissionOverride.createMany({ data: ['lead.read', 'service.read', 'technical.read', 'dossier.read'].map(permission => ({ userId: restricted.user.id, permission, allowed: false })) });
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente sintetico dashboard', consultantId: technical.user.id, salesOwnerId: reader.user.id } });
  const project = await db.project.create({ data: { title: 'Progetto sintetico dashboard', clientId: client.id, consultantId: technical.user.id } });
  const now = new Date(), yesterday = new Date(+now - 86_400_000), tomorrow = new Date(+now + 86_400_000);
  const leads = [];
  for (let i = 0; i < 47; i++) leads.push(await db.lead.create({ data: { firstName: 'Contatto', lastName: `sintetico ${i + 1}`, companyName: `Lead sintetico ${String(i + 1).padStart(2, '0')}`, status: 'da_contattare', assignedToId: i < 3 ? reader.user.id : other.user.id, nextActionDate: now } }));
  await db.lead.createMany({ data: [{ firstName: 'Lead', lastName: 'nuovo escluso dal filtro', status: 'nuovo', assignedToId: reader.user.id }, { firstName: 'Lead', lastName: 'nel cestino escluso', status: 'da_contattare', deletedAt: now, assignedToId: reader.user.id }] });
  for (let i = 0; i < 18; i++) await db.technicalPractice.create({ data: { title: `Pratica sintetica ${String(i + 1).padStart(2, '0')}`, clientId: client.id, projectId: project.id, practiceType: 'synthetic', targetEntity: 'synthetic', createdById: admin.user.id, technicalOwnerId: technical.user.id, dueDate: new Date(+now + i * 60_000), status: i % 3 === 0 ? 'in_progettazione' : i % 3 === 1 ? 'documenti_richiesti' : 'in_istruttoria' } });
  await db.technicalPractice.create({ data: { title: 'Pratica approvata fuori filtro', clientId: client.id, projectId: project.id, practiceType: 'synthetic', targetEntity: 'synthetic', createdById: admin.user.id, technicalOwnerId: technical.user.id, status: 'approvata' } });
  for (let i = 0; i < 6; i++) await db.preAnalysis.create({ data: { clientId: client.id, projectId: project.id, status: i % 2 ? 'da_revisionare' : 'bozza_generata', internalSummary: 'Sintesi sintetica riservata non inclusa nel riquadro' } });
  await db.preAnalysis.create({ data: { clientId: client.id, projectId: project.id, status: 'approvata_internamente' } });
  for (let i = 0; i < 3; i++) await db.task.create({ data: { title: `Attività sintetica oggi ${i + 1}`, dueAt: now, assignedToId: reader.user.id, createdById: reader.user.id } });
  await db.task.createMany({ data: [{ title: 'Attività sintetica ieri', dueAt: yesterday, assignedToId: reader.user.id }, { title: 'Attività sintetica domani', dueAt: tomorrow, assignedToId: reader.user.id }, { title: 'Attività sintetica completata', dueAt: now, status: 'completata', completedAt: now, assignedToId: reader.user.id }, { title: 'Attività sintetica eliminata', dueAt: now, deletedAt: now, assignedToId: reader.user.id }] });
  await db.$transaction(async tx => { for (const p of [admin, reader, technical, other, restricted]) await revokeAllInternalSessions(tx, p.user.id, 'INTERNAL_GLOBAL', admin.user.id); });
  await assertRegistryActivationReady(db); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id, readerId: reader.user.id, otherId: other.user.id, leadId: leads[0].id,
    emails: { admin: admin.user.email, reader: reader.user.email, restricted: restricted.user.email }, clientId: client.id, projectId: project.id }));
  console.log('DASHBOARD_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
