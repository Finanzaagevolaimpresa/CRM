import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson, syntheticSession } from '../selective-sharing/fixtures';
import { requestInput, requestDraft } from '../admin-requests/fixtures';
import { submitAdminRequest, readAdminRequest, changeAdminRequest, readAdminRequestDraftPrefill } from '../../src/lib/admin-request-service';
import { saveApprovedMessageDraft } from '../../src/lib/approved-communications';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { randomUUID } from 'node:crypto';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert(process.env.R05_ADMIN_REQUEST_RECOVERY_FIXTURE);
  const owner = await db.user.findUniqueOrThrow({ where: { id: 'release-owner' } });
  const admin = await syntheticSession(db, owner), sales = await syntheticPerson(db, 'Synthetic requester', 'commerciale', owner.passwordHash);
  const other = await syntheticPerson(db, 'Other synthetic requester', 'commerciale', owner.passwordHash);
  const authority = await db.ordinaryEmailAuthority.findUniqueOrThrow({ where: { id: 'ordinary-email' } });
  assert.equal(authority.userId, owner.id); assert.equal(authority.enabled, true);
  const box = await db.communicationMailbox.findUniqueOrThrow({ where: { id: authority.mailboxId } });
  const requests: Record<string, { id: string; leadId: string }> = {};
  for (const status of ['OPEN', 'DRAFT', 'REVOKED_DRAFT', 'REJECTED']) {
    const lead = await db.lead.create({ data: { firstName: 'Synthetic request', lastName: status, assignedToId: sales.user.id } });
    const input = await requestInput(db, sales, { kind: 'Lead', targetId: lead.id });
    const receipt = await submitAdminRequest(db, sales.session, input);
    assert.equal(receipt.requestId, input.commandId);
    const savedRows = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "AdminRequest" WHERE id=${receipt.requestId}::uuid`;
    assert.equal(savedRows.length, 1, `Committed synthetic request missing: ${status}`);
    if (status.includes('DRAFT')) {
      const source = await readAdminRequestDraftPrefill(db, admin.session, receipt.requestId);
      await saveApprovedMessageDraft(db, admin.session, requestDraft(source, box.address));
    }
    if (status === 'REJECTED') {
      const current = await readAdminRequest(db, admin.session, receipt.requestId);
      await changeAdminRequest(db, admin.session, { requestId: receipt.requestId, commandId: randomUUID(),
        expectedRevision: current.revision, expectedSubmissionSha256: current.submissionSha256,
        action: 'REJECT', requesterReply: 'Richiesta rifiutata in prova isolata.' });
    }
    if (status === 'REVOKED_DRAFT') await db.lead.update({ where: { id: lead.id }, data: { assignedToId: other.user.id } });
    requests[status] = { id: receipt.requestId, leadId: lead.id };
  }
  assert.equal(await db.communicationApproval.count({ where: { version: { messageId: { in: Object.values(requests).map(r => r.id) } } } }), 0);
  await writeFile(process.env.R05_ADMIN_REQUEST_RECOVERY_FIXTURE, JSON.stringify({ synthetic: true, requests,
    ownerEmail: owner.email, salesEmail: sales.user.email, otherEmail: other.user.email }));
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
