import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { selectivePracticeFixture } from './fixtures';
const db = new PrismaClient();
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.SELECTIVE_PRACTICE_BROWSER_CONFIRMED, '1');
  const password = process.env.SELECTIVE_PRACTICE_BROWSER_PASSWORD!, evidence = process.env.SELECTIVE_PRACTICE_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  assert.equal(await db.selectivePracticeAuthority.count(), 0);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  await db.selectivePracticeAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  const rows: { practiceId: string; label: string; readerId: string; readerEmail: string; privateNote: string | null;
    clientId: string; clientLabel: string; projectId: string; projectTitle: string; otherPracticeId: string; otherLabel: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const f = await selectivePracticeFixture(db, admin, 'admin', hash);
    rows.push({ practiceId: f.practice.id, label: f.practice.title, readerId: f.reader.user.id,
      readerEmail: f.reader.user.email, privateNote: f.practice.internalNotes, clientId: f.client.id,
      clientLabel: f.client.displayName, projectId: f.project.id, projectTitle: f.project.title,
      otherPracticeId: f.other.id, otherLabel: f.other.title });
  }
  await db.$transaction(async tx => {
    for (const id of [admin.user.id, ...rows.map(row => row.readerId)]) await revokeAllInternalSessions(tx, id, 'INTERNAL_GLOBAL', admin.user.id);
  });
  await assertRegistryActivationReady(db);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id, adminEmail: admin.user.email, rows }));
  console.log('SELECTIVE_PRACTICE_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
