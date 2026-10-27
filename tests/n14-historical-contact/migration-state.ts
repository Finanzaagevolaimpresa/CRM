import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { initializeCommercialLeadInboxItem, assignCommercialLeadInboxItem, recordCommercialLeadFirstResponse, convertCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { acceptResponsibility, readResponsibility } from '../../src/lib/responsibility';
import { withSerializableTransaction } from '../../src/lib/serializable';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.COMMERCIAL_LEAD_INBOX_MODE, 'enforced');
  const ledger = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  assert.equal(ledger[0].count, 69n);
  async function actor(role: 'admin' | 'commerciale') {
    const u = await db.user.create({ data: { role, name: 'SQL70 synthetic history', email: randomUUID() + '@example.invalid', passwordHash: 'synthetic-no-login' } });
    const s = await db.internalSession.create({ data: { userId: u.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 600_000) } });
    return { userId: u.id, sessionId: s.id };
  }
  const admin = await actor('admin'), owner = await actor('commerciale');
  await db.commercialLeadSlaPolicyVersion.create({ data: { policyCode: 'COMMERCIAL_FIRST_RESPONSE', version: 1, status: 'ACTIVE',
    calendarCode: 'CONTINUOUS_24X7', timezoneCode: 'UTC', responseTargetSeconds: 3600, createdById: admin.userId } });
  for (const phase of ['OPEN', 'RESPONDED', 'CONVERTED']) {
    const l = await db.lead.create({ data: { firstName: 'Synthetic existing history', lastName: phase, source: 'CRM', leadSource: 'manuale' } });
    const initial = await initializeCommercialLeadInboxItem(db, { leadId: l.id, actor: admin, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE' });
    let item = await assignCommercialLeadInboxItem(db, { leadId: l.id, actor: { ...admin, requireManualAdmin: true }, targetUserId: owner.userId, expectedInboxVersion: initial.version });
    const decision = (await readResponsibility(db, 'Lead', l.id)).current!;
    await withSerializableTransaction(db, tx => acceptResponsibility(tx, owner, { kind: 'Lead', id: l.id, decisionId: decision.id, role: 'commerciale' }));
    if (phase !== 'OPEN') {
      await recordCommercialLeadFirstResponse(db, { leadId: l.id, actor: owner, expectedInboxVersion: item.version });
      item = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { id: item.id } });
      if (phase === 'CONVERTED') {
        const client = await convertCommercialLeadInboxItem(db, { leadId: l.id, actor: owner, expectedInboxVersion: item.version, clientType: 'persona_fisica' });
        await db.task.create({ data: { clientId: client.id, title: 'Preserve synthetic existing task' } });
        await db.documentChecklistItem.create({ data: { clientId: client.id, title: 'Preserve synthetic existing checklist' } });
      }
    }
  }
  assert.equal(await db.commercialLeadSlaCycle.count({ where: { firstResponseAt: { not: null } } }), 2);
  assert.equal(await db.client.count(), 1);
  console.log('SQL70_SYNTHETIC_PRIOR_HISTORY_READY');
}
void main().finally(() => db.$disconnect()).catch(() => { console.error('SQL70_SYNTHETIC_HISTORY_FAILED'); process.exitCode = 1; });

