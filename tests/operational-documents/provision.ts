import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { documentFixture } from './fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { clientProof } from '../selective-clients/fixtures';
import { confirmDriveFolder, previewDriveFolder, readDriveFolder, listDriveFolders } from '../../src/lib/drive-folder-library';
const db = new PrismaClient();
async function run() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert.equal(process.env.APP_ENV, 'test');
  const f = await documentFixture(db, await bcrypt.hash('synthetic-document-browser-only-2026', 10));
  await db.userPermissionOverride.create({ data: { userId: f.technical.user.id, permission: 'drive_folders.read', allowed: true } });
  const project = await db.project.create({ data: { clientId: f.client.id, companyId: f.company.id,
    title: 'Fascicolo tecnico sintetico da avviare', consultantId: f.technical.user.id } });
  const folder = { id: randomUUID(), title: 'Pratiche Clienti → Pratiche da avviare · fascicolo sintetico' };
  const details = { clientId: f.client.id, title: folder.title,
    url: 'https://drive.google.com/drive/folders/synthetic_technical_' + folder.id.replaceAll('-', ''),
    people: [f.technical.user.id], technicalContentReviewed: true, expiresAt: null };
  for (const [index, operation] of (['SAVE_DRAFT', 'ACTIVATE'] as const).entries()) {
    const input = { protocol: 'DRIVE_FOLDER_REFERENCE_V1', commandId: randomUUID(), folderId: folder.id,
      expectedVersion: index, operation, details };
    const preview = await previewDriveFolder(db, f.admin.session, input);
    await confirmDriveFolder(db, f.admin.session, input, preview.digest, clientProof(f.admin));
  }
  assert.equal((await readDriveFolder(db, f.technical.session, folder.id)).url, details.url);
  assert.equal((await listDriveFolders(db, f.technical.session, { clientId: f.client.id })).some(row => row.id === folder.id), true);
  await assert.rejects(readDriveFolder(db, f.other.session, folder.id));
  const output = resolve(process.env.OPERATIONAL_DOCUMENT_EVIDENCE ?? 'test-results/operational-documents');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'fixture.json'), JSON.stringify({ synthetic: true, leadId: f.lead.id, clientId: f.client.id, companyName: f.company.name,
    templateId: f.template.templateId, templateCommandId: f.publication.commandId, proformaTemplateCommandId: f.proformaPublication.commandId, serviceRevisionId: f.service.id,
    technicalFolder: { ...folder, url: details.url, projectId: project.id },
    admin: { id: f.admin.user.id, email: f.admin.user.email }, owner: { id: f.owner.user.id, email: f.owner.user.email },
    other: { id: f.other.user.id, email: f.other.user.email }, technical: { id: f.technical.user.id, email: f.technical.user.email } }));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
