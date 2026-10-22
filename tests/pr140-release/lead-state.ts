import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { grantLead, leadProof } from '../selective-leads/fixtures';
import { readLeadSharing, revokeLeadSharing } from '../../src/lib/selective-lead-access';
import { readLeadEditing } from '../../src/lib/selective-lead-edit-access';
import { previewLeadEditingSelection, confirmLeadEditingSelection, revokeLeadEditing } from '../../src/lib/selective-lead-edit-management';
import { previewLeadEdit, confirmLeadEdit, readLeadEditOutcomeByReference } from '../../src/lib/selective-lead-edit-service';

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
  const editing: Array<{ id: string; commandId?: string; excluded: string[] }> = [];
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
    // Explicit, separate synthetic enrollment: read authority alone is not editing authority.
    assert.deepEqual(await db.$queryRaw`SELECT id FROM "SelectiveLeadEditAuthority"`, []);
    await db.$executeRaw`INSERT INTO "SelectiveLeadEditAuthority" ("userId",enabled) VALUES (${admin.user.id},true)`;
    const policy = await db.commercialLeadSlaPolicyVersion.findFirst({ orderBy: { version: 'asc' } })
      ?? await db.commercialLeadSlaPolicyVersion.create({ data: { version: 1, responseTargetSeconds: 86_400 } });
    for (const suffix of ['EDIT_LIVE', 'EDIT_REVOKED']) {
      const row = await db.lead.create({ data: { firstName: 'Synthetic', lastName: suffix,
        companyName: 'EXCLUDED_EDIT_RECOVERY_' + suffix, assignedToId: reader.user.id,
        email: `${randomUUID()}@invalid.test`, notes: 'PRIVATE_EDIT_RECOVERY_' + suffix,
        interest: 'Interesse conservato', priority: 'media' } });
      const availableAt = new Date(Date.now() - 86_400_000);
      const item = await db.commercialLeadInboxItem.create({ data: { leadId: row.id, originKind: 'MANUAL_CRM',
        sourceSystem: 'CRM_SYNTHETIC', formCode: 'LEAD_EDIT_RECOVERY', formVersion: '1',
        sourceOccurredAt: availableAt, initializedAt: availableAt } });
      await db.commercialLeadSlaCycle.create({ data: { inboxItemId: item.id, policyVersionId: policy.id,
        sequence: 1, availableAt, dueAt: new Date(availableAt.getTime() + 86_400_000) } });
      await grantLead(db, admin, { leadId: row.id, recipientId: reader.user.id, revision: 0,
        commandId: randomUUID(), fields: ['interest', 'priority'], expiresAt: null });
      const read = await db.selectiveLeadGrant.findUniqueOrThrow({ where: {
        leadId_recipientId: { leadId: row.id, recipientId: reader.user.id } } });
      const selection = { protocol: 'SELECTIVE_LEAD_EDIT_SELECTION_V1' as const,
        leadId: row.id, recipientId: reader.user.id, readGrantId: read.id,
        readGrantRevision: read.revision, readGrantProof: read.proof, revision: 0,
        commandId: randomUUID(), fields: ['priority' as const], expiresAt: null };
      const p = await previewLeadEditingSelection(db, admin.session, selection);
      const capability = await confirmLeadEditingSelection(db, admin.session, selection, p.token, leadProof(admin));
      const entry: typeof editing[number] = { id: row.id, excluded: [row.companyName!, row.notes!, row.email!] };
      if (suffix === 'EDIT_REVOKED') {
        await revokeLeadEditing(db, admin.session, { grantId: capability.grantId,
          revision: 1, commandId: randomUUID() }, leadProof(admin));
        await assert.rejects(readLeadEditing(db, reader.session, row.id));
        assert.equal((await readLeadSharing(db, reader.session, row.id)).fields.length, 2);
      } else {
        const view = await readLeadEditing(db, reader.session, row.id);
        const command = { protocol: 'SELECTIVE_LEAD_EDIT_COMMAND_V1' as const,
          commandId: randomUUID(), leadId: row.id, capabilityId: view.capabilityId,
          capabilityRevision: view.capabilityRevision, readGrantId: view.readGrantId,
          readGrantRevision: view.readGrantRevision, readGrantProof: view.readGrantProof,
          expectedVersion: view.expectedVersion, changes: { priority: 'alta' as const } };
        const preview = await previewLeadEdit(db, reader.session, command);
        const receipt = await confirmLeadEdit(db, reader.session, command, preview.token, true);
        assert.deepEqual(await readLeadEditOutcomeByReference(db, reader.session,
          { leadId: row.id, commandId: command.commandId }), receipt);
        entry.commandId = command.commandId;
      }
      editing.push(entry);
    }
  } finally {
    if (previousMode === undefined) delete process.env.PRIVILEGED_ACCESS_MODE;
    else process.env.PRIVILEGED_ACCESS_MODE = previousMode;
  }
  writeFileSync(process.env.R05_LEAD_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true,
    adminId: admin.user.id, readerId: reader.user.id, email: reader.user.email,
    liveId: rows[0].id, liveLabel: rows[0].companyName, privateEmail: rows[0].email,
    revokedId: rows[1].id, otherId: rows[2].id, otherLabel: rows[2].companyName, editing }) + '\n');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
