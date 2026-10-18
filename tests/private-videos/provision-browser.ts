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
  assert.equal(process.env.VIDEOS_BROWSER_CONFIRMED, '1'); assert.equal(await db.user.count(), 0);
  const password = process.env.VIDEOS_BROWSER_PASSWORD!, evidence = process.env.VIDEOS_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  const reader = await syntheticPerson(db, 'Commerciale video sintetico', 'commerciale', hash);
  const other = await syntheticPerson(db, 'Tecnico video escluso sintetico', 'backoffice', hash);
  await db.$transaction(async tx => {
    for (const p of [admin, reader, other]) await revokeAllInternalSessions(tx, p.user.id, 'INTERNAL_GLOBAL', admin.user.id);
  });
  await assertRegistryActivationReady(db); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id,
    readerId: reader.user.id, otherId: other.user.id, readerName: reader.user.name, otherName: other.user.name,
    emails: { admin: admin.user.email, reader: reader.user.email, other: other.user.email } }));
  console.log('VIDEOS_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
