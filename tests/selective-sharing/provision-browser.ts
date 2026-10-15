import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticSharingCase } from './fixtures';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient();
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.SELECTIVE_BROWSER_CONFIRMED, '1');
  assert.equal(await db.user.count(), 0);
  const password = process.env.SELECTIVE_BROWSER_PASSWORD, evidence = process.env.SELECTIVE_EVIDENCE, storage = process.env.LOCAL_DOCUMENT_STORAGE_ROOT;
  assert.ok(password && password.length >= 24 && evidence && storage);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  const fixture = await syntheticSharingCase(db, admin, hash);
  for (const item of [...fixture.documents, fixture.otherDocument]) {
    const target = path.resolve(storage, item.version.storagePath);
    assert.ok(target.startsWith(path.resolve(storage) + path.sep));
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, item.bytes, { flag: 'wx', mode: 0o600 });
  }
  await db.$transaction(async tx => {
    for (const person of [admin, fixture.reader, fixture.otherAdmin]) await revokeAllInternalSessions(tx, person.user.id, 'INTERNAL_GLOBAL', admin.user.id);
  });
  await assertRegistryActivationReady(db);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, projectId: fixture.project.id, clientId: fixture.client.id,
    otherProjectId: fixture.otherProject.id, recipientId: fixture.reader.user.id, adminId: admin.user.id,
    otherServiceId: fixture.otherService.id, otherPracticeId: fixture.otherPractice.id, otherDocumentId: fixture.otherDocument.doc.id,
    restrictedMessageId: fixture.messages[0].id, otherMessageId: fixture.messages[1].id, replyId: fixture.reply.id,
    contractId: fixture.contract.id, serviceId: fixture.service.id, offerId: fixture.offer.id, leadId: fixture.lead.id,
    emails: { admin: admin.user.email, recipient: fixture.reader.user.email, other: fixture.otherAdmin.user.email },
    documents: fixture.documents.map(row => ({ id: row.doc.id, versionId: row.version.id })) }));
  console.log('SELECTIVE_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
