import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson, syntheticSession } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { initializeCommercialLeadInboxItem, assignCommercialLeadInboxItem, convertCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { recordHistoricalLeadContact } from '../../src/lib/commercial-lead-historical-contact-storage';
import { acceptResponsibility, readResponsibility } from '../../src/lib/responsibility';
import { withSerializableTransaction } from '../../src/lib/serializable';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert(process.env.R05_HISTORICAL_RECOVERY_FIXTURE);
  process.env.COMMERCIAL_LEAD_INBOX_MODE = 'enforced';
  const adminUser = await db.user.findUniqueOrThrow({ where: { id: 'release-owner' } });
  const admin = await syntheticSession(db, adminUser);
  const owner = await syntheticPerson(db, 'Synthetic historical owner', 'commerciale', adminUser.passwordHash);
  const other = await syntheticPerson(db, 'Synthetic historical unrelated', 'commerciale', adminUser.passwordHash);
  assert(admin.session.sessionId); assert(owner.session.sessionId);
  const adminActor = { userId: adminUser.id, sessionId: admin.session.sessionId };
  const ownerActor = { userId: owner.user.id, sessionId: owner.session.sessionId };
  if (!await db.commercialLeadSlaPolicyVersion.findFirst({ where: { status: 'ACTIVE', policyCode: 'COMMERCIAL_FIRST_RESPONSE' } })) {
    await db.commercialLeadSlaPolicyVersion.create({ data: { policyCode: 'COMMERCIAL_FIRST_RESPONSE', version: 1, status: 'ACTIVE',
      calendarCode: 'CONTINUOUS_24X7', timezoneCode: 'UTC', responseTargetSeconds: 3600, createdById: adminUser.id } });
  }
  const records: Record<string, { leadId: string; contactId: string; conversionId?: string; clientId?: string }> = {};
  for (const phase of ['CONTACT', 'CONVERTED']) {
    const lead = await db.lead.create({ data: { firstName: 'Synthetic historical recovery', lastName: phase, source: 'CRM', leadSource: 'manuale' } });
    const initial = await initializeCommercialLeadInboxItem(db, { leadId: lead.id, actor: adminActor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE' });
    const item = await assignCommercialLeadInboxItem(db, { leadId: lead.id, actor: { ...adminActor, requireManualAdmin: true },
      targetUserId: owner.user.id, expectedInboxVersion: initial.version });
    const decision = (await readResponsibility(db, 'Lead', lead.id)).current!;
    await withSerializableTransaction(db, tx => acceptResponsibility(tx, owner.session, { kind: 'Lead', id: lead.id, decisionId: decision.id, role: 'commerciale' }));
    const contact = await recordHistoricalLeadContact(db, ownerActor, { commandId: randomUUID(), leadId: lead.id, expectedInboxVersion: item.version,
      expectedAssignmentId: decision.id, occurredAt: new Date(item.initializedAt.getTime() - 86400_000).toISOString(),
      source: 'EXISTING_DOCUMENT', evidenceReference: 'SYNTHETIC_HISTORICAL_RECOVERY_REFERENCE', attested: true });
    records[phase] = { leadId: lead.id, contactId: contact.receipt.id };
    if (phase === 'CONVERTED') {
      const commandId = randomUUID();
      const client = await convertCommercialLeadInboxItem(db, { leadId: lead.id, actor: ownerActor, expectedInboxVersion: contact.receipt.inboxVersionAfter,
        clientType: 'persona_fisica', historicalContact: { commandId, contactId: contact.receipt.id, expectedAssignmentId: decision.id } });
      records[phase] = { ...records[phase], conversionId: commandId, clientId: client.id };
    }
    const cycle = await db.commercialLeadSlaCycle.findFirstOrThrow({ where: { inboxItemId: item.id } });
    assert.equal(cycle.firstResponseAt, null);
    assert.equal(cycle.outcome, phase === 'CONVERTED' ? 'HISTORICAL_CONTACT_BEFORE_CRM' : null);
  }
  await writeFile(process.env.R05_HISTORICAL_RECOVERY_FIXTURE, JSON.stringify({ synthetic: true, records,
    ownerEmail: owner.user.email, otherEmail: other.user.email, adminEmail: adminUser.email }));
}
void main().finally(() => db.$disconnect()).catch(() => { console.error('R05_HISTORICAL_FIXTURE_FAILED'); process.exitCode = 1; });

