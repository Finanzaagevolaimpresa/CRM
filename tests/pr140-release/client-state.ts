import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { grantClient, clientProof } from '../selective-clients/fixtures';
import { readClientSharing, revokeClientSharing } from '../../src/lib/selective-client-access';
import { savePrivateDocumentFile } from '../../src/lib/storage';

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
  const rows: { id: string; label: string; companyId: string; projectId: string; leadId: string;
    person?: { id: string; membershipId: string; email: string };
    documents: { id: string; versionId: string; content: string; selected: boolean }[] }[] = [];
  for (const suffix of ['LIVE', 'REVOKED', 'LEGACY', 'OTHER', 'COMPANY_LIVE', 'COMPANY_REVOKED', 'COMPANY_STALE', 'PERSON_LIVE', 'PERSON_REVOKED', 'PERSON_STALE']) {
    const client = await db.client.create({ data: { type: 'societa', displayName: 'SELECTIVE_CLIENT_RECOVERY_' + suffix,
      salesOwnerId: reader.user.id, notes: 'CLIENT_RECOVERY_PRIVATE_' + suffix } });
    const company = await db.company.create({ data: { clientId: client.id, name: 'CLIENT_RECOVERY_COMPANY_' + suffix, vatNumber: 'SYNTHETIC_COMPANY_RECOVERY_VAT_' + suffix } });
    const project = await db.project.create({ data: { clientId: client.id, companyId: company.id,
      title: 'CLIENT_RECOVERY_PROJECT_' + suffix } });
    const lead = await db.lead.create({ data: { clientId: client.id, assignedToId: reader.user.id,
      firstName: 'Synthetic', lastName: suffix, companyName: 'CLIENT_RECOVERY_LEAD_' + suffix } });
    const documents = [];
    if (suffix === 'LIVE' || suffix === 'REVOKED') for (const selected of [true, false]) {
      const content = `SYNTHETIC_CLIENT_RECOVERY_BYTES_${suffix}_${selected}`, fileName = `${suffix}-${selected}.txt`;
      const stored = await savePrivateDocumentFile({ file: new File([content], fileName, { type: 'text/plain' }), fileName, clientId: client.id });
      const document = await db.document.create({ data: { ...stored, clientId: client.id, title: fileName,
        uploadedById: admin.user.id, type: 'altro', documentCategory: 'altro', fileName, mimeType: 'text/plain', status: 'verificato' } });
      const version = await db.documentVersion.create({ data: { documentId: document.id, version: 1,
        storagePath: stored.storagePath, checksum: stored.checksum } });
      documents.push({ id: document.id, versionId: version.id, content, selected });
    }
    let person;
    if (suffix.startsWith('PERSON_')) {
      const p = await db.person.create({ data: { firstName: 'RECOVERY_PRIVATE_NAME', lastName: suffix, email: `${suffix.toLowerCase()}@example.invalid`, notes: 'RECOVERY_PRIVATE_PERSON_NOTE' } });
      const m = await db.companyPerson.create({ data: { companyId: company.id, personId: p.id, role: 'Referente' } });
      person = { id: p.id, membershipId: m.id, email: p.email! };
    }
    rows.push({ id: client.id, label: client.displayName, companyId: company.id, projectId: project.id, leadId: lead.id, documents, person });
    if (suffix === 'OTHER') continue;
    const { receipt } = await grantClient(db, admin, { clientId: client.id, recipientId: reader.user.id,
      revision: 0, commandId: randomUUID(), fields: suffix.startsWith('COMPANY_') || person ? [] : ['displayName', 'status'], expiresAt: null,
      ...(suffix.startsWith('COMPANY_') ? { version: 3, documents: [], companies: [{ companyId: company.id, fields: ['vatNumber'] }] } : {}),
      ...(person ? { version: 4, documents: [], companies: [], people: [{ membershipId: person.membershipId, companyId: company.id, personId: person.id, fields: ['email'] }] } : {}),
      ...(documents.length ? { version: 2, documents: [{ versionId: documents[0].versionId, download: false }] } : {}) });
    if (suffix === 'REVOKED' || suffix === 'COMPANY_REVOKED' || suffix === 'PERSON_REVOKED') await revokeClientSharing(db, admin.session,
      { grantId: receipt.grantId, revision: 1, commandId: randomUUID() }, clientProof(admin));
    if (suffix === 'COMPANY_STALE') {
      await db.company.update({ where: { id: company.id }, data: { vatNumber: 'SYNTHETIC_TEMPORARY_CHANGE' } });
      await db.company.update({ where: { id: company.id }, data: { vatNumber: company.vatNumber, updatedAt: company.updatedAt } });
    }
    if (suffix === 'PERSON_STALE' && person) {
      await db.companyPerson.update({ where: { id: person.membershipId }, data: { role: 'Changed' } });
      await db.companyPerson.update({ where: { id: person.membershipId }, data: { role: 'Referente' } });
    }
  }
  assert.equal((await readClientSharing(db, reader.session, rows[0].id)).fields.length, 2);
  assert.equal((await readClientSharing(db, reader.session, rows[0].id)).documents.length, 1);
  assert.equal((await readClientSharing(db, reader.session, rows[2].id)).fields.length, 2);
  assert.equal((await readClientSharing(db, reader.session, rows[2].id)).documents.length, 0);
  await assert.rejects(readClientSharing(db, reader.session, rows[1].id));
  assert.equal((await readClientSharing(db, reader.session, rows[4].id)).companies[0].fields[0].value, 'SYNTHETIC_COMPANY_RECOVERY_VAT_COMPANY_LIVE');
  for (const index of [5, 6, 8, 9]) await assert.rejects(readClientSharing(db, reader.session, rows[index].id));
  assert.equal((await readClientSharing(db, reader.session, rows[7].id)).people[0].fields[0].value, rows[7].person!.email);
  writeFileSync(process.env.R05_CLIENT_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true,
    adminId: admin.user.id, readerId: reader.user.id, email: reader.user.email, rows }) + '\n');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
