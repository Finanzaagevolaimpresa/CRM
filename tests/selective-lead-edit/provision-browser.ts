import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from '../selective-sharing/fixtures';
import { grantLead } from '../selective-leads/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.LEAD_EDIT_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.LEAD_EDIT_BROWSER_PASSWORD!, evidence = process.env.LEAD_EDIT_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  assert.equal(await db.selectiveLeadAuthority.count(), 0);
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "SelectiveLeadEditAuthority"`, []);
  const hash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, hash);
  await db.selectiveLeadAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  await db.$executeRaw`INSERT INTO "SelectiveLeadEditAuthority" ("userId",enabled) VALUES (${admin.user.id},true)`;
  const policy = await db.commercialLeadSlaPolicyVersion.findFirst({ orderBy: { version: 'asc' } })
    ?? await db.commercialLeadSlaPolicyVersion.create({ data: { version: 1, responseTargetSeconds: 86_400 } });
  const rows: Array<{ leadId: string; readerId: string; readerEmail: string;
    excluded: string[]; inboxId: string; cycleId: string }> = [];
  for (let i = 0; i < 3; i++) {
    const reader = await syntheticPerson(db, 'Destinatario modifica ' + i, 'admin', hash);
    const lead = await db.lead.create({ data: { firstName: 'Sintetico', lastName: 'Modifica ' + i,
      companyName: 'AZIENDA_ESCLUSA_' + i, notes: 'NOTA_PRIVATA_ESCLUSA_' + i,
      email: randomUUID() + '@invalid.test', assignedToId: reader.user.id, interest: 'Interesse sintetico', priority: 'media' } });
    const availableAt = new Date(Date.now() - 86_400_000);
    const item = await db.commercialLeadInboxItem.create({ data: { leadId: lead.id, originKind: 'MANUAL_CRM',
      sourceSystem: 'CRM_SYNTHETIC', formCode: 'LEAD_EDIT', formVersion: '1', sourceOccurredAt: availableAt, initializedAt: availableAt } });
    const cycle = await db.commercialLeadSlaCycle.create({ data: { inboxItemId: item.id, policyVersionId: policy.id,
      sequence: 1, availableAt, dueAt: new Date(availableAt.getTime() + 86_400_000) } });
    await grantLead(db, admin, { leadId: lead.id, recipientId: reader.user.id, revision: 0, commandId: randomUUID(),
      fields: ['interest', 'priority'], expiresAt: null });
    rows.push({ leadId: lead.id, readerId: reader.user.id, readerEmail: reader.user.email,
      excluded: [lead.companyName!, lead.notes!, lead.email!], inboxId: item.id, cycleId: cycle.id });
  }
  await db.$transaction(async tx => {
    for (const id of [admin.user.id, ...rows.map(row => row.readerId)]) await revokeAllInternalSessions(tx, id, 'INTERNAL_GLOBAL', admin.user.id);
  });
  await assertRegistryActivationReady(db);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.user.id, adminEmail: admin.user.email, rows }));
  console.log('SELECTIVE_LEAD_EDIT_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
