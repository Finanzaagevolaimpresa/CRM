import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertSyntheticCatalogDatabase, CatalogV2PreparationError, prepareInternalServiceCatalogV2 } from '../../src/lib/service-catalog-v2-persistence';
import { createControlledIntake, ControlledIntakeError } from '../../src/lib/controlled-intake';
import { createPracticeReadiness, PracticeReadinessError } from '../../src/lib/practice-readiness';
import { purchasedFixture } from '../purchased-service-fixture';
import { handoffPurchasedService } from '../../src/lib/purchased-service-handoff';
import { acceptResponsibility } from '../../src/lib/responsibility';
import { recordCommercialOrigin } from '../../src/lib/commercial-origin';
import { readPrivateVideoFile } from '../../src/lib/video-storage';
import { readPrivateDocumentBounded } from '../../src/lib/storage';
import { readTechnicalUploadPrivateFile } from '../../src/lib/technical-upload-storage';

const db = new PrismaClient();
const mode = process.argv[2];
async function main() {
  await assertSyntheticCatalogDatabase(db);
  assert.equal(process.env.CI, 'true');
  if (mode === 'actors') {
    const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD!;
    assert.ok(password.length >= 24);
    const passwordHash = await bcrypt.hash(password, 12);
    for (const [id, role] of [['release-owner', 'admin'], ['release-observer', 'revisore']] as const)
      await db.user.create({ data: { id, email: `${id}@invalid.test`, name: id, role, passwordHash } });
    assert.equal(await db.internalSession.count(), 0);
  } else if (mode === 'm1-history') {
    assert.equal(process.env.INTERNAL_SESSION_MODE, 'registry');
    const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD!;
    assert.ok(password.length >= 24);
    const f = await purchasedFixture(db, await bcrypt.hash(password, 12));
    const origin = await db.$transaction(tx => recordCommercialOrigin(tx, f.admin, { clientId: f.client.id,
      expectedEntryId: '', acquiredById: f.admin.id, contractedById: f.admin.id,
      sourceReference: 'Synthetic recovery fixture', reason: 'Preserve the independently recorded commercial origin' }, true));
    const entry = await db.$transaction(tx => handoffPurchasedService(tx, f.admin, f.input, true), { isolationLevel: 'Serializable' });
    const accepted = await db.$transaction(tx => acceptResponsibility(tx, f.tech, { kind: 'TechnicalPractice',
      id: entry.receipt.technicalPracticeId, decisionId: entry.receipt.decisionId, role: 'tecnico' }), { isolationLevel: 'Serializable' });
    writeFileSync(process.argv[3], JSON.stringify({ synthetic: true, clientId: f.client.id, serviceId: f.service.id,
      practiceId: entry.receipt.technicalPracticeId, handoffId: entry.id, acceptanceId: accepted.id, originId: origin.id,
      tech: { id: f.tech.id, email: f.tech.email }, otherEmail: f.other.email, otherId: f.other.id, adminEmail: f.admin.email,
      materialId: f.documents[2].id, materialHash: f.documents[2].checksum, sensitiveId: f.documents[0].id }) + '\n');
  } else if (mode === 'epochs') {
    // Compare every epoch immediately across each stop/start, before browser
    // probes intentionally revoke and restore unrelated synthetic permissions.
    const select = { id: true, recordUpdateEpoch: true } as const;
    const orderBy = { id: 'asc' } as const;
    const epochs = {
      users: await db.user.findMany({ select: { ...select, selectiveLeadEpoch: true, selectiveClientEpoch: true, selectivePracticeEpoch: true }, orderBy }),
      leads: await db.lead.findMany({ select, orderBy }),
      clients: await db.client.findMany({ select, orderBy }),
      projects: await db.project.findMany({ select, orderBy }),
      services: await db.clientService.findMany({ select, orderBy }),
      practices: await db.technicalPractice.findMany({ select, orderBy }),
      documents: await db.document.findMany({ select: { id: true, selectiveEpoch: true }, orderBy }),
      companies: await db.selectiveCompanyGeneration.findMany({ orderBy: { companyId: 'asc' } }),
      people: await db.$queryRaw<Array<{ personId: string; generation: number }>>`SELECT "personId", generation FROM "SelectivePersonGeneration" ORDER BY "personId"`,
      memberships: await db.$queryRaw<Array<{ membershipId: string; generation: number }>>`SELECT "membershipId", generation FROM "SelectiveMembershipGeneration" ORDER BY "membershipId"`,
    };
    writeFileSync(process.argv[3], JSON.stringify(epochs, null, 2) + '\n');
  } else if (mode === 'footprint') {
    const videoAssets = await db.videoAsset.findMany({ orderBy: { id: 'asc' } });
    const videoFiles = [];
    for (const asset of videoAssets.filter(row => row.state === 'READY')) {
      const bytes = await readPrivateVideoFile(asset.id, asset);
      videoFiles.push({ id: asset.id, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length });
    }
    const updateIdentities = await db.$queryRaw<Array<{ id: string }>>`SELECT "authorId" AS id FROM "RecordUpdateRule"
      UNION SELECT "actorId" FROM "RecordUpdateCommand" UNION SELECT "recipientId" FROM "RecordUpdateDelivery"`;
    const selectedPracticeRows = await db.technicalPractice.findMany({
      where: { selectivePracticeGrants: { some: {} } }, orderBy: { id: 'asc' },
    });
    const selectedClientIds = (await db.selectiveClientGrant.findMany({ select: { clientId: true } })).map(row => row.clientId);
    const selectedClientDocuments = await db.document.findMany({
      where: { clientId: { in: selectedClientIds } }, orderBy: { id: 'asc' },
    });
    const selectedClientVersions = await db.documentVersion.findMany({
      where: { documentId: { in: selectedClientDocuments.map(row => row.id) } }, orderBy: { id: 'asc' },
    });
    const selectedClientFiles = [];
    for (const version of selectedClientVersions) {
      const bytes = await readPrivateDocumentBounded(version.storagePath, 1024 * 1024);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256, version.checksum);
      selectedClientFiles.push({ versionId: version.id, sha256, sizeBytes: bytes.length });
    }
    const selectedPracticeDocuments = await db.document.findMany({
      where: { clientId: { in: selectedPracticeRows.map(row => row.clientId) } }, orderBy: { id: 'asc' },
    });
    const selectedPracticeVersions = await db.documentVersion.findMany({
      where: { documentId: { in: selectedPracticeDocuments.map(row => row.id) } }, orderBy: { id: 'asc' },
    });
    const selectedPracticeFiles = [];
    for (const version of selectedPracticeVersions) {
      const bytes = await readPrivateDocumentBounded(version.storagePath, 1024 * 1024);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256, version.checksum);
      selectedPracticeFiles.push({ versionId: version.id, sha256, sizeBytes: bytes.length });
    }
    const technicalAssignments = await db.$queryRaw<Array<{ id: string; recipientId: string; practiceId: string | null; projectId: string | null; revokedAt: Date | null }>>`SELECT * FROM "TechnicalAssignment" ORDER BY id`;
    const technicalClients = await db.technicalPractice.findMany({ where: { id: { in: technicalAssignments.flatMap(row => row.practiceId ? [row.practiceId] : []) } }, select: { clientId: true } });
    const technicalDocuments = await db.document.findMany({ where: { clientId: { in: technicalClients.map(row => row.clientId) } }, orderBy: { id: 'asc' } });
    const technicalFiles = [];
    for (const doc of technicalDocuments) {
      const bytes = await readPrivateDocumentBounded(doc.storagePath, 1024 * 1024);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256, doc.checksum); technicalFiles.push({ id: doc.id, sizeBytes: bytes.length, sha256 });
    }
    const uploadSubmissions = await db.technicalUploadSubmission.findMany({ orderBy: { id: 'asc' } });
    const uploadReviews = await db.technicalUploadReview.findMany({ orderBy: { commandId: 'asc' } });
    const uploadFiles = [];
    for (const row of uploadSubmissions) {
      const bytes = await readTechnicalUploadPrivateFile({ storageKey: row.storageKey, sizeBytes: row.sizeBytes, sha256: row.contentSha256 });
      uploadFiles.push({ commandId: row.commandId, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const data = {
      uploadSubmissions, uploadReviews, uploadFiles,
      uploadAudit: await db.auditLog.findMany({ where: { entityType: 'TechnicalUploadSubmission' }, orderBy: { id: 'asc' } }),
      adminRequests: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "AdminRequest" ORDER BY id`,
      adminRequestEvents: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "AdminRequestEvent" ORDER BY id`,
      adminRequestDrafts: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "AdminRequestDraft" ORDER BY "requestId"`,
      adminRequestAudit: await db.auditLog.findMany({ where: { event: 'admin_request_changed' }, orderBy: { id: 'asc' } }),
      technicalAssignments, technicalDocuments, technicalFiles,
      technicalAuthority: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalAssignmentAuthority" ORDER BY id`,
      technicalDecisions: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalAssignmentDecision" ORDER BY id`,
      technicalRevisions: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalAssignmentRevision" ORDER BY id`,
      technicalWorkCommands: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalWorkCommand" ORDER BY id`,
      technicalItemGenerations: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalWorkItemGeneration" ORDER BY kind,"itemId"`,
      technicalItemCommands: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "TechnicalWorkItemCommand" ORDER BY id`,
      technicalChecklist: await db.documentChecklistItem.findMany({ orderBy: { id: 'asc' } }),
      technicalAudit: await db.auditLog.findMany({ where: { event: { in: ['technical_assignment_changed','technical_work_recorded','technical_work_item_recorded'] } }, orderBy: { id: 'asc' } }),
      technicalUsers: await db.user.findMany({ where: { id: { in: technicalAssignments.map(row => row.recipientId) } }, orderBy: { id: 'asc' },
        select: { id: true, recordUpdateEpoch: true, role: true, active: true, deletedAt: true } }),
      selectivePracticeAuthority: await db.selectivePracticeAuthority.findMany({ orderBy: { id: 'asc' } }),
      selectivePracticeGrants: await db.selectivePracticeGrant.findMany({ orderBy: { id: 'asc' } }),
      selectivePracticeRevisions: (await db.selectivePracticeRevision.findMany({ orderBy: { id: 'asc' } })).map(row => ({ ...row, transactionId: String(row.transactionId) })),
      selectivePracticeCommands: (await db.selectivePracticeCommand.findMany({ orderBy: { id: 'asc' } })).map(row => ({ ...row, transactionId: String(row.transactionId) })),
      selectivePracticeAudit: await db.auditLog.findMany({ where: { event: 'selective_practice_changed' }, orderBy: { id: 'asc' } }),
      selectivePracticeUsers: await db.user.findMany({ where: { OR: [{ selectivePracticeAuthority: { isNot: null } }, { selectivePracticeGrants: { some: {} } }] },
        orderBy: { id: 'asc' }, select: { id: true, selectivePracticeEpoch: true, recordUpdateEpoch: true, role: true, active: true, deletedAt: true } }),
      selectedPracticeRows, selectedPracticeDocuments, selectedPracticeFiles,
      selectedPracticeClients: await db.client.findMany({ where: { id: { in: selectedPracticeRows.map(row => row.clientId) } }, orderBy: { id: 'asc' } }),
      selectedCompanyGenerations: await db.selectiveCompanyGeneration.findMany({ orderBy: { companyId: 'asc' } }),
      selectedPersonGenerations: await db.$queryRaw<Array<{ personId: string; generation: number }>>`SELECT "personId", generation FROM "SelectivePersonGeneration" ORDER BY "personId"`,
      selectedMembershipGenerations: await db.$queryRaw<Array<{ membershipId: string; generation: number }>>`SELECT "membershipId", generation FROM "SelectiveMembershipGeneration" ORDER BY "membershipId"`,
      selectedPeople: await db.person.findMany({ orderBy: { id: 'asc' } }),
      selectedMemberships: await db.companyPerson.findMany({ orderBy: { id: 'asc' } }),
      selectiveClientAuthority: await db.selectiveClientAuthority.findMany({ orderBy: { id: 'asc' } }),
      selectiveClientGrants: await db.selectiveClientGrant.findMany({ orderBy: { id: 'asc' } }),
      selectiveClientRevisions: (await db.selectiveClientRevision.findMany({ orderBy: { id: 'asc' } })).map(row => ({ ...row, transactionId: String(row.transactionId) })),
      selectiveClientCommands: (await db.selectiveClientCommand.findMany({ orderBy: { id: 'asc' } })).map(row => ({ ...row, transactionId: String(row.transactionId) })),
      selectiveClientAudit: await db.auditLog.findMany({ where: { event: 'selective_client_changed' }, orderBy: { id: 'asc' } }),
      selectiveClientUsers: await db.user.findMany({ where: { OR: [{ selectiveClientAuthority: { isNot: null } }, { selectiveClientGrants: { some: {} } }] },
        orderBy: { id: 'asc' }, select: { id: true, selectiveClientEpoch: true, recordUpdateEpoch: true, role: true, active: true, deletedAt: true } }),
      selectedClientRows: await db.client.findMany({ where: { selectiveGrants: { some: {} } }, orderBy: { id: 'asc' } }),
      selectedClientCompanies: await db.company.findMany({ where: { clientId: { in: selectedClientIds } }, orderBy: { id: 'asc' } }),
      selectedClientDocuments, selectedClientFiles,
      selectiveLeadAuthority: await db.selectiveLeadAuthority.findMany({ orderBy: { id: 'asc' } }),
      selectiveLeadGrants: await db.selectiveLeadGrant.findMany({ orderBy: { id: 'asc' } }),
      selectiveLeadRevisions: (await db.selectiveLeadRevision.findMany({ orderBy: { id: 'asc' } })).map(row => ({ ...row, transactionId: String(row.transactionId) })),
      selectiveLeadCommands: (await db.selectiveLeadCommand.findMany({ orderBy: { id: 'asc' } })).map(row => ({ ...row, transactionId: String(row.transactionId) })),
      selectiveLeadAudit: await db.auditLog.findMany({ where: { event: 'selective_lead_changed' }, orderBy: { id: 'asc' } }),
      selectiveLeadEditAuthority: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "SelectiveLeadEditAuthority" ORDER BY id`,
      selectiveLeadEditGrants: await db.$queryRaw<Array<{ revokedAt: Date | null }>>`SELECT * FROM "SelectiveLeadEditGrant" ORDER BY id`,
      selectiveLeadEditDecisions: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "SelectiveLeadEditDecision" ORDER BY id`,
      selectiveLeadEditRevisions: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "SelectiveLeadEditRevision" ORDER BY id`,
      selectiveLeadEditCommands: await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "SelectiveLeadEditCommand" ORDER BY id`,
      selectiveLeadEditAudit: await db.auditLog.findMany({ where: { event: { in:
        ['selective_lead_edit_capability_changed', 'selective_lead_edit_applied'] } }, orderBy: { id: 'asc' } }),
      selectiveLeadUsers: await db.user.findMany({ where: { OR: [{ selectiveLeadAuthority: { isNot: null } }, { selectiveLeadGrants: { some: {} } }] },
        orderBy: { id: 'asc' }, select: { id: true, selectiveLeadEpoch: true, recordUpdateEpoch: true, role: true, active: true, deletedAt: true } }),
      videoAssets, videoFiles,
      videos: await db.videoEntry.findMany({ orderBy: { id: 'asc' } }),
      videoRevisions: await db.videoRevision.findMany({ orderBy: [{ videoId: 'asc' }, { version: 'asc' }] }),
      videoCommands: (await db.videoCommand.findMany({ orderBy: { id: 'asc' } })).map(row => ({ ...row, transactionId: String(row.transactionId) })),
      videoUsers: await db.user.findMany({ where: { email: { startsWith: 'video-recovery-' } }, orderBy: { id: 'asc' },
        select: { id: true, role: true, active: true, deletedAt: true, recordUpdateEpoch: true } }),
      videoAudit: await db.auditLog.findMany({ where: { event: 'VIDEO_LIBRARY_MUTATION' }, orderBy: { id: 'asc' } }),
      projects: await db.project.findMany({ orderBy: { id: 'asc' } }),
      leads: await db.lead.findMany({ orderBy: { id: 'asc' } }),
      reminders: await db.$queryRaw<Array<{ commandId: string }>>`SELECT * FROM "RecordUpdateReminder" ORDER BY "commandId"`,
      reminderCancellations: await db.$queryRaw<Array<{ commandId: string }>>`SELECT * FROM "RecordUpdateReminderCancellation" ORDER BY "commandId"`,
      reminderAudits: await db.auditLog.findMany({ where: { event: { in: ['record_reminder_scheduled', 'record_reminder_canceled'] } }, orderBy: { id: 'asc' } }),
      updateRules: await db.recordUpdateRule.findMany({ orderBy: { id: 'asc' } }),
      updateCommands: await db.recordUpdateCommand.findMany({ orderBy: { id: 'asc' } }),
      updateEvents: await db.recordUpdateEvent.findMany({ orderBy: { id: 'asc' } }),
      updateDeliveries: await db.recordUpdateDelivery.findMany({ orderBy: { id: 'asc' } }),
      // The selected actors and recipients must also remain unchanged through
      // every browser probe. Other actors' deliberate epoch increments are
      // asserted at each perturbation, never reset to hide a revocation.
      updateUsers: await db.user.findMany({ where: { id: { in: updateIdentities.map(row => row.id) } },
        orderBy: { id: 'asc' }, select: { id: true, recordUpdateEpoch: true } }),
      leadLifecycleReceipts: await db.auditLog.findMany({ where: { event: 'lead_lifecycle_changed' }, orderBy: { id: 'asc' } }),
      leadInboxItems: await db.commercialLeadInboxItem.findMany({ orderBy: { id: 'asc' } }),
      leadSlaCycles: await db.commercialLeadSlaCycle.findMany({ orderBy: { id: 'asc' } }),
      historicalContacts: await db.$queryRaw<Array<{ id: string }>>`SELECT * FROM "CommercialLeadHistoricalContact" ORDER BY id`,
      historicalConversions: await db.$queryRaw<Array<{ id: string }>>`SELECT * FROM "CommercialLeadHistoricalConversion" ORDER BY id`,
      historicalAudits: await db.auditLog.findMany({ where: { event: { in: ['commercial_lead_historical_contact_recorded', 'commercial_lead_historical_conversion_recorded'] } }, orderBy: { id: 'asc' } }),

      projectLifecycleReceipts: await db.auditLog.findMany({ where: { event: 'project_lifecycle_changed' }, orderBy: { id: 'asc' } }),
      selectiveAuthorities: await db.selectiveAccessAuthority.findMany({ orderBy: { id: 'asc' } }),
      selectiveGrants: await db.selectiveProjectGrant.findMany({ orderBy: { id: 'asc' } }),
      selectiveReceipts: await db.auditLog.findMany({ where: { event: { in: ['selective_project_access_confirmed', 'selective_project_access_revoked'] } }, orderBy: { id: 'asc' } }),
      ordinaryAuthority: await db.ordinaryEmailAuthority.findMany({ orderBy: { id: 'asc' } }),
      ordinaryChannel: await db.ordinaryEmailChannel.findMany({ orderBy: { mailboxId: 'asc' } }),
      ordinaryDecision: await db.ordinaryEmailDecision.findMany({ orderBy: { id: 'asc' } }),
      ordinaryAttempt: await db.ordinaryEmailAttempt.findMany({ orderBy: { id: 'asc' } }),
      ordinaryClaim: await db.ordinaryEmailClaim.findMany({ orderBy: { id: 'asc' } }),
      ordinaryOutcome: await db.ordinaryEmailOutcome.findMany({ orderBy: { id: 'asc' } }),
      ordinaryInboundStream: await db.ordinaryEmailInboundStream.findMany({ orderBy: { id: 'asc' } }),
      ordinaryInboundBatch: await db.ordinaryEmailInboundBatch.findMany({ orderBy: { id: 'asc' } }),
      ordinaryInboundItem: await db.ordinaryEmailInboundItem.findMany({ orderBy: { id: 'asc' } }),
      ordinaryInboundConflict: await db.ordinaryEmailInboundConflict.findMany({ orderBy: { id: 'asc' } }),
      ordinaryInboundLink: await db.ordinaryEmailInboundLink.findMany({ orderBy: { itemId: 'asc' } }),
      m4Mailboxes: await db.communicationMailbox.findMany({ orderBy: { id: 'asc' } }),
      internalThreads: await db.internalCommunicationThread.findMany({ orderBy: { id: 'asc' } }),
      internalParticipants: await db.internalCommunicationParticipant.findMany({ orderBy: [{ threadId: 'asc' }, { userId: 'asc' }] }),
      contextFiles: await db.communicationContextFile.findMany({ orderBy: { id: 'asc' } }),
      m4MailboxHistory: await db.communicationMailboxHistory.findMany({ orderBy: { id: 'asc' } }),
      m4Messages: await db.approvedCommunication.findMany({ orderBy: { id: 'asc' } }),
      m4Versions: await db.communicationVersion.findMany({ orderBy: { id: 'asc' } }),
      m4Approvals: await db.communicationApproval.findMany({ orderBy: { id: 'asc' } }),
      m4Attempts: await db.communicationAttempt.findMany({ orderBy: { id: 'asc' } }),
      m4Replies: await db.communicationReply.findMany({ orderBy: { id: 'asc' } }),
      m4Events: await db.communicationEvent.findMany({ orderBy: { id: 'asc' } }),
      clientReadGrants: await db.clientReadGrant.findMany({ orderBy: { id: 'asc' } }),
      m1History: await db.auditLog.findMany({ where: { event: { in: ['purchased_service_handoff', 'responsibility_assigned',
        'responsibility_accepted', 'client_commercial_origin_recorded', 'client_commercial_origin_corrected'] } }, orderBy: { id: 'asc' } }),
      services: await db.clientService.findMany({ orderBy: { id: 'asc' } }),
      technicalPractices: await db.technicalPractice.findMany({ orderBy: { id: 'asc' } }),
      tasks: await db.task.findMany({ orderBy: { id: 'asc' } }),
      privateItemOrigins: await db.technicalPrivateItemOrigin.findMany({ orderBy: { commandId: 'asc' } }),
      privateChecklists: await db.documentChecklistItem.findMany({ where: { technicalPrivate: true }, orderBy: { id: 'asc' } }),
      privateItemAudit: await db.auditLog.findMany({ where: { event: 'technical_item_created_private' }, orderBy: { id: 'asc' } }),
      documentVersions: await db.documentVersion.findMany({ orderBy: { id: 'asc' } }),
      acquiredDocuments: await db.document.findMany({ where: { visibilityLevel: 'technical_admin_private_v1' }, orderBy: { id: 'asc' } }),
      documentAcquisitions: await db.technicalDocumentAcquisition.findMany({ orderBy: { commandId: 'asc' } }),
      acquisitionAudit: await db.auditLog.findMany({ where: { event: 'technical_document_acquired_private' }, orderBy: { id: 'asc' } }),
      dossiers: await db.clientDossier.findMany({ where: { practiceReadinessId: { not: null } }, orderBy: { id: 'asc' } }),
      versions: await db.engagementDossierVersion.findMany({ orderBy: { id: 'asc' } }),
      reviews: await db.engagementDossierReview.findMany({ orderBy: { id: 'asc' } }),
      exports: await db.engagementDossierExport.findMany({ orderBy: { id: 'asc' } }),
      workReceipts: await db.auditLog.findMany({ where: { entityType: 'ClientDossier', event: { in: ['engagement_work_package_export', 'engagement_work_result_import'] } }, orderBy: { id: 'asc' } }),
      authorizations: await db.engagementDossierDeliveryAuthorization.findMany({ orderBy: { id: 'asc' } }),
      receipts: await db.engagementDossierDeliveryReceipt.findMany({ orderBy: { id: 'asc' } }),
      practices: await db.practiceReadiness.findMany({ orderBy: { id: 'asc' } }),
      materials: await db.practiceMaterialEvidence.findMany({ orderBy: { id: 'asc' } }),
      ledger: await db.$queryRaw<Array<{ migration_name: string; checksum: string }>>`SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
    };
    assert.ok(data.dossiers.length >= 3 && data.versions.length >= 3 && data.reviews.length >= 3);
    assert.ok(data.exports.length >= 3 && data.authorizations.length >= 3 && data.receipts.length >= 3);
    assert.equal(data.ledger.length, 71);
    assert.equal(data.reminders.length, 5); assert.equal(data.reminderCancellations.length, 1);
    assert.equal(data.reminderAudits.length, 6);
    assert.equal(data.historicalContacts.length, 2); assert.equal(data.historicalConversions.length, 1);
    assert.equal(data.historicalAudits.length, 3);
    assert.equal(data.leadSlaCycles.filter(row => row.outcome === 'HISTORICAL_CONTACT_BEFORE_CRM' && row.firstResponseAt === null).length, 1);

    assert.equal(data.ledger.at(-1)?.migration_name, '20261028180000_record_deadline_reminders_v1');
    assert.equal(data.privateItemOrigins.length, 2); assert.equal(data.privateItemAudit.length, 2);
    assert.equal(data.tasks.filter(row => row.technicalPrivate).length, 1); assert.equal(data.privateChecklists.length, 1);
    assert.equal(data.uploadSubmissions.length, 4); assert.equal(data.uploadReviews.length, 2);
    assert.equal(data.uploadFiles.length, 4); assert.equal(data.uploadAudit.length, 6);
    assert.equal(data.acquiredDocuments.length, 1); assert.equal(data.documentAcquisitions.length, 1); assert.equal(data.acquisitionAudit.length, 1);
    assert.equal(data.adminRequests.length, 4); assert.equal(data.adminRequestEvents.length, 7);
    assert.equal(data.adminRequestDrafts.length, 2); assert.equal(data.adminRequestAudit.length, 7);
    assert.equal(data.technicalAuthority.length, 1); assert.equal(data.technicalAssignments.length, 5);
    assert.equal(data.technicalAssignments.filter(row => row.revokedAt).length, 2);
    assert.equal(data.technicalDecisions.length, 7); assert.equal(data.technicalRevisions.length, 7);
    assert.equal(data.technicalWorkCommands.length, 1); assert.equal(data.technicalAudit.length, 9);
    assert.equal(data.technicalItemCommands.length, 1); assert(data.technicalItemGenerations.length > 0);
    assert.equal(data.technicalFiles.length, 7); assert.equal(data.technicalUsers.length, 4);
    assert.equal(data.selectivePracticeAuthority.length, 1); assert.equal(data.selectivePracticeGrants.length, 3);
    assert.equal(data.selectivePracticeGrants.filter(row => row.revokedAt).length, 1);
    assert.equal(data.selectivePracticeRevisions.length, 4); assert.equal(data.selectivePracticeCommands.length, 4);
    assert.equal(data.selectivePracticeAudit.length, 4); assert.equal(data.selectivePracticeUsers.length, 2);
    assert.equal(data.selectedPracticeRows.length, 3); assert.equal(data.selectedPracticeClients.length, 1);
    assert.equal(data.selectiveClientAuthority.length, 1); assert.equal(data.selectiveClientGrants.length, 9);
    assert.equal(data.selectiveClientGrants.filter(row => row.revokedAt).length, 3);
    assert.equal(data.selectiveClientRevisions.length, 12); assert.equal(data.selectiveClientCommands.length, 12);
    assert.equal(data.selectiveClientAudit.length, 12); assert.equal(data.selectiveClientUsers.length, 2);
    assert.equal(data.selectedClientRows.length, 9);
    assert.equal(data.selectedClientCompanies.length, 9);
    assert.equal(data.selectedClientDocuments.length, 4); assert.equal(data.selectedClientFiles.length, 4);
    assert.equal(data.selectiveLeadAuthority.length, 1); assert.equal(data.selectiveLeadGrants.length, 4);
    assert.equal(data.selectiveLeadGrants.filter(row => row.revokedAt).length, 1);
    assert.equal(data.selectiveLeadRevisions.length, 5); assert.equal(data.selectiveLeadCommands.length, 5);
    assert.equal(data.selectiveLeadAudit.length, 5); assert.equal(data.selectiveLeadUsers.length, 2);
    assert.equal(data.selectiveLeadEditAuthority.length, 1); assert.equal(data.selectiveLeadEditGrants.length, 2);
    assert.equal(data.selectiveLeadEditGrants.filter(row => row.revokedAt).length, 1);
    assert.equal(data.selectiveLeadEditDecisions.length, 3); assert.equal(data.selectiveLeadEditRevisions.length, 3);
    assert.equal(data.selectiveLeadEditCommands.length, 1); assert.equal(data.selectiveLeadEditAudit.length, 4);
    assert.equal(data.videoAssets.length, 5); assert.equal(data.videoAssets.filter(row => row.state === 'RESERVED').length, 1);
    assert.equal(data.videoFiles.length, 4); assert.equal(data.videos.length, 4);
    assert.equal(data.videoRevisions.length, 11); assert.equal(data.videoCommands.length, 11); assert.equal(data.videoAudit.length, 11);
    assert.deepEqual(data.videos.map(row => row.state).sort(), ['ARCHIVED', 'DRAFT', 'PUBLISHED', 'PUBLISHED']);
    assert.equal(data.videoUsers.length, 3);
    assert.equal(data.updateRules.length, 5);
    assert.equal(data.updateRules.filter(row => !row.active).length, 2);
    assert.equal(data.updateCommands.length, 14);
    assert.equal(data.updateEvents.length, 11);
    assert.equal(data.updateDeliveries.length, 11);
    assert.equal(data.updateDeliveries.filter(row => row.mode === 'EMAIL_DRAFT').length, 3);
    assert.equal(data.m4Messages.filter(row => row.updateDeliveryId).length, 2);
    assert.equal(data.m4Versions.filter(row => row.updateSourceHash).length, 2);
    assert.equal(data.updateDeliveries.filter(row => row.readAt).length, 2);
    assert.equal(data.internalThreads.length, 2);
    assert.equal(data.internalParticipants.length, 6);
    assert.equal(data.internalParticipants.filter(row=>!row.active).length, 2);
    assert.equal(data.contextFiles.length, 2);
    assert.equal(data.contextFiles.filter(row=>row.revokedAt).length, 1);
    assert.equal(data.ordinaryAuthority.length, 1);
    assert.equal(data.ordinaryAuthority[0].enabled, true);
    assert.equal(data.ordinaryChannel[0].enabled, false);
    assert.deepEqual(data.ordinaryAttempt.map(row=>row.state).sort(), ['ACCEPTED','CLAIMED','RESERVED','UNCERTAIN']);
    assert.equal(data.ordinaryDecision.length, 4);
    assert.equal(data.ordinaryClaim.length, 3);
    assert.equal(data.ordinaryOutcome.length, 2);
    assert.equal(data.ordinaryInboundStream.length, 1);
    assert.equal(data.ordinaryInboundStream[0].cursor, '103');
    assert.equal(data.ordinaryInboundStream[0].cursorVersion, 2);
    assert.equal(data.ordinaryInboundStream[0].enabled, false);
    assert.equal(data.ordinaryInboundBatch.length, 2);
    assert.equal(data.ordinaryInboundItem.length, 1);
    assert.equal(data.ordinaryInboundConflict.length, 1);
    assert.equal(data.ordinaryInboundLink.length, 1);
    assert.equal(data.selectiveAuthorities.length, 1);
    assert.equal(data.selectiveGrants.length, 3);
    assert.equal(data.projectLifecycleReceipts.length, 6);
    assert.equal(data.leadLifecycleReceipts.length, 3);
    assert.equal(data.leads.filter(lead => lead.deletedAt).length, 1);
    assert.equal(data.projects.filter(project => project.status === 'archiviato' && !project.deletedAt).length, 1);
    assert.equal(data.projects.filter(project => project.deletedAt).length, 1);
    assert.equal(data.m4Mailboxes.length, 7);
    assert.ok(data.m4Messages.length >= 1 && data.m4Versions.length >= 1 && data.m4Approvals.length >= 1 && data.m4Attempts.length >= 1 && data.m4Replies.length >= 1 && data.m4Events.length >= 1);
    assert.ok(data.clientReadGrants.length >= 3);
    assert.ok(data.m1History.some(row => row.event === 'purchased_service_handoff'));
    assert.ok(data.m1History.some(row => row.event === 'responsibility_accepted'));
    const minimized = Object.fromEntries(Object.entries(data).map(([key, rows]) => [key, {
      count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex'),
    }]));
    writeFileSync(process.argv[3], JSON.stringify(minimized, null, 2) + '\n');
  } else if (mode === 'revoke-sessions') {
    // An explicitly authorized operation only in this sentinel-bound CI database.
    // Production must separately authorize revocation; rows and references remain.
    const before = await db.internalSession.count();
    const live = await db.internalSession.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } });
    assert.ok(live > 0);
    const result = await db.internalSession.updateMany({ where: { revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date(), revokedReason: 'INTERNAL_GLOBAL', revokedByUserId: 'release-owner' } });
    assert.equal(await db.internalSession.count(), before);
    process.stdout.write(JSON.stringify({ synthetic: true, liveBefore: live, revoked: result.count, rowsPreserved: before }) + '\n');
  } else if (mode === 'admission') {
    const envKeys = ['INTERNAL_ENGAGEMENT_MODE', 'INTERNAL_SESSION_MODE', 'PRACTICE_READINESS_MODE', 'CONTROLLED_INTAKE_MODE'] as const;
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const sessionId = randomUUID();
    await db.internalSession.create({ data: { id: sessionId, userId: 'release-owner', tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 600_000) } });
    const actor = { userId: 'release-owner', sessionId, expiresAt: Math.floor(Date.now() / 1000) + 600, role: 'admin' as const, active: true, permissionOverrides: [] };
    const before = await db.serviceCatalogRevision.count();
    const denied = (e: unknown) => e instanceof CatalogV2PreparationError && e.message === 'INTERNAL_CATALOG_PREPARATION_DENIED';
    try {
      process.env.PRACTICE_READINESS_MODE = 'internal';
      process.env.CONTROLLED_INTAKE_MODE = 'internal';
      process.env.INTERNAL_SESSION_MODE = 'registry';
      delete process.env.INTERNAL_ENGAGEMENT_MODE;
      await assert.rejects(createPracticeReadiness(db, actor, {}), (e: unknown) => e instanceof PracticeReadinessError && e.code === 'DISABLED');
      await assert.rejects(createControlledIntake(db, actor, {}), (e: unknown) => e instanceof ControlledIntakeError && e.code === 'DISABLED');
      await assert.rejects(prepareInternalServiceCatalogV2(db, actor), denied);
      process.env.INTERNAL_ENGAGEMENT_MODE = 'controlled';
      process.env.INTERNAL_SESSION_MODE = 'legacy';
      await assert.rejects(createPracticeReadiness(db, actor, {}), (e: unknown) => e instanceof PracticeReadinessError && e.code === 'DISABLED');
      await assert.rejects(createControlledIntake(db, actor, {}), (e: unknown) => e instanceof ControlledIntakeError && e.code === 'DISABLED');
      process.env.INTERNAL_SESSION_MODE = 'registry';
      assert.equal((await prepareInternalServiceCatalogV2(db, actor)).created, 0);
      assert.equal(await db.serviceCatalogRevision.count(), before);
      await db.user.update({ where: { id: actor.userId }, data: { role: 'revisore' } });
      await assert.rejects(prepareInternalServiceCatalogV2(db, actor), denied);
      // Admin has unconditional application permissions by policy. Test an
      // override on direzione while the claimed snapshot still says admin.
      await db.user.update({ where: { id: actor.userId }, data: { role: 'direzione' } });
      assert.equal((await prepareInternalServiceCatalogV2(db, actor)).created, 0);
      const override = await db.userPermissionOverride.create({ data: { userId: actor.userId, permission: 'service.write', allowed: false } });
      await assert.rejects(prepareInternalServiceCatalogV2(db, actor), denied);
      await db.userPermissionOverride.delete({ where: { id: override.id } });
      await db.internalSession.update({ where: { id: sessionId }, data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE', revokedByUserId: 'release-owner' } });
      await assert.rejects(prepareInternalServiceCatalogV2(db, actor), denied);
      assert.equal(await db.serviceCatalogRevision.count(), before);
      process.stdout.write(JSON.stringify({ synthetic: true, defaultOff: true, legacyDenied: true, canonicalRole: true, permissionRevocation: true, sessionRevocation: true, catalogIdempotent: true }) + '\n');
    } finally {
      await db.user.update({ where: { id: actor.userId }, data: { role: 'admin' } });
      for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    }
  } else throw new Error('Unknown guarded fixture phase');
}
void main().finally(() => db.$disconnect());
