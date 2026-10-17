import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticSharingCase } from '../selective-sharing/fixtures';
import { previewSelectiveAccess, confirmSelectiveAccess, revokeSelectiveAccess } from '../../src/lib/selective-project-access';
import { transitionProjectLifecycle } from '../../src/lib/project-lifecycle';

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
  const lifecycle = await syntheticSharingCase(db, authority, hash);
  await confirmSelectiveAccess(db, authority.session, (await previewSelectiveAccess(db, authority.session,
    { ...lifecycle.input, recipientId: f.reader.user.id })).token, true);
  for (const action of ['archive', 'trash', 'restore', 'reactivate'] as const) {
    const project = await db.project.findUniqueOrThrow({ where: { id: lifecycle.project.id } });
    await transitionProjectLifecycle(db, authority.session, { id: project.id, updatedAt: project.updatedAt.toISOString(), action, confirmed: 'yes' });
  }
  const lifecycleGrant = await db.selectiveProjectGrant.findUniqueOrThrow({ where: { projectId_recipientId: { projectId: lifecycle.project.id, recipientId: f.reader.user.id } } });
  assert.equal(lifecycleGrant.revokedAt, null); // It is the durable lifecycle receipt that suspends this otherwise live grant.
  const suspended = await db.project.create({ data: { clientId: f.client.id, title: 'RECOVERY_ARCHIVED_SYNTHETIC' } });
  await transitionProjectLifecycle(db, authority.session, { id: suspended.id, updatedAt: suspended.updatedAt.toISOString(), action: 'archive', confirmed: 'yes' });
  const trash = await db.project.create({ data: { clientId: f.client.id, title: 'RECOVERY_TRASH_SYNTHETIC' } });
  await transitionProjectLifecycle(db, authority.session, { id: trash.id, updatedAt: trash.updatedAt.toISOString(), action: 'trash', confirmed: 'yes' });
  for (const item of [...f.documents, ...lifecycle.documents]) {
    const target = path.resolve(storage, item.version.storagePath);
    assert.ok(target.startsWith(path.resolve(storage) + path.sep));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, item.bytes, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(process.env.R05_SELECTIVE_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true, email: f.reader.user.email,
    projectId: f.project.id, revokedProjectId: f.otherProject.id, clientId: f.client.id, contractId: f.contract.id,
    versions: f.documents.map(item => item.version.id), lifecycleProjectId: lifecycle.project.id,
    lifecycleDocumentId: lifecycle.documents[0].doc.id, lifecycleVersionId: lifecycle.documents[0].version.id,
    archivedProjectId: suspended.id, trashProjectId: trash.id }));
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
