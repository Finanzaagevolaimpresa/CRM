import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { selectiveLeadFixture } from './fixtures';

const db = new PrismaClient();
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.SELECTIVE_LEAD_BROWSER_CONFIRMED, '1');
  const password = process.env.SELECTIVE_LEAD_BROWSER_PASSWORD!, evidence = process.env.SELECTIVE_LEAD_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  assert.equal(await db.selectiveLeadAuthority.count(), 0);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  await db.selectiveLeadAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  const rows: Array<{ leadId: string; label: string; readerId: string; readerEmail: string; privateNote: string | null;
    privateEmail: string | null; offerId: string; offerTitle: string; otherLeadId: string; otherLabel: string | null }> = [];
  for (let i = 0; i < 3; i++) {
    const f = await selectiveLeadFixture(db, admin, 'admin', hash);
    rows.push({ leadId: f.lead.id, label: f.label, readerId: f.reader.user.id, readerEmail: f.reader.user.email,
      privateNote: f.lead.notes, privateEmail: f.lead.email, offerId: f.offer.id, offerTitle: f.offer.title,
      otherLeadId: f.other.id, otherLabel: f.other.companyName });
  }
  await db.$transaction(async tx => {
    for (const id of [admin.user.id, ...rows.map(row => row.readerId)]) await revokeAllInternalSessions(tx, id, 'INTERNAL_GLOBAL', admin.user.id);
  });
  await assertRegistryActivationReady(db);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id, adminEmail: admin.user.email, rows }));
  console.log('SELECTIVE_LEAD_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
