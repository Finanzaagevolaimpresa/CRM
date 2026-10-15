import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticSharingCase } from '../selective-sharing/fixtures';
import { previewSelectiveAccess, confirmSelectiveAccess, revokeSelectiveAccess } from '../../src/lib/selective-project-access';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true');
  const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD!, storage = process.env.LOCAL_DOCUMENT_STORAGE_ROOT!;
  assert.ok(password.length >= 24 && path.isAbsolute(storage));
  const hash = await bcrypt.hash(password, 10), authority = await syntheticAuthority(db, hash);
  const f = await syntheticSharingCase(db, authority, hash);
  await confirmSelectiveAccess(db, authority.session, (await previewSelectiveAccess(db, authority.session, f.input)).token, true);
  const second = await confirmSelectiveAccess(db, authority.session, (await previewSelectiveAccess(db, authority.session,
    { ...f.input, projectId: f.otherProject.id, fields: ['title'], documents: [] })).token, true);
  await revokeSelectiveAccess(db, authority.session, second.id, second.revision, true);
  for (const item of f.documents) {
    const target = path.resolve(storage, item.version.storagePath);
    assert.ok(target.startsWith(path.resolve(storage) + path.sep));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, item.bytes, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(process.env.R05_SELECTIVE_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true, email: f.reader.user.email,
    projectId: f.project.id, revokedProjectId: f.otherProject.id, clientId: f.client.id, contractId: f.contract.id,
    versions: f.documents.map(item => item.version.id) }));
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
