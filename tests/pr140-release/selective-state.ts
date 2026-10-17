import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticSharingCase } from '../selective-sharing/fixtures';
import { previewSelectiveAccess, confirmSelectiveAccess, revokeSelectiveAccess } from '../../src/lib/selective-project-access';
import { transitionProjectLifecycle } from '../../src/lib/project-lifecycle';
import { transitionLeadLifecycle } from '../../src/lib/lead-lifecycle';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { leadFixture } from '../lead-lifecycle/fixtures';

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
  const trashedLead = await leadFixture(db, f.reader.user.id), restoredLead = await leadFixture(db, f.reader.user.id);
  const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
  const proof = { key, sessionToken: authority.token,
    stepUpToken: createPrivilegedStepUpToken({ key, userId: authority.user.id, sessionToken: authority.token }) };
  const previousMode = process.env.PRIVILEGED_ACCESS_MODE;
  process.env.PRIVILEGED_ACCESS_MODE = 'enforced';
  try {
    for (const [item, actions] of [[trashedLead, ['trash']], [restoredLead, ['trash', 'restore']]] as const) {
      for (const action of actions) {
        const lead = await db.lead.findUniqueOrThrow({ where: { id: item.lead.id } });
        await transitionLeadLifecycle(db, authority.session, { id: lead.id, updatedAt: lead.updatedAt.toISOString(), action, confirmed: 'yes' }, proof);
      }
    }
  } finally {
    if (previousMode === undefined) delete process.env.PRIVILEGED_ACCESS_MODE;
    else process.env.PRIVILEGED_ACCESS_MODE = previousMode;
  }
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
    archivedProjectId: suspended.id, trashProjectId: trash.id,
    trashedLeadId: trashedLead.lead.id, trashedLeadLabel: trashedLead.label, trashedOfferId: trashedLead.offer.id,
    preservedClientId: trashedLead.client.id, restoredLeadId: restoredLead.lead.id, restoredLeadLabel: restoredLead.label }));
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
