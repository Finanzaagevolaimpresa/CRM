import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { grantClient, clientProof } from '../selective-clients/fixtures';
import { readClientSharing, revokeClientSharing } from '../../src/lib/selective-client-access';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD!;
  assert.ok(password.length >= 24);
  const hash = await bcrypt.hash(password, 10);
  const admin = await syntheticPerson(db, 'Synthetic client recovery authority', 'admin', hash);
  const reader = await syntheticPerson(db, 'Synthetic client recovery recipient', 'admin', hash);
  await db.selectiveClientAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  const rows: { id: string; label: string; companyId: string; projectId: string; leadId: string }[] = [];
  for (const suffix of ['LIVE', 'REVOKED', 'OTHER']) {
    const client = await db.client.create({ data: { type: 'societa', displayName: 'SELECTIVE_CLIENT_RECOVERY_' + suffix,
      salesOwnerId: reader.user.id, notes: 'CLIENT_RECOVERY_PRIVATE_' + suffix } });
    const company = await db.company.create({ data: { clientId: client.id, name: 'CLIENT_RECOVERY_COMPANY_' + suffix } });
    const project = await db.project.create({ data: { clientId: client.id, companyId: company.id,
      title: 'CLIENT_RECOVERY_PROJECT_' + suffix } });
    const lead = await db.lead.create({ data: { clientId: client.id, assignedToId: reader.user.id,
      firstName: 'Synthetic', lastName: suffix, companyName: 'CLIENT_RECOVERY_LEAD_' + suffix } });
    rows.push({ id: client.id, label: client.displayName, companyId: company.id, projectId: project.id, leadId: lead.id });
    if (suffix === 'OTHER') continue;
    const { receipt } = await grantClient(db, admin, { clientId: client.id, recipientId: reader.user.id,
      revision: 0, commandId: randomUUID(), fields: ['displayName', 'status'], expiresAt: null });
    if (suffix === 'REVOKED') await revokeClientSharing(db, admin.session,
      { grantId: receipt.grantId, revision: 1, commandId: randomUUID() }, clientProof(admin));
  }
  assert.equal((await readClientSharing(db, reader.session, rows[0].id)).fields.length, 2);
  await assert.rejects(readClientSharing(db, reader.session, rows[1].id));
  writeFileSync(process.env.R05_CLIENT_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true,
    adminId: admin.user.id, readerId: reader.user.id, email: reader.user.email, rows }) + '\n');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
