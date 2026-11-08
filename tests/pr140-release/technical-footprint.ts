import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';
import { readPrivateDocumentBounded } from '../../src/lib/storage';
import { technicalDisclosureModel } from '../../src/lib/technical-document-disclosure';

type Fixture = { synthetic: boolean; clientId: string; supportEmail: string; mixedEmail: string };
export async function readTechnicalRecoveryFootprint(db: PrismaClient, fixture: Fixture) {
  assert.equal(process.env.CI, 'true'); await assertSyntheticCatalogDatabase(db);
  assert.equal(fixture.synthetic, true);
  assert(fixture.supportEmail && fixture.mixedEmail && fixture.supportEmail !== fixture.mixedEmail);
  const assignments = await db.$queryRaw<Array<{ id: string; recipientId: string; practiceId: string | null; projectId: string | null; revokedAt: Date | null }>>`SELECT * FROM "TechnicalAssignment" ORDER BY id`;
  const clients = await db.technicalPractice.findMany({ where: { id: { in: assignments.flatMap(row => row.practiceId ? [row.practiceId] : []) } }, select: { clientId: true } });
  const documents = await db.document.findMany({ where: { clientId: { in: clients.map(row => row.clientId) } }, orderBy: { id: 'asc' } });
  const versions = await db.documentVersion.findMany({ where: { documentId: { in: documents.map(row => row.id) } }, orderBy: { id: 'asc' } });
  const files = [];
  for (const doc of documents) {
    const bytes = await readPrivateDocumentBounded(doc.storagePath, 1024 * 1024);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256, doc.checksum); files.push({ id: doc.id, sizeBytes: bytes.length, sha256 });
  }
  const selectUser = { id: true, email: true, recordUpdateEpoch: true, role: true, active: true, deletedAt: true,
    permissionOverrides: { orderBy: { permission: 'asc' as const } } } as const;
  const mixed = await db.user.findUniqueOrThrow({ where: { email: fixture.mixedEmail }, select: selectUser });
  const classifications = await db.adminRecordRevision.findMany({
    where: { model: technicalDisclosureModel, recordId: { in: versions.map(row => row.id) } }, orderBy: { commandId: 'asc' },
  });
  const data = {
    technicalAssignments: assignments, technicalDocuments: documents, technicalFiles: files,
    technicalAuthority: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalAssignmentAuthority" ORDER BY id`,
    technicalDecisions: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalAssignmentDecision" ORDER BY id`,
    technicalRevisions: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalAssignmentRevision" ORDER BY id`,
    technicalWorkCommands: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalWorkCommand" ORDER BY id`,
    technicalItemGenerations: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalWorkItemGeneration" ORDER BY kind,"itemId"`,
    technicalItemCommands: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalWorkItemCommand" ORDER BY id`,
    technicalChecklist: await db.documentChecklistItem.findMany({ orderBy: { id: 'asc' } }),
    technicalAudit: await db.auditLog.findMany({ where: { event: { in: ['technical_assignment_changed', 'technical_work_recorded', 'technical_work_item_recorded'] } }, orderBy: { id: 'asc' } }),
    technicalUsers: await db.user.findMany({ where: { id: { in: assignments.map(row => row.recipientId) } }, orderBy: { id: 'asc' }, select: selectUser }),
    technicalMembershipUsers: [mixed],
    technicalMembershipProjects: await db.project.findMany({ where: { consultantId: mixed.id }, orderBy: { id: 'asc' },
      select: { id: true, clientId: true, consultantId: true } }),
    technicalClassifications: classifications,
    technicalClassificationAudit: await db.auditLog.findMany({ where: { id: { in: classifications.map(row => 'admin-record:' + row.commandId) } }, orderBy: { id: 'asc' } }),
  };
  const shared = JSON.parse(readFileSync(process.env.R05_SHARED_RECOVERY_FIXTURE!, 'utf8')) as {
    synthetic: boolean; practiceId: string; techId: string; secondId: string;
  };
  assert.equal(shared.synthetic, true);
  const sharedAssignments = assignments.filter(row => row.practiceId === shared.practiceId);
  assert.deepEqual(sharedAssignments.map(row => row.recipientId).sort(), [shared.techId, shared.secondId].sort());
  // Original six assignments plus two explicit shared-update assignments.
  // The footprint still includes every row, command and revision unchanged.
  assert.equal(data.technicalAuthority.length, 1); assert.equal(assignments.length, 8);
  assert.equal(assignments.filter(row => row.revokedAt).length, 2);
  assert.equal(data.technicalDecisions.length, 10); assert.equal(data.technicalRevisions.length, 10);
  assert.equal(data.technicalWorkCommands.length, 1); assert.equal(data.technicalAudit.length, 12);
  assert.equal(data.technicalItemCommands.length, 1); assert(data.technicalItemGenerations.length > 0);
  assert.equal(files.length, 7); assert.equal(data.technicalUsers.length, 7);
  assert.equal(data.technicalUsers.find(row => row.email === fixture.supportEmail)?.role, 'backoffice');
  assert.equal(mixed.role, 'amministrazione'); assert(!assignments.some(row => row.recipientId === mixed.id));
  assert.equal(data.technicalMembershipProjects.length, 1);
  assert.equal(data.technicalMembershipProjects[0].clientId, fixture.clientId);
  assert.equal(data.technicalUsers.flatMap(row => row.permissionOverrides).length, 6);
  assert.deepEqual(mixed.permissionOverrides.map(row => [row.permission, row.allowed]),
    [['contract.read', true], ['document.download', true], ['payment.read', true]]);
  // Both technical fixtures classify exactly two versions; their signed third
  // version and the private acquisition remain unclassified.
  assert.equal(classifications.length, 4); assert.equal(data.technicalClassificationAudit.length, 4);
  assert(classifications.every(row => row.operation === 'UPDATE'));
  return data;
}
