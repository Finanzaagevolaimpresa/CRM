import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { grantLead, leadProof } from '../selective-leads/fixtures';
import { readLeadSharing, revokeLeadSharing } from '../../src/lib/selective-lead-access';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD!;
  assert.ok(password.length >= 24);
  const hash = await bcrypt.hash(password, 10);
  const admin = await syntheticPerson(db, 'Synthetic lead recovery authority', 'admin', hash);
  const reader = await syntheticPerson(db, 'Synthetic lead recovery recipient', 'admin', hash);
  await db.selectiveLeadAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  const rows = [];
  const previousMode = process.env.PRIVILEGED_ACCESS_MODE;
  process.env.PRIVILEGED_ACCESS_MODE = 'enforced';
  try {
    for (const suffix of ['LIVE', 'REVOKED', 'OTHER']) {
      const row = await db.lead.create({ data: { firstName: 'Synthetic', lastName: suffix,
        companyName: 'SELECTIVE_LEAD_RECOVERY_' + suffix, assignedToId: reader.user.id,
        email: `${randomUUID()}@invalid.test`, notes: 'LEAD_RECOVERY_PRIVATE_' + suffix } });
      rows.push(row);
      if (suffix === 'OTHER') continue;
      const { receipt } = await grantLead(db, admin, { leadId: row.id, recipientId: reader.user.id,
        revision: 0, commandId: randomUUID(), fields: ['companyName', 'status'], expiresAt: null });
      if (suffix === 'REVOKED') await revokeLeadSharing(db, admin.session,
        { grantId: receipt.grantId, revision: 1, commandId: randomUUID() }, leadProof(admin));
    }
    assert.equal((await readLeadSharing(db, reader.session, rows[0].id)).fields.length, 2);
    await assert.rejects(readLeadSharing(db, reader.session, rows[1].id));
  } finally {
    if (previousMode === undefined) delete process.env.PRIVILEGED_ACCESS_MODE;
    else process.env.PRIVILEGED_ACCESS_MODE = previousMode;
  }
  writeFileSync(process.env.R05_LEAD_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true,
    adminId: admin.user.id, readerId: reader.user.id, email: reader.user.email,
    liveId: rows[0].id, liveLabel: rows[0].companyName, privateEmail: rows[0].email,
    revokedId: rows[1].id, otherId: rows[2].id, otherLabel: rows[2].companyName }) + '\n');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
