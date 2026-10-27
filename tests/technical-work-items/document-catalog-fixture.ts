import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { TechnicalFixture } from '../technical-assignments/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { localPathFromStoragePath } from '../../src/lib/storage';

export async function documentCatalogueFixture(db: PrismaClient, f: TechnicalFixture,
  documentCount = 65, versionsPerDocument = 1, writeBytes = false) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const prefix = randomUUID(), documents = [], files = [], result = [];
  for (let i = 0; i < documentCount; i++) {
    const id = `${prefix}-doc-${String(i).padStart(3, '0')}`, title = `Catalogo documentale sintetico ${String(i).padStart(3, '0')}`;
    const fileName = `catalogo-${String(i).padStart(3, '0')}.txt`, versions = [];
    for (let version = 1; version <= versionsPerDocument; version++) {
      const fileId = `${prefix}-file-${String(i).padStart(3, '0')}-${String(version).padStart(3, '0')}`;
      const bytes = Buffer.from(`DOCUMENTO_CATALOGO_SINTETICO_${i}_VERSIONE_${version}`), checksum = createHash('sha256').update(bytes).digest('hex');
      const storagePath = `technical-synthetic/${fileId}.txt`;
      files.push({ id: fileId, documentId: id, version, checksum, storagePath });
      versions.push({ fileId, version, checksum, storagePath, text: bytes.toString() });
      if (writeBytes) { const file = localPathFromStoragePath(storagePath); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
    }
    const last = versions[versions.length - 1];
    documents.push({ id, clientId: f.client.id, projectId: f.project.id, title, fileName,
      type: 'text/plain', mimeType: 'text/plain', documentCategory: 'altro', serviceArea: 'progetto_investimento' as const,
      storagePath: last.storagePath, sizeBytes: Buffer.byteLength(last.text), checksum: last.checksum, uploadedById: f.admin.user.id });
    result.push({ id, title, fileName, versions });
  }
  await db.document.createMany({ data: documents }); await db.documentVersion.createMany({ data: files });
  return result;
}
