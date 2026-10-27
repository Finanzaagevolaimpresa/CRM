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
let phase = 'isolation';
async function main() {
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert(process.env.R05_HISTORICAL_RECOVERY_FIXTURE);
  process.env.COMMERCIAL_LEAD_INBOX_MODE = 'enforced';
  phase = 'actors';
  const adminUser = await db.user.findUniqueOrThrow({ where: { id: 'release-owner' } });
  const admin = await syntheticSession(db, adminUser);
  const owner = await syntheticPerson(db, 'Synthetic historical owner', 'commerciale', adminUser.passwordHash);
  const other = await syntheticPerson(db, 'Synthetic historical unrelated', 'commerciale', adminUser.passwordHash);
  assert(admin.session.sessionId); assert(owner.session.sessionId);
  const adminActor = { userId: adminUser.id, sessionId: admin.session.sessionId };
  const ownerActor = { userId: owner.user.id, sessionId: owner.session.sessionId };
  phase = 'policy';
  if (!await db.commercialLeadSlaPolicyVersion.findFirst({ where: { status: 'ACTIVE', policyCode: 'COMMERCIAL_FIRST_RESPONSE' } })) {
    await db.commercialLeadSlaPolicyVersion.create({ data: { policyCode: 'COMMERCIAL_FIRST_RESPONSE', version: 1, status: 'ACTIVE',
      calendarCode: 'CONTINUOUS_24X7', timezoneCode: 'UTC', responseTargetSeconds: 3600, createdById: adminUser.id } });
  }
  const records: Record<string, { leadId: string; contactId: string; conversionId?: string; clientId?: string }> = {};
  for (const state of ['CONTACT', 'CONVERTED']) {
    phase = state + ':lead';
    const lead = await db.lead.create({ data: { firstName: 'Synthetic historical recovery', lastName: state, source: 'CRM', leadSource: 'manuale' } });
    phase = state + ':initialize';
    const initial = await initializeCommercialLeadInboxItem(db, { leadId: lead.id, actor: adminActor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE' });
    phase = state + ':assign';
    const item = await assignCommercialLeadInboxItem(db, { leadId: lead.id, actor: { ...adminActor, requireManualAdmin: true },
      targetUserId: owner.user.id, expectedInboxVersion: initial.version });
    phase = state + ':responsibility';
    const decision = (await readResponsibility(db, 'Lead', lead.id)).current!;
    await withSerializableTransaction(db, tx => acceptResponsibility(tx, owner.session, { kind: 'Lead', id: lead.id, decisionId: decision.id, role: 'commerciale' }));
    phase = state + ':contact';
    const contact = await recordHistoricalLeadContact(db, ownerActor, { commandId: randomUUID(), leadId: lead.id, expectedInboxVersion: item.version,
      expectedAssignmentId: decision.id, occurredAt: new Date(item.initializedAt.getTime() - 86400_000).toISOString(),
      source: 'EXISTING_DOCUMENT', evidenceReference: 'SYNTHETIC_HISTORICAL_RECOVERY_REFERENCE', attested: true });
    records[state] = { leadId: lead.id, contactId: contact.receipt.id };
    if (state === 'CONVERTED') {
      phase = state + ':convert';
      const commandId = randomUUID();
      const client = await convertCommercialLeadInboxItem(db, { leadId: lead.id, actor: ownerActor, expectedInboxVersion: contact.receipt.inboxVersionAfter,
        clientType: 'persona_fisica', historicalContact: { commandId, contactId: contact.receipt.id, expectedAssignmentId: decision.id } });
      records[state] = { ...records[state], conversionId: commandId, clientId: client.id };
    }
    const cycle = await db.commercialLeadSlaCycle.findFirstOrThrow({ where: { inboxItemId: item.id } });
    assert.equal(cycle.firstResponseAt, null);
    assert.equal(cycle.outcome, state === 'CONVERTED' ? 'HISTORICAL_CONTACT_BEFORE_CRM' : null);
  }
  await writeFile(process.env.R05_HISTORICAL_RECOVERY_FIXTURE, JSON.stringify({ synthetic: true, records,
    ownerEmail: owner.user.email, otherEmail: other.user.email, adminEmail: adminUser.email }));
}
void main().finally(() => db.$disconnect()).catch((error: unknown) => {
  // Emit only a bounded machine code and an internal stage, never SQL, rows,
  // connection strings or arbitrary error text from the driver.
  const candidate = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const code = /^(?:P\d{4}|N14_[A-Z_]{1,70}|NOT_AUTHORIZED|INVALID_INPUT|STALE_CONTEXT|SERIALIZABLE_CONFLICT)$/u.test(candidate) ? candidate : 'REDACTED';
  console.error(JSON.stringify({ status: 'R05_HISTORICAL_FIXTURE_FAILED', phase, code })); process.exitCode = 1;
});
