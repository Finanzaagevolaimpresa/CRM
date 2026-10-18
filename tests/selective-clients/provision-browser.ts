import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { selectiveClientFixture } from './fixtures';
const db = new PrismaClient();
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.SELECTIVE_CLIENT_BROWSER_CONFIRMED, '1');
  const password = process.env.SELECTIVE_CLIENT_BROWSER_PASSWORD!, evidence = process.env.SELECTIVE_CLIENT_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  assert.equal(await db.selectiveClientAuthority.count(), 0);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  await db.selectiveClientAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  const rows: { clientId: string; label: string; readerId: string; readerEmail: string; privateNote: string | null;
    companyId: string; companyName: string; projectId: string; projectTitle: string; leadId: string;
    otherClientId: string; otherLabel: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const f = await selectiveClientFixture(db, admin, 'admin', hash);
    rows.push({ clientId: f.client.id, label: f.client.displayName, readerId: f.reader.user.id,
      readerEmail: f.reader.user.email, privateNote: f.client.notes, companyId: f.company.id,
      companyName: f.company.name, projectId: f.project.id, projectTitle: f.project.title,
      leadId: f.lead.id, otherClientId: f.other.id, otherLabel: f.other.displayName });
  }
  await db.$transaction(async tx => {
    for (const id of [admin.user.id, ...rows.map(row => row.readerId)]) await revokeAllInternalSessions(tx, id, 'INTERNAL_GLOBAL', admin.user.id);
  });
  await assertRegistryActivationReady(db);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id, adminEmail: admin.user.email, rows }));
  console.log('SELECTIVE_CLIENT_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
