import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';

const db = new PrismaClient();
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.LEAD_BROWSER_CONFIRMED, '1');
  assert.equal(await db.user.count(), 0);
  const password = process.env.LEAD_BROWSER_PASSWORD!, evidence = process.env.LEAD_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  const owner = await syntheticPerson(db, 'Commerciale sintetico', 'commerciale', hash);
  await db.$transaction(async tx => {
    for (const person of [admin, owner]) await revokeAllInternalSessions(tx, person.user.id, 'INTERNAL_GLOBAL', admin.user.id);
  });
  await assertRegistryActivationReady(db);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id, ownerId: owner.user.id,
    emails: { admin: admin.user.email, owner: owner.user.email } }));
  console.log('LEAD_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
