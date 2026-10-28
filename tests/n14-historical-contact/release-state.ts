import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { initializeCommercialLeadInboxItem, assignCommercialLeadInboxItem, convertCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { recordHistoricalLeadContact } from '../../src/lib/commercial-lead-historical-contact-storage';
import { acceptResponsibility, readResponsibility } from '../../src/lib/responsibility';
import { withSerializableTransaction } from '../../src/lib/serializable';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.COMMERCIAL_LEAD_INBOX_MODE, 'enforced');
  const ledger = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  assert.equal(ledger[0].count, 70n);
  async function historicalCounts() {
    const rows = await db.$queryRaw<Array<{ contacts: bigint; conversions: bigint }>>`
      SELECT (SELECT count(*) FROM "CommercialLeadHistoricalContact") AS contacts,
             (SELECT count(*) FROM "CommercialLeadHistoricalConversion") AS conversions`;
    return rows[0];
  }
  assert.deepEqual(await historicalCounts(), { contacts: 0n, conversions: 0n });
  async function actor(role: 'admin' | 'commerciale') {
    const user = await db.user.create({ data: { role, name: 'SQL70 synthetic retained history', email: randomUUID() + '@example.invalid', passwordHash: 'synthetic-no-login' } });
    const session = await db.internalSession.create({ data: { userId: user.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 600_000) } });
    return { userId: user.id, sessionId: session.id };
  }
  const admin = await actor('admin'), owner = await actor('commerciale');
  assert(await db.commercialLeadSlaPolicyVersion.findFirst({ where: { policyCode: 'COMMERCIAL_FIRST_RESPONSE', status: 'ACTIVE' } }));
  for (const phase of ['CONTACT', 'CONVERTED']) {
    const lead = await db.lead.create({ data: { firstName: 'Synthetic retained history', lastName: phase, source: 'CRM', leadSource: 'manuale' } });
    const initial = await initializeCommercialLeadInboxItem(db, { leadId: lead.id, actor: admin, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE' });
    const item = await assignCommercialLeadInboxItem(db, { leadId: lead.id, actor: { ...admin, requireManualAdmin: true }, targetUserId: owner.userId, expectedInboxVersion: initial.version });
    const decision = (await readResponsibility(db, 'Lead', lead.id)).current!;
    await withSerializableTransaction(db, tx => acceptResponsibility(tx, owner, { kind: 'Lead', id: lead.id, decisionId: decision.id, role: 'commerciale' }));
    const contact = await recordHistoricalLeadContact(db, owner, { commandId: randomUUID(), leadId: lead.id, expectedInboxVersion: item.version,
      expectedAssignmentId: decision.id, occurredAt: new Date(item.initializedAt.getTime() - 86400_000).toISOString(),
      source: 'EXISTING_DOCUMENT', evidenceReference: 'SYNTHETIC_RETAINED_HISTORY_REFERENCE', attested: true });
    if (phase === 'CONVERTED') await convertCommercialLeadInboxItem(db, { leadId: lead.id, actor: owner,
      expectedInboxVersion: contact.receipt.inboxVersionAfter, clientType: 'persona_fisica',
      historicalContact: { commandId: randomUUID(), contactId: contact.receipt.id, expectedAssignmentId: decision.id } });
    const cycle = await db.commercialLeadSlaCycle.findFirstOrThrow({ where: { inboxItemId: item.id } });
    assert.equal(cycle.firstResponseAt, null);
    assert.equal(cycle.outcome, phase === 'CONVERTED' ? 'HISTORICAL_CONTACT_BEFORE_CRM' : null);
  }
  assert.deepEqual(await historicalCounts(), { contacts: 2n, conversions: 1n });
  console.log('SQL70_SYNTHETIC_RETAINED_HISTORY_READY');
}
void main().finally(() => db.$disconnect()).catch(() => { console.error('SQL70_SYNTHETIC_RETAINED_HISTORY_FAILED'); process.exitCode = 1; });
