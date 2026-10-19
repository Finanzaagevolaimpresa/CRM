import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { grantPractice, practiceProof } from '../selective-practices/fixtures';
import { readPracticeSharing, revokePracticeSharing } from '../../src/lib/selective-practice-access';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD!;
  assert.ok(password.length >= 24);
  const hash = await bcrypt.hash(password, 10);
  const admin = await syntheticPerson(db, 'Synthetic practice recovery authority', 'admin', hash);
  const reader = await syntheticPerson(db, 'Synthetic practice recovery recipient', 'admin', hash);
  await db.selectivePracticeAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  const client = await db.client.create({ data: { type: 'societa', displayName: 'PRACTICE_RECOVERY_PARENT', salesOwnerId: reader.user.id } });
  const project = await db.project.create({ data: { clientId: client.id, title: 'PRACTICE_RECOVERY_PROJECT' } });
  const rows: { id: string; label: string; clientId: string; projectId: string }[] = [];
  for (const suffix of ['LIVE', 'REVOKED', 'OTHER']) {
    const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id,
      title: 'SELECTIVE_PRACTICE_RECOVERY_' + suffix, practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
      technicalOwnerId: reader.user.id, createdById: admin.user.id,
      internalNotes: 'PRACTICE_RECOVERY_PRIVATE_' + suffix } });
    rows.push({ id: practice.id, label: practice.title, clientId: client.id, projectId: project.id });
    if (suffix === 'OTHER') continue;
    const { receipt } = await grantPractice(db, admin, { practiceId: practice.id, recipientId: reader.user.id,
      revision: 0, commandId: randomUUID(), fields: ['title', 'status'], expiresAt: null });
    if (suffix === 'REVOKED') await revokePracticeSharing(db, admin.session,
      { grantId: receipt.grantId, revision: 1, commandId: randomUUID() }, practiceProof(admin));
  }
  assert.equal((await readPracticeSharing(db, reader.session, rows[0].id)).fields.length, 2);
  await assert.rejects(readPracticeSharing(db, reader.session, rows[1].id));
  writeFileSync(process.env.R05_PRACTICE_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true,
    adminId: admin.user.id, readerId: reader.user.id, email: reader.user.email, rows }) + '\n');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
