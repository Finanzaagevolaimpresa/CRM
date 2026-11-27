import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDbTestConfiguration, assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { clientProof } from '../selective-clients/fixtures';
import { collectionKey } from '../payment-collection/fixture';
import { syntheticIntakeFixture } from '../workflow/fixture';
import { assignCommercialLeadInboxItem, proposeCommercialLeadAssignee } from '../../src/lib/commercial-lead-inbox';
import { leadWorkWhere } from '../../src/lib/lead-work-queues';
import { getInternalNotificationCount, getInternalNotifications, markInternalNotificationRead } from '../../src/lib/internal-notifications';
import { saveWorkflowRule, saveWorkflowTemplate } from '../../src/lib/workflow-automations';
import { enrollSyntheticWorkflowReceipt, readLeadWorkflowExecutions, runSyntheticWorkflowEnrollment } from '../../src/lib/workflow-executions';
import { saveCalendarAvailability, saveLeadAppointment } from '../../src/lib/personal-calendar';
import { defaultCalendarAvailability } from '../../src/lib/personal-calendar-contract';
import { confirmOperationalDocument, createOperationalDocument, createOperationalProforma, prepareOperationalDocument,
  readOperationalDocument, saveOperationalTemplate } from '../../src/lib/operational-documents';
import { documentFields, type DocumentField } from '../../src/lib/operational-document-contract';
import { renderOperationalPdf } from '../../src/lib/operational-document-pdf';

const enabled = assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient();
after(() => db.$disconnect());

test('one synthetic request follows the persisted setter → consultant → document → proforma path', { skip: !enabled }, async testContext => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); await collectionKey(db);
  assert.equal(process.env.APP_ENV, 'test'); assert.equal(process.env.COMMERCIAL_LEAD_INBOX_MODE, 'enforced');
  const admin = await syntheticPerson(db, 'Admin flusso sintetico', 'admin');
  const michela = await syntheticPerson(db, 'Michela setter sintetica', 'commerciale');
  const ivo = await syntheticPerson(db, 'Ivo consulente commerciale sintetico', 'commerciale');
  const other = await syntheticPerson(db, 'Altro referente sintetico', 'commerciale');
  const intakeFixture = await syntheticIntakeFixture(db, admin.user.id), intake = await intakeFixture.receive();
  testContext.diagnostic(`Identity: ${intake.projectionMode}; gateway receipt: ${intake.gatewayReceiptMode}. Windows alone uses the explicitly labelled POSIX fallback.`);
  assert.equal(intake.projection.state, 'PROJECTED_NEW'); assert(intake.projection.leadId);
  const leadId = intake.projection.leadId;
  const manager = { userId: admin.user.id, sessionId: admin.session.sessionId!, requireManualAdmin: true as const };
  const setterActor = { userId: michela.user.id, sessionId: michela.session.sessionId! };
  let item = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId } });
  assert.equal(item.state, 'OPEN'); assert.equal(item.sourceSystem, 'WORDPRESS');
  await assignCommercialLeadInboxItem(db, { leadId, actor: manager, targetUserId: michela.user.id, expectedInboxVersion: item.version });
  assert.equal(await db.lead.count({ where: { id: leadId, AND: [leadWorkWhere(michela.session, 'workday', new Date())] } }), 1);
  assert.equal(await db.lead.count({ where: { id: leadId, AND: [leadWorkWhere(other.session, 'workday', new Date())] } }), 0);
  assert.equal(await db.leadProjectionLedger.count({ where: { inboxEventId: intake.receipt.inboxEventId, leadId } }), 1);

  const notices = await getInternalNotifications(michela.session), notice = notices.find(row => row.href === '/leads/' + leadId);
  assert(notice); assert.equal(notices.length, await getInternalNotificationCount(michela.session));
  assert.equal(await markInternalNotificationRead(other.session, notice.id), null);
  await markInternalNotificationRead(michela.session, notice.id);
  assert.equal(await getInternalNotificationCount(michela.session), notices.length - 1);
  await markInternalNotificationRead(michela.session, notice.id);
  assert.equal(await getInternalNotificationCount(michela.session), notices.length - 1);
  assert((await getInternalNotifications(michela.session, { state: 'read' })).some(row => row.id === notice.id));
  assert.equal(await db.lead.count({ where: { id: leadId, AND: [leadWorkWhere(michela.session, 'workday', new Date())] } }), 1);

  const confirmation = { id: randomUUID(), familyId: randomUUID(), expectedVersion: 0, name: 'Conferma di sola prova', purpose: 'CONFIRMATION',
    subject: 'Ricevuta {{companyName}}', body: 'Richiesta ricevuta da {{firstName}}. Messaggio sintetico.', state: 'PUBLISHED', authorizationReference: 'SYNTHETIC_TEST_ONLY' };
  const followup = { ...confirmation, id: randomUUID(), familyId: randomUUID(), name: 'Sollecito di sola prova', purpose: 'FOLLOW_UP' };
  await saveWorkflowTemplate(db, admin.session, confirmation, clientProof(admin));
  await saveWorkflowTemplate(db, admin.session, followup, clientProof(admin));
  const workflow = { id: randomUUID(), expectedVersion: 0, name: 'Flusso operativo sintetico', event: 'LEAD_ACCEPTED', state: 'TEST_READY', delayMinutes: 60,
    configuration: { kind: 'INDIVIDUAL', action: 'EMAIL', confirmationTemplateId: confirmation.id, followupTemplateId: followup.id,
      requireAssociated: true, stopOnReply: true, stopOnAppointment: true, newsletterAt: null, recipientIds: [] } };
  await saveWorkflowRule(db, admin.session, workflow, clientProof(admin));
  const enrollment = await enrollSyntheticWorkflowReceipt(db, admin.session, { automationId: workflow.id, receiptId: intake.receipt.id });
  assert.equal((await enrollSyntheticWorkflowReceipt(db, admin.session, { automationId: workflow.id, receiptId: intake.receipt.id })).id, enrollment.id);
  const confirmationJob = await db.workflowExecution.findUniqueOrThrow({ where: { enrollmentId_step: { enrollmentId: enrollment.id, step: 'CONFIRMATION' } } });
  await runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: enrollment.id, now: confirmationJob.dueAt.toISOString() });
  assert.equal((await runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: enrollment.id, now: confirmationJob.dueAt.toISOString() })).executed, 0);
  const confirmedSend = await db.workflowExecution.findUniqueOrThrow({ where: { id: confirmationJob.id } });
  assert.equal(confirmedSend.state, 'SENT'); assert.equal(confirmedSend.attemptCount, 1); assert(confirmedSend.receipt);

  const calendarId = await saveCalendarAvailability(db, ivo.session, defaultCalendarAvailability);
  const day = new Date(Date.now() + 7 * 86400_000);
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  const startLocal = day.toISOString().slice(0, 10) + 'T10:00';
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const booking = { id: randomUUID(), leadId, calendarId, expectedVersion: 0, leadVersion: lead.updatedAt.toISOString(),
    operation: 'BOOK', startLocal, durationMinutes: 30 };
  await assert.rejects(saveLeadAppointment(db, other.session, booking));
  const appointment = await saveLeadAppointment(db, michela.session, booking);
  assert.equal((await saveLeadAppointment(db, michela.session, booking)).id, appointment.id);
  assert.equal(await db.leadAppointment.count({ where: { leadId } }), 1);
  // A separate manual fixture exists only to exercise busy-slot rejection; it
  // is not a second lead projected from the acquisition request above.
  const busyControl = await db.lead.create({ data: { firstName: 'Controllo slot', lastName: 'Sintetico', assignedToId: michela.user.id } });
  await assert.rejects(saveLeadAppointment(db, michela.session, { ...booking, id: randomUUID(), leadId: busyControl.id,
    leadVersion: busyControl.updatedAt.toISOString() }), { message: 'BUSY' });
  const followupJob = await db.workflowExecution.findUniqueOrThrow({ where: { enrollmentId_step: { enrollmentId: enrollment.id, step: 'FOLLOW_UP' } } });
  assert.equal(followupJob.state, 'STOPPED'); assert.equal(followupJob.stopReason, 'APPOINTMENT_BOOKED');
  assert.equal((await runSyntheticWorkflowEnrollment(db, admin.session, { enrollmentId: enrollment.id, now: followupJob.dueAt.toISOString() })).executed, 0);
  assert.deepEqual((await db.workflowExecution.findUniqueOrThrow({ where: { id: confirmedSend.id } })).receipt, confirmedSend.receipt);

  item = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId } });
  const proposalInput = { id: randomUUID(), leadId, targetUserId: ivo.user.id, expectedInboxVersion: item.version, reason: 'Qualificato dalla setter, competenza commerciale sintetica' };
  const proposal = await proposeCommercialLeadAssignee(db, setterActor, proposalInput);
  assert.equal((await proposeCommercialLeadAssignee(db, setterActor, proposalInput)).id, proposal.id);
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).assignedToId, michela.user.id);
  const finalAssignment = { leadId, actor: manager, targetUserId: ivo.user.id, expectedInboxVersion: item.version, proposalId: proposal.id };
  await assert.rejects(assignCommercialLeadInboxItem(db, { ...finalAssignment, actor: setterActor }));
  await assignCommercialLeadInboxItem(db, finalAssignment);
  assert.equal((await db.leadAssignmentProposal.findUniqueOrThrow({ where: { id: proposal.id } })).state, 'CONFIRMED');
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).assignedToId, ivo.user.id);
  assert.equal(await db.lead.count({ where: { id: leadId, AND: [leadWorkWhere(ivo.session, 'videos', new Date())] } }), 1);
  assert.equal((await readLeadWorkflowExecutions(db, ivo.session, leadId)).length, 1);
  await assert.rejects(readLeadWorkflowExecutions(db, michela.session, leadId));
  await assert.rejects(assignCommercialLeadInboxItem(db, finalAssignment));
  assert.equal(await db.leadAssignmentProposal.count({ where: { leadId, state: 'CONFIRMED' } }), 1);

  const service = await db.serviceCatalogRevision.findFirstOrThrow({ where: { status: 'PUBLISHED', priceMode: 'FIXED', serviceCatalog: { active: true } } });
  const template = { commandId: randomUUID(), templateId: randomUUID(), expectedVersion: 0, operation: 'SAVE' as const,
    title: 'Contratto sintetico da modello', kind: 'CONTRACT' as const,
    body: 'Cliente: {{denominazione}}\nSede: {{indirizzo}}\nP.IVA: {{partita_iva}}\nFirmatario: {{firmatario}}\nServizio: {{servizio}}\nImponibile: {{imponibile}}\nIVA: {{iva}}\nTotale: {{totale}}\nRate: {{rate}}',
    required: ['denominazione', 'indirizzo', 'firmatario'] as DocumentField[], approved: false };
  await saveOperationalTemplate(db, admin.session, template, clientProof(admin));
  const publication = { ...template, commandId: randomUUID(), expectedVersion: 1, operation: 'PUBLISH' as const, approved: true };
  await saveOperationalTemplate(db, admin.session, publication, clientProof(admin));
  const proformaTemplate = { ...template, commandId: randomUUID(), templateId: randomUUID(), title: 'Proforma sintetica', kind: 'PROFORMA' as const,
    body: 'Emittente: FAI prova sintetica, Via Esempio 1, P.IVA solo prova.\n' + template.body + '\nScadenza: {{scadenza}}' };
  await saveOperationalTemplate(db, admin.session, proformaTemplate, clientProof(admin));
  const proformaPublication = { ...proformaTemplate, commandId: randomUUID(), expectedVersion: 1, operation: 'PUBLISH' as const, approved: true };
  await saveOperationalTemplate(db, admin.session, proformaPublication, clientProof(admin));
  const selection = { context: { leadId }, templateCommandId: publication.commandId, serviceRevisionId: service.id };
  const incomplete = await prepareOperationalDocument(db, ivo.session, selection);
  assert.equal(incomplete.candidates.indirizzo.length, 0); assert.equal(incomplete.candidates.firmatario.length, 0);
  const choicesFor = (prepared: Awaited<ReturnType<typeof prepareOperationalDocument>>) => Object.fromEntries(documentFields.map(field =>
    [field, field === 'rate' ? 'Saldo unico alla scadenza concordata' : prepared.candidates[field][0]?.value ?? ''])) as Record<DocumentField, string>;
  const incompleteDraft = await createOperationalDocument(db, ivo.session, { commandId: randomUUID(), ...selection,
    sourceHash: incomplete.sourceHash, choices: choicesFor(incomplete), termsConfirmed: true });
  const incompleteRow = await readOperationalDocument(db, ivo.session, incompleteDraft.id);
  await assert.rejects(confirmOperationalDocument(db, ivo.session, { commandId: randomUUID(), documentId: incompleteDraft.id,
    contentHash: incompleteRow.row.contentHash, confirmed: true }));

  // Existing anagraphics are synthetic fixture data, not an external VAT lookup.
  const companyName = intake.event.payload.companyName!;
  const client = await db.client.create({ data: { type: 'societa', displayName: companyName, salesOwnerId: ivo.user.id } });
  const company = await db.company.create({ data: { clientId: client.id, name: companyName, vatNumber: '12345678903', taxCode: '12345678903', legalAddress: 'Via Sintetica 1, 00100 Roma' } });
  const signer = await db.person.create({ data: { firstName: 'Firmatario', lastName: 'Sintetico' } });
  await db.companyPerson.create({ data: { companyId: company.id, personId: signer.id, role: 'Amministratore', isAdministrator: true } });
  await db.lead.update({ where: { id: leadId }, data: { clientId: client.id } });
  const prepared = await prepareOperationalDocument(db, ivo.session, selection), choices = choicesFor(prepared);
  assert.equal(choices.denominazione, companyName); assert.equal(choices.partita_iva, '12345678903'); assert.equal(choices.firmatario, 'Firmatario Sintetico');
  assert(prepared.candidates.imponibile.some(row => row.source.includes('Catalogo approvato')));
  const draftInput = { commandId: randomUUID(), ...selection, sourceHash: prepared.sourceHash, choices, termsConfirmed: true };
  const draft = await createOperationalDocument(db, ivo.session, draftInput);
  assert.equal((await createOperationalDocument(db, ivo.session, draftInput)).id, draft.id);
  await assert.rejects(readOperationalDocument(db, other.session, draft.id));
  await assert.rejects(readOperationalDocument(db, michela.session, draft.id));
  const source = await readOperationalDocument(db, ivo.session, draft.id);
  await confirmOperationalDocument(db, ivo.session, { commandId: randomUUID(), documentId: draft.id, contentHash: source.row.contentHash, confirmed: true });
  const dueDate = new Date(day.getTime() + 30 * 86400_000).toISOString().slice(0, 10);
  const proformaInput = { commandId: randomUUID(), documentId: draft.id, contentHash: source.row.contentHash,
    templateCommandId: proformaPublication.commandId, confirmed: true, dueDate };
  const proforma = await createOperationalProforma(db, ivo.session, proformaInput);
  assert.equal((await createOperationalProforma(db, ivo.session, { ...proformaInput, commandId: randomUUID() })).id, proforma.id);
  assert.equal(await db.operationalDocument.count({ where: { sourceDocumentId: draft.id, dueDate } }), 1);
  const printable = await readOperationalDocument(db, ivo.session, proforma.id);
  assert.equal(printable.snapshot.fields.totale, source.snapshot.fields.totale);
  assert.equal(printable.snapshot.fiscalStatus, 'NOT_ISSUED'); assert.equal(printable.snapshot.deliveryStatus, 'NOT_SENT');
  const pdf = renderOperationalPdf({ title: 'Proforma', content: printable.row.content, reference: proforma.id, status: 'Documento non fiscale · prova sintetica' });
  assert(pdf.toString('ascii').startsWith('%PDF-1.4')); assert(pdf.length > 1000);
  const evidenceDir = resolve(process.env.OPERATIONAL_FLOW_EVIDENCE_DIR ?? 'generated/operational-flow');
  mkdirSync(evidenceDir, { recursive: true });
  const pdfPath = join(evidenceDir, 'proforma-sintetica.pdf'); writeFileSync(pdfPath, pdf);
  const evidence = { mandate: 'FAI-CRM-FLUSSO-OPERATIVO-20261126-R01', synthetic: true,
    projectionMode: intake.projectionMode, gatewayReceiptMode: intake.gatewayReceiptMode, providerCalls: 0, liveMessagesSent: 0,
    requestId: intake.event.eventId, receiptId: intake.receipt.id, leadId, enrollmentId: enrollment.id, confirmationId: confirmedSend.id,
    followup: { state: followupJob.state, reason: followupJob.stopReason }, appointmentId: appointment.id, proposalId: proposal.id,
    documentId: draft.id, proformaId: proforma.id, pdfSha256: createHash('sha256').update(pdf).digest('hex'),
    checks: ['request-replay', 'one-receipt', 'one-projected-lead', 'today-queue', 'notification-read-once', 'one-confirmation', 'booking-replay',
      'busy-slot', 'appointment-stops-followup', 'setter-proposal', 'admin-confirmation', 'former-owner-denied', 'missing-fields',
      'prefilled-draft', 'proforma-dedup', 'pdf'], completedAt: new Date().toISOString() };
  writeFileSync(join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  testContext.diagnostic(`Synthetic PDF: ${pdfPath}; SHA256 ${evidence.pdfSha256}; provider calls and live messages: 0.`);
});
