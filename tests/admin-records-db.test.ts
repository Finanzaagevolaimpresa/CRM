import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { syntheticAuthority, syntheticPerson, syntheticSession, syntheticSharingCase } from './selective-sharing/fixtures';
import { previewSelectiveAccess, confirmSelectiveAccess } from '../src/lib/selective-project-access';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { restoreRemovedAccount } from '../src/lib/user-account-service';
import { executeAdminUserCommand, reconcileAdminUserCommand } from '../src/lib/admin-user-commands';
import { adminUserVersion } from '../src/lib/admin-user-command-contract';
import { technicalFixture, technicalTarget } from './technical-assignments/fixtures';
import { loadTechnicalPrivateItemCreationContext, previewPrivateTechnicalItem, confirmPrivateTechnicalItem } from '../src/lib/technical-private-item-service';
import type { TechnicalPrivateItemCommand } from '../src/lib/technical-private-item-contract';
import { paymentCorrectionFixture } from './admin-records/payment-fixture';
import { adminDossierFixture } from './admin-records/dossier-fixture';
import { getEngagementDossierReadAccess, recordEngagementDossierDelivery } from '../src/lib/engagement-dossier';
import { aiOutputAdminAuthors } from '../src/lib/ai-output-admin-authors';
import { canReviewAiOutput, canApproveAiOutput } from '../src/lib/access-control';
import { loadAdminRecord, saveAdminRecord, listAdminRecords, readAdminRecordReceipt, closeAdminRecordAttempt, searchAdminRecordReferences,
  type AdminRecordCommand } from '../src/lib/admin-records';

const enabled = process.env.RUN_DB_TESTS === '1' && process.env.ADMIN_RECORD_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person;
before(async () => { if (enabled) { await assertAiOrchestratorEphemeralDatabaseIdentity(db); admin = await syntheticAuthority(db); } });
after(async () => db.$disconnect());
function proof(person = admin, secondsAgo = 0) {
  return { key, sessionToken: person.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: person.user.id,
    sessionToken: person.token, role: person.user.role, nowSeconds: Math.floor(Date.now() / 1000) - secondsAgo }) };
}
async function fixture() {
  const client = await db.client.create({ data: { displayName: `Cliente Admin sintetico ${randomUUID()}`, type: 'societa' } });
  const project = await db.project.create({ data: { clientId: client.id, title: 'Progetto sintetico', priority: 'media' } });
  return { client, project };
}
async function command(model: string, id: string, patch: Record<string, string> = {}, operation: AdminRecordCommand['operation'] = 'UPDATE', actor = admin) {
  const form = await loadAdminRecord(db, actor.session, model, id, operation === 'CREATE');
  return { commandId: randomUUID(), model, id, expectedVersion: form.version, operation, reason: 'Rettifica sintetica isolata',
    values: ['CREATE', 'UPDATE'].includes(operation) ? { ...form.values, ...patch } : {} } satisfies AdminRecordCommand;
}
const save = (input: AdminRecordCommand, actor = admin, secondsAgo = 0) => saveAdminRecord(db, actor.session, input, proof(actor, secondsAgo));

test('CRM agent metadata corrections create one immutable version without changing execution configuration', options, async () => {
  const row = await db.aiAgent.create({ data: { code: 'SYNTHETIC-' + randomUUID(), name: 'Agente sintetico', promptVersion: 'v1',
    systemPrompt: 'Istruzione originale da conservare', active: false, provider: 'mock', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } } });
  const previous = await db.aiAgentConfigVersion.create({ data: { agentId: row.id, version: 1, code: row.code, name: row.name,
    description: row.description, operationalScope: row.operationalScope, systemPrompt: row.systemPrompt, requiredDataChecklist: [],
    expectedOutput: row.expectedOutput, toneStyle: row.toneStyle, active: row.active, provider: row.provider, model: row.futureModel,
    promptVersion: row.promptVersion, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, createdById: admin.user.id } });
  const input = await command('AiAgent', row.id, { name: 'Nome operativo corretto', description: 'Descrizione aggiornata', requiredDataChecklist: '["Documento sintetico"]' });
  const receipt = await save(input); assert.equal((await save(input)).replayed, true);
  const next = await db.aiAgent.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(next.name, 'Nome operativo corretto'); assert.equal(next.configVersion, 2);
  for (const name of ['systemPrompt', 'provider', 'futureModel', 'active', 'inputSchema', 'outputSchema', 'code'] as const) assert.deepEqual(next[name], row[name]);
  const version = await db.aiAgentConfigVersion.findUniqueOrThrow({ where: { agentId_version: { agentId: row.id, version: 2 } } });
  assert.equal(version.name, next.name); assert.equal(version.systemPrompt, row.systemPrompt); assert.equal(version.createdById, admin.user.id);
  assert.equal(await db.aiAgentConfigVersion.count({ where: { agentId: row.id } }), 2);
  assert.deepEqual(await db.aiAgentConfigVersion.findUniqueOrThrow({ where: { id: previous.id } }), previous);
  await assert.rejects(save({ ...await command('AiAgent', row.id), values: { ...(await command('AiAgent', row.id)).values, active: 'true' } }), /INVALID/);
  assert.equal((await readAdminRecordReceipt(db, admin.session, receipt.commandId))?.id, row.id);
});

test('content corrections keep their author distinct from review and cannot reuse an existing human approval', options, async () => {
  const f = await fixture(), generator = await syntheticPerson(db, 'Autore sintetico originale'), reviewer = await syntheticPerson(db, 'Revisore sintetico indipendente');
  // Exercise correction receipts and the existing review policy without
  // creating or authorizing a new AI execution for this lifecycle test.
  const output = await db.aiOutput.create({ data: { aiRunId: 'synthetic-historical-run-reference', clientId: f.client.id, projectId: f.project.id,
    title: 'Risultato sintetico da revisionare', content: 'Testo originario', requiresHumanReview: true, status: 'needs_review' } });
  await save(await command('AiOutput', output.id, { content: 'Correzione manuale tracciata' }));
  const current = await db.aiOutput.findUniqueOrThrow({ where: { id: output.id } });
  const authors = await db.$transaction(tx => aiOutputAdminAuthors(tx, [output.id]));
  const context = { ...current, contentEditorIds: authors.get(output.id), client: f.client, project: { ...f.project, client: f.client }, clientService: null,
    run: { clientId: f.client.id, projectId: f.project.id, clientServiceId: null, createdById: generator.user.id } };
  assert.deepEqual(context.contentEditorIds, [admin.user.id]);
  assert.equal(canReviewAiOutput(admin.session, context), false); assert.equal(canReviewAiOutput(reviewer.session, context), true);
  const reviewedAt = new Date();
  assert.equal(canApproveAiOutput(admin.session, { ...context, reviewedById: reviewer.user.id, reviewedAt }), false);
  await db.aiOutput.update({ where: { id: output.id }, data: { reviewedById: reviewer.user.id, reviewedAt } });
  await assert.rejects(save(await command('AiOutput', output.id, { content: 'Cannot replace reviewed content' })), /HISTORY/);
  assert.equal((await db.aiOutput.findUniqueOrThrow({ where: { id: output.id } })).aiRunId, output.aiRunId);
  assert.equal((await db.aiOutput.findUniqueOrThrow({ where: { id: output.id } })).reviewedById, reviewer.user.id);
  const dossier = await db.clientDossier.create({ data: { clientId: f.client.id, projectId: f.project.id, title: 'Bozza manuale', content: 'Originale', createdById: generator.user.id } });
  await save(await command('ClientDossier', dossier.id, { content: 'Correzione del nuovo autore' }));
  assert.equal((await db.clientDossier.findUniqueOrThrow({ where: { id: dossier.id } })).updatedById, admin.user.id);
  await db.clientDossier.update({ where: { id: dossier.id }, data: { reviewedById: reviewer.user.id, reviewedAt } });
  await assert.rejects(save(await command('ClientDossier', dossier.id, { content: 'Cannot retain a stale review' })), /HISTORY/);
  const pre = await db.preAnalysis.create({ data: { clientId: f.client.id, projectId: f.project.id, status: 'bozza_generata', reviewedById: reviewer.user.id } });
  await assert.rejects(save(await command('PreAnalysis', pre.id, { internalSummary: 'Cannot retain a stale review' })), /HISTORY/);
});

test('versioned dossier archive and restoration preserve approval and delivered proof while unused delivery stays revoked', options, async () => {
  const f = await adminDossierFixture(db, admin.session);
  const original = await db.clientDossier.findUniqueOrThrow({ where: { id: f.dossier.id } });
  const versions = await db.engagementDossierVersion.findMany({ where: { dossierId: original.id } });
  const reviews = await db.engagementDossierReview.findMany({ where: { dossierId: original.id } });
  await save(await command('ClientDossier', original.id, { status: 'archiviata' }));
  assert.equal(await getEngagementDossierReadAccess(db, f.actors.operator, original.id), null);
  assert((await db.engagementDossierDeliveryAuthorization.findUniqueOrThrow({ where: { id: f.pending.id } })).revokedAt);
  assert.deepEqual(await db.engagementDossierDeliveryAuthorization.findUniqueOrThrow({ where: { id: f.consumed.id } }), f.consumed);
  assert.deepEqual(await db.engagementDossierDeliveryReceipt.findUniqueOrThrow({ where: { id: f.receipt.id } }), f.receipt);
  await save(await command('ClientDossier', original.id, { status: original.status }));
  const restored = await getEngagementDossierReadAccess(db, f.actors.operator, original.id);
  assert(restored); assert.equal(restored.dossier.approvedVersionId, original.approvedVersionId);
  assert.equal(restored.dossier.content, original.content); assert.equal(restored.dossier.archivedAt, null);
  assert.deepEqual(await db.engagementDossierVersion.findMany({ where: { dossierId: original.id } }), versions);
  assert.deepEqual(await db.engagementDossierReview.findMany({ where: { dossierId: original.id } }), reviews);
  await assert.rejects(recordEngagementDossierDelivery(db, f.actors.operator, { authorizationId: f.pending.id, outcome: 'DELIVERED',
    evidence: { reference: 'MUST_NOT_BE_REUSED', deliveredAt: new Date(), synthetic: true } }));
  await assert.rejects(save(await command('ClientDossier', original.id, { title: 'Rewriting an approved version' })), /HISTORY/);
  await save(await command('ClientDossier', original.id, {}, 'RECTIFY'));
  assert.deepEqual(await db.engagementDossierDeliveryReceipt.findUniqueOrThrow({ where: { id: f.receipt.id } }), f.receipt);
  const archived = await command('ClientDossier', original.id, { status: 'archiviata' });
  await db.engagementDossierVersion.update({ where: { id: f.version.id }, data: { content: 'Synthetic integrity failure' } });
  await assert.rejects(save(archived));
  assert.equal((await db.clientDossier.findUniqueOrThrow({ where: { id: original.id } })).status, original.status);
  await db.engagementDossierVersion.update({ where: { id: f.version.id }, data: { content: f.version.content } });
});

test('practice communication drafts move with their context and used archives restore without rewriting personal evidence', options, async () => {
  const a = await fixture(), b = await fixture();
  const practice = (f: Awaited<ReturnType<typeof fixture>>, title: string) => db.technicalPractice.create({ data: {
    clientId: f.client.id, projectId: f.project.id, title, practiceType: 'verifica', targetEntity: 'Ente sintetico', createdById: admin.user.id } });
  const first = await practice(a, 'Origine sintetica'), second = await practice(b, 'Destinazione sintetica');
  const draft = await db.practiceCommunication.create({ data: { technicalPracticeId: first.id, clientId: a.client.id, projectId: a.project.id,
    title: 'Nota sintetica', content: 'Testo da correggere', type: 'interna', channel: 'nota_interna', createdById: admin.user.id } });
  await save(await command('PracticeCommunication', draft.id, { technicalPracticeId: second.id }));
  const moved = await db.practiceCommunication.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(moved.clientId, b.client.id); assert.equal(moved.projectId, b.project.id); assert.equal(moved.technicalOwnerId, second.technicalOwnerId);
  await assert.rejects(save(await command('PracticeCommunication', draft.id, { channel: 'email' })), /HISTORY/);
  const used = await db.practiceCommunication.update({ where: { id: draft.id }, data: { status: 'usata_inviata',
    reviewedAt: new Date(), reviewedById: admin.user.id, usedAt: new Date() } });
  await assert.rejects(save(await command('PracticeCommunication', draft.id, { content: 'Altered used text' })), /HISTORY/);
  await save(await command('PracticeCommunication', draft.id, {}, 'RECTIFY'));
  await save(await command('PracticeCommunication', draft.id, {}, 'TRASH'));
  await save(await command('PracticeCommunication', draft.id, {}, 'RESTORE'));
  const restored = await db.practiceCommunication.findUniqueOrThrow({ where: { id: draft.id } });
  for (const key of ['content', 'reviewedById', 'reviewedAt', 'usedAt', 'status'] as const) assert.deepEqual(restored[key], used[key]);
  await db.practiceCommunication.update({ where: { id: draft.id }, data: { status: 'archiviata', deletedAt: new Date() } });
  await save(await command('PracticeCommunication', draft.id, {}, 'RESTORE'));
  const legacy = await db.practiceCommunication.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(legacy.status, 'usata_inviata'); assert.deepEqual(legacy.usedAt, used.usedAt); assert.equal(legacy.deletedAt, null);
});

test('rapid sequential corrections persist every submitted value and journal the same committed row', options, async () => {
  const f = await fixture(), lead = await db.lead.create({ data: { firstName: 'Sequenza', lastName: 'Sintetica' } });
  for (let index = 0; index < 30; index++) {
    const title = 'Sequenza progetto ' + index, notes = 'Sequenza lead ' + index;
    const projectInput = await command('Project', f.project.id, { title });
    const projectReceipt = await save(projectInput);
    const project = await db.project.findUniqueOrThrow({ where: { id: f.project.id } });
    const projectRaw = await db.$queryRaw<Array<{ title: string }>>`SELECT title FROM "Project" WHERE id=${f.project.id}`;
    const projectJournal = await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId: projectInput.commandId } });
    assert.equal(project.title, title, JSON.stringify({ projectReceipt, raw: projectRaw[0], journal: projectJournal.after }));
    assert.equal((projectJournal.after as { title: string }).title, title);
    const leadInput = await command('Lead', lead.id, { notes });
    const leadReceipt = await save(leadInput);
    const savedLead = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    const leadRaw = await db.$queryRaw<Array<{ notes: string }>>`SELECT notes FROM "Lead" WHERE id=${lead.id}`;
    const leadJournal = await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId: leadInput.commandId } });
    assert.equal(savedLead.notes, notes, JSON.stringify({ leadReceipt, raw: leadRaw[0], journal: leadJournal.after }));
    assert.equal((leadJournal.after as { notes: string }).notes, notes);
  }
});

test('ordinary companies, people, incorporation subjects, work and deadlines persist coherent links and restore the same records', options, async () => {
  const f = await fixture(), companyId = randomUUID(), personId = randomUUID(), linkId = randomUUID(), incorporationId = randomUUID();
  await save(await command('Company', companyId, { clientId: f.client.id, name: 'Azienda sintetica Admin', employees: '3', annualRevenue: '100000.00' }, 'CREATE'));
  await save(await command('Person', personId, { firstName: 'Persona', lastName: 'Sintetica', email: 'ordinary-person@example.test' }, 'CREATE'));
  await save(await command('CompanyPerson', linkId, { companyId, personId, role: 'socio', ownershipPercent: '25.50' }, 'CREATE'));
  assert.equal((await db.companyPerson.findUniqueOrThrow({ where: { id: linkId } })).ownershipPercent?.toString(), '25.5');
  await save(await command('Person', personId, { notes: 'Rettifica anagrafica sintetica' }));
  assert.equal((await db.person.findUniqueOrThrow({ where: { id: personId } })).notes, 'Rettifica anagrafica sintetica');
  await save(await command('CompanyPerson', linkId, {}, 'TRASH')); assert.equal(await db.companyPerson.findUnique({ where: { id: linkId } }), null);
  await save(await command('CompanyPerson', linkId, {}, 'RESTORE'));
  assert.equal((await db.companyPerson.findUniqueOrThrow({ where: { id: linkId } })).personId, personId);
  await save(await command('IncorporationSubject', incorporationId, { promoterClientId: f.client.id, plannedActivity: 'Attività da valutare', estimatedInvestment: '25000.00' }, 'CREATE'));
  await save(await command('IncorporationSubject', incorporationId, {}, 'TRASH'));
  await save(await command('IncorporationSubject', incorporationId, {}, 'RESTORE'));
  assert.equal((await db.incorporationSubject.findUniqueOrThrow({ where: { id: incorporationId } })).estimatedInvestment?.toString(), '25000');
  const projectId = randomUUID(), practiceId = randomUUID(), taskId = randomUUID(), checklistId = randomUUID(), deadlineId = randomUUID();
  await save(await command('Project', projectId, { clientId: f.client.id, companyId, title: 'Progetto collegato sintetico', totalInvestment: '25000.00' }, 'CREATE'));
  await save(await command('TechnicalPractice', practiceId, { clientId: f.client.id, projectId, title: 'Pratica sintetica', practiceType: 'verifica', targetEntity: 'Ente sintetico' }, 'CREATE'));
  await save(await command('Task', taskId, { clientId: f.client.id, companyId, projectId, title: 'Attività di verifica', dueAt: '2031-01-03T10:30:00.000Z' }, 'CREATE'));
  await save(await command('DocumentChecklistItem', checklistId, { clientId: f.client.id, projectId, title: 'Documento da richiedere' }, 'CREATE'));
  await save(await command('Deadline', deadlineId, { entityType: 'Task', entityId: taskId, title: 'Scadenza esatta', dueAt: '2031-01-03T10:30:00.000Z' }, 'CREATE'));
  await save(await command('Deadline', deadlineId, {}, 'TRASH')); await save(await command('Deadline', deadlineId, {}, 'RESTORE'));
  assert.equal((await db.deadline.findUniqueOrThrow({ where: { id: deadlineId } })).dueAt.toISOString(), '2031-01-03T10:30:00.000Z');
  await save(await command('TechnicalPractice', practiceId, {}, 'TRASH')); await save(await command('TechnicalPractice', practiceId, {}, 'RESTORE'));
  const practice = await db.technicalPractice.findUniqueOrThrow({ where: { id: practiceId } });
  assert.equal(practice.projectId, projectId); assert.equal(practice.deletedAt, null); assert.equal(practice.technicalOwnerId, null);
  assert.equal((await db.documentChecklistItem.findUniqueOrThrow({ where: { id: checklistId } })).status, 'da_richiedere');
});

test('manual assessments and document analyses retain amounts, source documents and historical corrections', options, async () => {
  const f = await fixture(), company = await db.company.create({ data: { clientId: f.client.id, name: 'Azienda analisi sintetiche' } });
  const bankId = randomUUID(), financeId = randomUUID(), grantId = randomUUID(), measureId = randomUUID(), cumulabilityId = randomUUID();
  await save(await command('BankabilityAssessment', bankId, { clientId: f.client.id, projectId: f.project.id, ebitda: '-123.50', revenue: '100000.00', dataCompleteness: '50' }, 'CREATE'));
  await save(await command('CorporateFinancingAssessment', financeId, { clientId: f.client.id, projectId: f.project.id, requestedAmount: '25000.00', purpose: 'Valutazione sintetica', sustainableInstallment: '1200.00' }, 'CREATE'));
  await save(await command('GrantAssessment', grantId, { projectId: f.project.id, summary: 'Analisi manuale sintetica' }, 'CREATE'));
  await save(await command('MeasureMatch', measureId, { grantAssessmentId: grantId, internalMeasureName: 'Misura sintetica', expectedBenefitAmount: '5000.00', expectedBenefitPercent: '20.00', officialSourceUrl: 'https://example.test/source' }, 'CREATE'));
  await save(await command('CumulabilityAssessment', cumulabilityId, { projectId: f.project.id, grantAssessmentId: grantId, summary: 'Verifica manuale da revisionare' }, 'CREATE'));
  assert.equal((await db.bankabilityAssessment.findUniqueOrThrow({ where: { id: bankId } })).ebitda?.toString(), '-123.5');
  assert.equal((await db.corporateFinancingAssessment.findUniqueOrThrow({ where: { id: financeId } })).sustainableInstallment?.toString(), '1200');
  assert.equal((await db.measureMatch.findUniqueOrThrow({ where: { id: measureId } })).expectedBenefitPercent?.toString(), '20');
  await save(await command('BankabilityAssessment', bankId, { ebitda: '-100.00', riskRationale: 'Rettifica sintetica motivata' }));
  assert.equal((await db.bankabilityAssessment.findUniqueOrThrow({ where: { id: bankId } })).ebitda?.toString(), '-100');
  await assert.rejects(save(await command('GrantAssessment', grantId, {}, 'TRASH')), /DEPENDENCIES/);
  const assessments = [['BankabilityAssessment', bankId], ['CorporateFinancingAssessment', financeId], ['MeasureMatch', measureId], ['CumulabilityAssessment', cumulabilityId], ['GrantAssessment', grantId]];
  for (const [model, id] of assessments) await save(await command(model, id, {}, 'TRASH'));
  for (const [model, id] of [...assessments].reverse()) await save(await command(model, id, {}, 'RESTORE'));
  assert.equal((await db.bankabilityAssessment.findUniqueOrThrow({ where: { id: bankId } })).ebitda?.toString(), '-100');
  assert.equal((await db.measureMatch.findUniqueOrThrow({ where: { id: measureId } })).grantAssessmentId, grantId);
  const doc = await db.document.create({ data: { clientId: f.client.id, companyId: company.id, projectId: f.project.id, title: 'Fonte sintetica', type: 'altro',
    fileName: 'source.txt', mimeType: 'text/plain', sizeBytes: 12, storagePath: 'synthetic/unchanged-source.txt', checksum: 'a'.repeat(64), uploadedById: admin.user.id } });
  const extractionId = randomUUID(), visuraId = randomUUID();
  await save(await command('DocumentExtraction', extractionId, { documentId: doc.id, extractedText: 'Trascrizione manuale', extractedJson: '{"synthetic":true}' }, 'CREATE'));
  await save(await command('VisuraAnalysis', visuraId, { documentId: doc.id, companyId: company.id, findings: '{"synthetic":true}' }, 'CREATE'));
  await save(await command('DocumentExtraction', extractionId, { extractedText: 'Trascrizione rettificata' }));
  const otherDoc = await db.document.create({ data: { ...doc, id: randomUUID(), title: 'Fonte diversa sintetica' } });
  await assert.rejects(save(await command('DocumentExtraction', extractionId, { documentId: otherDoc.id })), /HISTORY/);
  await save(await command('DocumentExtraction', extractionId, {}, 'TRASH')); await save(await command('DocumentExtraction', extractionId, {}, 'RESTORE'));
  await save(await command('VisuraAnalysis', visuraId, {}, 'TRASH')); await save(await command('VisuraAnalysis', visuraId, {}, 'RESTORE'));
  assert.equal((await db.documentExtraction.findUniqueOrThrow({ where: { id: extractionId } })).extractedText, 'Trascrizione rettificata');
  assert.equal((await db.visuraAnalysis.findUniqueOrThrow({ where: { id: visuraId } })).documentId, doc.id);
  assert.deepEqual(await db.document.findUniqueOrThrow({ where: { id: doc.id } }), doc);
});

test('evidenced payment correction and restoration preserve the original collection and align linked services exactly once', options, async () => {
  const f = await paymentCorrectionFixture(db, admin.user.id);
  const evidenceChoices = await searchAdminRecordReferences(db, admin.session, { model: 'Payment', field: 'administrativeEvidenceVersionId', query: f.document.title, page: 1 });
  assert(evidenceChoices.options.some(row => row.value === f.version.id), 'the exact verified evidence version must be reachable from the Admin editor');
  const input = await command('Payment', f.payment.id, { status: 'rimborsato' });
  await assert.rejects(save(input), /HISTORY/);
  const correction = { evidenceVersionId: f.version.id, effectiveAt: f.effectiveAt, confirmed: true as const };
  const foreign = await paymentCorrectionFixture(db, admin.user.id);
  await assert.rejects(save({ ...input, paymentCorrection: { ...correction, evidenceVersionId: foreign.version.id } }), /CONTEXT/);
  await assert.rejects(save({ ...input, paymentCorrection: { ...correction, effectiveAt: new Date(Date.now() + 3600_000).toISOString() } }), /INVALID/);
  const valid = { ...input, paymentCorrection: correction }; await save(valid); await save(valid);
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } })).paymentStatus, 'rimborsato');
  const after = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  assert.equal(after.status, 'rimborsato'); assert.deepEqual(after.collectedAt, f.payment.collectedAt); assert.equal(after.accountingDocumentId, f.payment.accountingDocumentId);
  assert.equal(await db.auditLog.count({ where: { id: `payment-correction:${input.commandId}` } }), 1);
  const restore = { ...await command('Payment', f.payment.id, { status: 'incassato' }), paymentCorrection: correction };
  await save(restore);
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } })).paymentStatus, 'parziale');
  const restored = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  assert.equal(restored.status, 'incassato'); assert.deepEqual(restored.collectedAt, f.payment.collectedAt); assert(restored.totalAmount.equals(f.payment.totalAmount));
  await assert.rejects(save({ ...await command('Payment', f.payment.id, { status: 'da_incassare' }), paymentCorrection: correction }), /HISTORY/);
  const failing = db.$extends({ query: { auditLog: { async create() { throw new Error('SYNTHETIC_PAYMENT_AUDIT_FAILURE'); } } } }) as unknown as PrismaClient;
  const retry = { ...await command('Payment', f.payment.id, { status: 'stornato' }), paymentCorrection: correction };
  await assert.rejects(saveAdminRecord(failing, admin.session, retry, proof()), /SYNTHETIC_PAYMENT_AUDIT_FAILURE/);
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'incassato');
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } })).paymentStatus, 'parziale');
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: retry.commandId } }), 0);
});

test('reference search reaches records beyond the initial window and retains ordinary scope restrictions', options, async () => {
  const prefix = `Ricerca sintetica ${randomUUID()}`, ids = Array.from({ length: 1005 }, () => randomUUID()).sort();
  await db.client.createMany({ data: ids.map((id, index) => ({ id, displayName: `${prefix} ${index}`, type: 'societa' })) });
  const input = { model: 'Project', field: 'clientId', query: prefix, page: 1 };
  const first = await searchAdminRecordReferences(db, admin.session, input);
  assert.equal(first.options.length, 50); assert.equal(first.hasNext, true);
  const last = await searchAdminRecordReferences(db, admin.session, { ...input, page: 21 });
  assert.equal(last.options.length, 5); assert.equal(last.hasNext, false);
  assert.equal((await searchAdminRecordReferences(db, admin.session, { ...input, query: ids[1004] })).options[0].value, ids[1004]);
  const other = await syntheticPerson(db, 'Ricerca non Admin', 'consulente');
  await assert.rejects(searchAdminRecordReferences(db, other.session, input));
  await assert.rejects(searchAdminRecordReferences(db, admin.session, { ...input, field: 'passwordHash' }));
  await db.technicalAssignmentAuthority.create({ data: { id: 'technical-assignment', userId: admin.user.id, enabled: true, revision: 1 } });
  const target = technicalTarget(await technicalFixture(db, admin));
  const context = await loadTechnicalPrivateItemCreationContext(db, admin.session, target);
  const unrelatedAdmin = await syntheticPerson(db, 'Altro Admin privo di autorità tecnica', 'admin');
  for (const kind of ['Task', 'DocumentChecklistItem'] as const) {
    const common = { commandId: randomUUID(), itemId: randomUUID(), target, expectedContextSha256: context.contextSha256 };
    const command: TechnicalPrivateItemCommand = kind === 'Task' ? { ...common, kind, values: { title: `${prefix} private`, description: null, priority: 'media', dueAt: null } }
      : { ...common, kind: 'ChecklistItem', values: { title: `${prefix} private`, notes: null } };
    const personalProof = proof();
    const preview = await previewPrivateTechnicalItem(db, admin.session, personalProof, command);
    await confirmPrivateTechnicalItem(db, admin.session, personalProof, command, preview.token, true);
    if (kind === 'Task') assert.equal((await searchAdminRecordReferences(db, admin.session, { model: 'Deadline', field: 'entityId', entityType: 'Task', query: command.itemId, page: 1 })).options.length, 0);
    await assert.rejects(loadAdminRecord(db, unrelatedAdmin.session, kind, command.itemId), /DENIED/);
    const original = await db.technicalPrivateItemOrigin.findUniqueOrThrow({ where: { commandId: command.commandId } });
    const beforeScope = await db.technicalWorkItemGeneration.findUniqueOrThrow({ where: { kind_itemId: { kind: command.kind, itemId: command.itemId } } });
    const loaded = await loadAdminRecord(db, admin.session, kind, command.itemId);
    assert(loaded.fields.find(field => field.name === 'clientId')?.readOnly);
    const patch = { commandId: randomUUID(), model: kind, id: command.itemId, expectedVersion: loaded.version, operation: 'UPDATE' as const,
      reason: 'Correzione privata sintetica del titolare', values: { ...loaded.values, title: 'Titolo privato corretto' } };
    await save(patch);
    const updated = await loadAdminRecord(db, admin.session, kind, command.itemId);
    await assert.rejects(save({ ...patch, commandId: randomUUID(), expectedVersion: updated.version, values: { ...updated.values, clientId: ids[0] } }), /HISTORY/);
    assert.equal(updated.values.title, 'Titolo privato corretto');
    await save({ ...patch, commandId: randomUUID(), expectedVersion: updated.version, operation: 'TRASH', values: {} });
    const archived = await loadAdminRecord(db, admin.session, kind, command.itemId);
    assert.equal(archived.deleted, true);
    await save({ ...patch, commandId: randomUUID(), expectedVersion: archived.version, operation: 'RESTORE', values: {} });
    assert.equal((await loadAdminRecord(db, admin.session, kind, command.itemId)).deleted, false);
    const afterScope = await db.technicalWorkItemGeneration.findUniqueOrThrow({ where: { kind_itemId: { kind: command.kind, itemId: command.itemId } } });
    assert(afterScope.scopeGeneration >= beforeScope.scopeGeneration + 2);
    assert.deepEqual(await db.technicalPrivateItemOrigin.findUniqueOrThrow({ where: { commandId: command.commandId } }), original);
  }
});

test('account creation records one receipt, replays a lost response and never persists a password in the journal', options, async () => {
  const input = { commandId: randomUUID(), operation: 'CREATE', userId: randomUUID(), expectedVersion: adminUserVersion(null) };
  const values = { name: 'Nuovo account sintetico', email: `${randomUUID()}@example.test`, password: 'synthetic-create-password-0000', role: 'consulente', active: false };
  await executeAdminUserCommand(db, admin.session, input, values, proof());
  await executeAdminUserCommand(db, admin.session, input, values, proof());
  assert.equal(await db.user.count({ where: { id: input.userId } }), 1);
  assert.equal(await db.auditLog.count({ where: { entityId: input.userId, event: 'user_create' } }), 1);
  assert.equal((await reconcileAdminUserCommand(db, admin.session, input))?.userId, input.userId);
  const row = await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId: input.commandId } });
  const serialized = JSON.stringify(row, (_name, value) => typeof value === 'bigint' ? value.toString() : value);
  for (const sensitive of [values.password, values.email, values.name, (await db.user.findUniqueOrThrow({ where: { id: input.userId } })).passwordHash]) assert(!serialized.includes(sensitive));
});

test('profile, password reset and account lifecycle retain one receipt and preserve identity without leaking submitted data', options, async () => {
  const target = await syntheticPerson(db, 'Account sintetico amministrato', 'consulente');
  const identity = async (operation: string) => ({ operation, commandId: randomUUID(), userId: target.user.id,
    expectedVersion: adminUserVersion(await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } })) });
  const profile = await identity('PROFILE'), values = { name: 'Nome rettificato sintetico', email: randomUUID() + '@example.test' };
  await assert.rejects(executeAdminUserCommand(db, admin.session, profile, values, proof(admin, 1801)));
  await executeAdminUserCommand(db, admin.session, profile, values, proof());
  await executeAdminUserCommand(db, admin.session, profile, values, proof());
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).email, values.email);
  assert((await db.internalSession.findUniqueOrThrow({ where: { id: target.session.sessionId! } })).revokedAt);
  assert.equal(await db.auditLog.count({ where: { entityId: target.user.id, event: 'user_profile_updated' } }), 1);
  const reset = await identity('PASSWORD_RESET'), password = 'synthetic-reset-password-only-00000';
  await executeAdminUserCommand(db, admin.session, reset, { password, confirmation: password }, proof());
  const passwordHash = (await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).passwordHash;
  assert(await bcrypt.compare(password, passwordHash));
  await executeAdminUserCommand(db, admin.session, reset, { password, confirmation: password }, proof());
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).passwordHash, passwordHash);
  const removed = await identity('REMOVE');
  await assert.rejects(executeAdminUserCommand(db, admin.session, removed, { retainHistory: false }, proof()));
  await executeAdminUserCommand(db, admin.session, removed, { retainHistory: true }, proof());
  assert((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).deletedAt);
  const restored = await identity('RESTORE');
  await executeAdminUserCommand(db, admin.session, restored, { restoreInactive: true }, proof());
  await executeAdminUserCommand(db, admin.session, restored, { restoreInactive: true }, proof());
  const after = await db.user.findUniqueOrThrow({ where: { id: target.user.id } });
  assert.equal(after.deletedAt, null); assert.equal(after.active, false); assert.equal(after.email, values.email); assert.equal(after.passwordHash, passwordHash);
  for (const input of [profile, reset, removed, restored]) assert.equal((await reconcileAdminUserCommand(db, admin.session, input))?.userId, target.user.id);
  const journal = await db.adminRecordRevision.findMany({ where: { model: 'User', recordId: target.user.id } });
  assert.equal(journal.length, 4);
  const serialized = JSON.stringify(journal, (_key, value) => typeof value === 'bigint' ? String(value) : value);
  for (const secret of [password, passwordHash, values.email, values.name]) assert(!serialized.includes(secret));
});

test('single-session revocation is bound to the selected account and does not close other access sessions', options, async () => {
  const target = await syntheticPerson(db, 'Account con più accessi', 'consulente'), second = await syntheticSession(db, target.user);
  const outsider = await syntheticPerson(db, 'Altro account isolato', 'consulente');
  const input = { commandId: randomUUID(), operation: 'REVOKE_SESSION', userId: target.user.id,
    expectedVersion: adminUserVersion(await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } })) };
  await assert.rejects(executeAdminUserCommand(db, admin.session, input, { sessionId: outsider.session.sessionId }, proof()), /STALE/);
  await executeAdminUserCommand(db, admin.session, input, { sessionId: target.session.sessionId }, proof());
  await executeAdminUserCommand(db, admin.session, input, { sessionId: target.session.sessionId }, proof());
  assert((await db.internalSession.findUniqueOrThrow({ where: { id: target.session.sessionId! } })).revokedAt);
  assert.equal((await db.internalSession.findUniqueOrThrow({ where: { id: second.session.sessionId! } })).revokedAt, null);
  assert.equal((await db.internalSession.findUniqueOrThrow({ where: { id: outsider.session.sessionId! } })).revokedAt, null);
  assert.equal(await db.auditLog.count({ where: { entityId: target.session.sessionId, event: 'session_revoked' } }), 1);
  const all = { ...input, commandId: randomUUID(), operation: 'REVOKE_SESSIONS' };
  await executeAdminUserCommand(db, admin.session, all, {}, proof());
  assert((await db.internalSession.findUniqueOrThrow({ where: { id: second.session.sessionId! } })).revokedAt);
  assert.equal((await db.internalSession.findUniqueOrThrow({ where: { id: outsider.session.sessionId! } })).revokedAt, null);
});

test('account role and permission commands reject stale changes, non-Admin actors and forbidden financial overrides', options, async () => {
  const target = await syntheticPerson(db, 'Account con ruolo sintetico', 'consulente');
  const before = await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } });
  const input = { commandId: randomUUID(), operation: 'ROLE', userId: target.user.id, expectedVersion: adminUserVersion(before) };
  await assert.rejects(executeAdminUserCommand(db, target.session, input, { role: 'admin' }, proof(target)));
  await executeAdminUserCommand(db, admin.session, input, { role: 'commerciale' }, proof());
  await assert.rejects(executeAdminUserCommand(db, admin.session, { ...input, commandId: randomUUID() }, { role: 'consulente' }, proof()), /STALE/);
  const changed = await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } });
  await assert.rejects(executeAdminUserCommand(db, admin.session, { ...input, operation: 'OVERRIDES', commandId: randomUUID(), expectedVersion: adminUserVersion(changed) },
    { overrides: [{ permission: 'payment.read', value: 'allow' }] }, proof()), /DENIED/);
  assert.equal(await db.userPermissionOverride.count({ where: { userId: target.user.id } }), 0);
});

test('account commands preserve expired drafts, protect self deactivation and close missing requests against late writes', options, async () => {
  const target = await syntheticPerson(db, 'Account da disattivare', 'consulente');
  const before = await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } });
  const input = { commandId: randomUUID(), operation: 'DEACTIVATE', userId: target.user.id, expectedVersion: adminUserVersion(before) };
  await assert.rejects(executeAdminUserCommand(db, admin.session, input, {}, proof(admin, 1801)));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).active, true);
  await executeAdminUserCommand(db, admin.session, input, {}, proof());
  assert((await db.internalSession.findUniqueOrThrow({ where: { id: target.session.sessionId } })).revokedAt);
  const own = await db.user.findUniqueOrThrow({ where: { id: admin.user.id }, include: { permissionOverrides: true } });
  await assert.rejects(executeAdminUserCommand(db, admin.session, { ...input, commandId: randomUUID(), userId: admin.user.id, expectedVersion: adminUserVersion(own) }, {}, proof()), /DENIED/);
  const closed = { ...input, commandId: randomUUID(), operation: 'ACTIVATE' };
  assert((await reconcileAdminUserCommand(db, admin.session, closed, true))?.closed);
  await assert.rejects(executeAdminUserCommand(db, admin.session, closed, {}, proof()), /CLOSED/);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).active, false);
});

test('removed account restoration preserves identity, role and references while keeping access and sessions disabled', options, async () => {
  const target = await syntheticPerson(db, 'Identità sintetica da ripristinare', 'consulente');
  await db.user.update({ where: { id: target.user.id }, data: { deletedAt: new Date(), active: false } });
  await assert.rejects(db.$transaction(tx => restoreRemovedAccount(tx, admin.session, target.user.id, proof(admin, 1801))));
  assert((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).deletedAt);
  const outsider = await syntheticPerson(db, 'Tecnico senza amministrazione', 'consulente');
  assert.equal((await db.$transaction(tx => restoreRemovedAccount(tx, outsider.session, target.user.id, proof(outsider)))).ok, false);
  assert.equal((await db.$transaction(tx => restoreRemovedAccount(tx, admin.session, target.user.id, proof()))).ok, true);
  const restored = await db.user.findUniqueOrThrow({ where: { id: target.user.id } });
  assert.equal(restored.deletedAt, null); assert.equal(restored.active, false); assert.equal(restored.role, 'consulente');
  assert.equal(restored.email, target.user.email);
  assert((await db.internalSession.findUniqueOrThrow({ where: { id: target.session.sessionId } })).revokedAt);
  assert.equal((await db.$transaction(tx => restoreRemovedAccount(tx, admin.session, target.user.id, proof()))).ok, false);
  assert.equal(await db.auditLog.count({ where: { entityId: target.user.id, event: 'user_restored_inactive' } }), 1);
});

test('manual analysis and dossier creation starts new unapproved drafts without invented AI provenance', options, async () => {
  const f = await fixture(), preId = randomUUID(), dossierId = randomUUID(), clientDossierId = randomUUID();
  const preReceipt = await save(await command('PreAnalysis', preId, { clientId: f.client.id, projectId: f.project.id, internalSummary: 'Analisi manuale sintetica' }, 'CREATE'));
  assert.equal(preReceipt.id, preId);
  assert(await db.preAnalysis.findUnique({ where: { id: preId } }), 'Manual preanalysis must be persisted before its dossier can link it');
  await save(await command('Dossier', dossierId, { clientId: f.client.id, projectId: f.project.id, preAnalysisId: preId, title: 'Dossier manuale sintetico', type: 'nota_interna', markdownContent: 'Bozza sintetica', jsonContent: '{}' }, 'CREATE'));
  await save(await command('ClientDossier', clientDossierId, { clientId: f.client.id, projectId: f.project.id, title: 'Bozza cliente sintetica', content: 'Testo da revisionare' }, 'CREATE'));
  const pre = await db.preAnalysis.findUniqueOrThrow({ where: { id: preId } }), dossier = await db.dossier.findUniqueOrThrow({ where: { id: dossierId } });
  const client = await db.clientDossier.findUniqueOrThrow({ where: { id: clientDossierId } });
  assert.equal(pre.status, 'raccolta_dati'); assert.equal(pre.aiRunId, null); assert.equal(pre.approvedAt, null);
  assert.equal(dossier.status, 'bozza_consulente'); assert.equal(dossier.aiRunId, null); assert.equal(dossier.approvedById, null);
  assert.equal(client.status, 'bozza'); assert.equal(client.sourceAiOutputId, null); assert.equal(client.createdById, admin.user.id);
});

test('contract archive and restoration preserve the signed proof and refuse fabricated signing', options, async () => {
  const f = await fixture(), signedAt = new Date('2026-01-01T00:00:00.000Z');
  const row = await db.contract.create({ data: { clientId: f.client.id, contractNumber: randomUUID(), serviceName: 'Servizio sintetico', serviceDescription: 'Attività test',
    taxableAmount: 100, vatAmount: 22, totalAmount: 122, status: 'firmato', signedAt, signedDocumentId: 'synthetic-existing-proof-reference' } });
  await save(await command('Contract', row.id, { status: 'archiviato' }));
  await save(await command('Contract', row.id, { status: 'firmato' }));
  const current = await db.contract.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(current.signedAt?.toISOString(), signedAt.toISOString()); assert.equal(current.signedDocumentId, row.signedDocumentId); assert.equal(current.status, 'firmato');
  const unsigned = await db.contract.create({ data: { clientId: f.client.id, contractNumber: randomUUID(), serviceName: 'Bozza', serviceDescription: 'Non firmato', taxableAmount: 100, vatAmount: 22, totalAmount: 122 } });
  await assert.rejects(save(await command('Contract', unsigned.id, { status: 'firmato' })), /HISTORY/);
  assert.equal((await db.contract.findUniqueOrThrow({ where: { id: unsigned.id } })).status, 'da_preparare');
});

test('archiving and restoring approved analyses retains exact evidence and cannot invent a review or restore changed content', options, async () => {
  const f = await fixture(), approvedAt = new Date('2026-01-01T00:00:00Z');
  const pre = await db.preAnalysis.create({ data: { projectId: f.project.id, clientId: f.client.id, status: 'approvata_internamente', approvedAt, approvedById: admin.user.id, internalSummary: 'Prova approvata' } });
  const dossier = await db.dossier.create({ data: { projectId: f.project.id, clientId: f.client.id, title: 'Dossier approvato', type: 'nota', status: 'approvato_internamente', approvedAt, approvedById: admin.user.id } });
  const ai = await db.aiOutput.create({ data: { aiRunId: 'synthetic-existing-run-reference', clientId: f.client.id, title: 'Output approvato', content: 'Prova immutata', status: 'approved', approvedAt, approvedById: admin.user.id } });
  for (const [model, id, status, archive] of [['PreAnalysis', pre.id, pre.status, 'archiviata'], ['Dossier', dossier.id, dossier.status, 'archiviato'], ['AiOutput', ai.id, ai.status, 'archived']] as const) {
    await save(await command(model, id, { status: archive }));
    const archived = await loadAdminRecord(db, admin.session, model, id); assert.equal(archived.values.status, archive);
    assert(archived.fields.filter(field => field.name !== 'status').every(field => field.readOnly));
    await save(await command(model, id, { status }));
    assert.equal((await loadAdminRecord(db, admin.session, model, id)).values.status, status);
  }
  assert.equal((await db.preAnalysis.findUniqueOrThrow({ where: { id: pre.id } })).approvedAt?.toISOString(), approvedAt.toISOString());
  await save(await command('AiOutput', ai.id, { status: 'archived' }));
  await db.aiOutput.update({ where: { id: ai.id }, data: { content: 'Variazione concorrente sintetica' } });
  await assert.rejects(save(await command('AiOutput', ai.id, { status: 'approved' })), /HISTORY/);
  const draft = await db.preAnalysis.create({ data: { projectId: f.project.id, clientId: f.client.id } });
  await assert.rejects(save(await command('PreAnalysis', draft.id, { status: 'approvata_internamente' })), /HISTORY/);
});

test('offer correction validates context and totals, preserves sent conditions and restores the same archived record', options, async () => {
  const f = await fixture(), id = randomUUID();
  await save(await command('CommercialOffer', id, { clientId: f.client.id, title: 'Offerta sintetica', taxableAmount: '100', vatAmount: '22', totalAmount: '122' }, 'CREATE'));
  const created = await db.commercialOffer.findUniqueOrThrow({ where: { id } }); assert.equal(created.status, 'bozza'); assert.equal(created.createdById, admin.user.id);
  await db.commercialOffer.update({ where: { id }, data: { status: 'inviata', sentAt: new Date() } });
  await assert.rejects(save(await command('CommercialOffer', id, { taxableAmount: '200', vatAmount: '44', totalAmount: '244' })), /HISTORY/);
  await save(await command('CommercialOffer', id, { followUpNote: 'Seguito sintetico conservato' }));
  await save(await command('CommercialOffer', id, {}, 'TRASH')); await save(await command('CommercialOffer', id, {}, 'RESTORE'));
  const restored = await db.commercialOffer.findUniqueOrThrow({ where: { id } }); assert.equal(restored.status, 'inviata'); assert.equal(restored.followUpNote, 'Seguito sintetico conservato');
  assert.equal(restored.totalAmount.toString(), '122'); assert.equal(restored.deletedAt, null);
});

test('SLA replacement creates a new version and retains the previous policy without activating dormant functionality', options, async () => {
  const previous = await db.commercialLeadSlaPolicyVersion.findFirst({ orderBy: { version: 'desc' } });
  const active = await db.commercialLeadSlaPolicyVersion.findFirst({ where: { status: 'ACTIVE', policyCode: 'COMMERCIAL_FIRST_RESPONSE' } })
    ?? await db.commercialLeadSlaPolicyVersion.create({ data: { version: (previous?.version ?? 0) + 1, status: 'ACTIVE', responseTargetSeconds: 3600, createdById: admin.user.id } });
  const id = randomUUID(); await save(await command('CommercialLeadSlaPolicyVersion', id, { responseTargetSeconds: '7200', status: 'ACTIVE' }, 'CREATE'));
  const old = await db.commercialLeadSlaPolicyVersion.findUniqueOrThrow({ where: { id: active.id } }), current = await db.commercialLeadSlaPolicyVersion.findUniqueOrThrow({ where: { id } });
  assert.equal(old.status, 'RETIRED'); assert.equal(old.responseTargetSeconds, active.responseTargetSeconds); assert.equal(old.version, active.version);
  assert.equal(current.status, 'ACTIVE'); assert.equal(current.responseTargetSeconds, 7200); assert(current.version > active.version);
  assert.equal(await db.commercialLeadSlaPolicyVersion.count({ where: { policyCode: 'COMMERCIAL_FIRST_RESPONSE', status: 'ACTIVE' } }), 1);
  await assert.rejects(save(await command('CommercialLeadSlaPolicyVersion', id, { responseTargetSeconds: '1' })), /INVALID/);
  await assert.rejects(save(await command('CommercialLeadSlaPolicyVersion', id, { responseTargetSeconds: '9000' })), /HISTORY/);
  assert.equal(process.env.COMMERCIAL_LEAD_INBOX_MODE, 'disabled');
});
test('Admin corrects priority and amounts after fifteen minutes, then reopens exact persisted values and history', options, async () => {
  const f = await fixture(), input = await command('Project', f.project.id, { priority: 'urgente', requestedAmount: '12345.67' });
  await save(input, admin, 900);
  const reopened = await loadAdminRecord(db, admin.session, 'Project', f.project.id);
  assert.equal(reopened.values.priority, 'urgente'); assert.equal(reopened.values.requestedAmount, '12345.67');
  assert.equal(reopened.history[0].id, input.commandId); assert(reopened.history[0].actor.includes(admin.user.email));
  assert.equal(await db.auditLog.count({ where: { id: `admin-record:${input.commandId}` } }), 1);
});
test('expired proof and revoked login reject atomically while the same unchanged draft works after reconfirmation', options, async () => {
  const f = await fixture(), input = await command('Project', f.project.id, { title: 'Titolo dopo riconferma' });
  await assert.rejects(save(input, admin, 1801)); assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 0);
  await save(input);
  const person = await syntheticPerson(db, 'Admin revocabile');
  const later = await command('Project', f.project.id, { title: 'Non applicato' }, 'UPDATE', person);
  await db.internalSession.update({ where: { id: person.session.sessionId }, data: { revokedAt: new Date() } });
  await assert.rejects(save(later, person));
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).title, 'Titolo dopo riconferma');
});
test('creation, lost response replay, trash and restoration keep one identity and exact decimal values', options, async () => {
  const f = await fixture(), id = randomUUID();
  const input = await command('ProjectExpense', id, { projectId: f.project.id, category: 'software', description: 'Costo sintetico', amount: '10.25', estimated: 'true', potentiallyEligible: 'false', priority: 'media' }, 'CREATE');
  await save(input); assert.equal((await save(input)).replayed, true);
  assert.equal(await db.projectExpense.count({ where: { id } }), 1);
  await save(await command('ProjectExpense', id, {}, 'TRASH'));
  assert.equal(await db.projectExpense.count({ where: { id } }), 0);
  assert((await listAdminRecords(db, admin.session, 'ProjectExpense', id, 1, true)).rows.some(row => row.id === id && row.deleted));
  await save(await command('ProjectExpense', id, {}, 'RESTORE'));
  assert.equal((await db.projectExpense.findUniqueOrThrow({ where: { id } })).amount.toString(), '10.25');
  assert.equal((await listAdminRecords(db, admin.session, 'ProjectExpense', id, 1, true)).rows.length, 0);
});
test('soft trash and restore preserve the client identity, links and complete original metadata', options, async () => {
  const f = await fixture(); await save(await command('Client', f.client.id, {}, 'TRASH'));
  assert((await loadAdminRecord(db, admin.session, 'Client', f.client.id)).deleted);
  await save(await command('Client', f.client.id, {}, 'RESTORE'));
  const row = await db.client.findUniqueOrThrow({ where: { id: f.client.id } });
  assert.equal(row.deletedAt, null); assert.equal(row.displayName, f.client.displayName);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).clientId, f.client.id);
});
test('stale concurrent edits do not silently overwrite the accepted change', options, async () => {
  const f = await fixture(), first = await command('Project', f.project.id, { title: 'Prima correzione' }), second = { ...first, commandId: randomUUID(), values: { ...first.values, title: 'Seconda correzione' } };
  const results = await Promise.allSettled([save(first), save(second)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: { in: [first.commandId, second.commandId] } } }), 1);
});
test('inconsistent parent links and reparenting graphs with dependent records are refused', options, async () => {
  const a = await fixture(), b = await fixture();
  const company = await db.company.create({ data: { clientId: b.client.id, name: 'Altra azienda sintetica' } });
  await assert.rejects(save(await command('Project', a.project.id, { companyId: company.id })), /CONTEXT/);
  await db.projectExpense.create({ data: { projectId: a.project.id, category: 'software', description: 'Voce collegata', amount: '1' } });
  await assert.rejects(save(await command('Project', a.project.id, { clientId: b.client.id })), /DEPENDENCIES/);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: a.project.id } })).clientId, a.client.id);
});
test('non-Admin and explicit write denials cannot use the editor or receipt oracle', options, async () => {
  const f = await fixture(), other = await syntheticPerson(db, 'Tecnico sintetico', 'consulente');
  await assert.rejects(loadAdminRecord(db, other.session, 'Project', f.project.id));
  await assert.rejects(readAdminRecordReceipt(db, other.session, randomUUID()));
  const limited = await syntheticPerson(db, 'Admin con divieto');
  await db.userPermissionOverride.create({ data: { userId: limited.user.id, permission: 'project.write', allowed: false } });
  await assert.rejects(save(await command('Project', f.project.id, { title: 'Vietato' }), limited));
});
test('a selected project closes ordinary Admin editor access to its child expenses and document metadata', options, async () => {
  const f = await syntheticSharingCase(db, admin), preview = await previewSelectiveAccess(db, admin.session, f.input);
  await confirmSelectiveAccess(db, admin.session, preview.token, true);
  const expense = await db.projectExpense.create({ data: { projectId: f.project.id, category: 'software', description: 'Spesa riservata', amount: 100 } });
  await assert.rejects(loadAdminRecord(db, f.reader.session, 'ProjectExpense', expense.id));
  assert.equal((await listAdminRecords(db, f.reader.session, 'ProjectExpense', expense.id)).rows.length, 0);
  await assert.rejects(loadAdminRecord(db, f.reader.session, 'Document', f.documents[0].doc.id));
  const input = await command('ProjectExpense', expense.id, { amount: '200' });
  await assert.rejects(save(input, f.reader));
});
test('a denial of assignment permission does not prevent correcting unrelated lead notes', options, async () => {
  const limited = await syntheticPerson(db, 'Admin senza assegnazione servizi');
  await db.userPermissionOverride.create({ data: { userId: limited.user.id, permission: 'service.assign', allowed: false } });
  const lead = await db.lead.create({ data: { firstName: 'Lead', lastName: 'Sintetico' } });
  await save(await command('Lead', lead.id, { notes: 'Nota corretta' }, 'UPDATE', limited), limited);
  const savedLead = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.equal(savedLead.notes, 'Nota corretta', JSON.stringify({ raw: await db.$queryRaw`SELECT notes FROM "Lead" WHERE id=${lead.id}`,
    journal: await db.adminRecordRevision.findMany({ where: { model: 'Lead', recordId: lead.id }, select: { before: true, after: true } }) }));
});
test('signed contracts remain immutable while a rectification adds evidence without rewriting the signature', options, async () => {
  const f = await fixture(), signedAt = new Date();
  const row = await db.contract.create({ data: { clientId: f.client.id, contractNumber: randomUUID(), serviceName: 'Sintetico', serviceDescription: 'Contratto test', taxableAmount: 100, vatAmount: 22, totalAmount: 122, signedAt, status: 'firmato' } });
  await assert.rejects(save(await command('Contract', row.id, { totalAmount: '244', taxableAmount: '200', vatAmount: '44' })), /HISTORY/);
  await save(await command('Contract', row.id, {}, 'RECTIFY'));
  const current = await db.contract.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(current.signedAt?.toISOString(), signedAt.toISOString()); assert.equal(current.totalAmount.toString(), '122');
});
test('previous values are restored through a new correction, preserving both historical revisions', options, async () => {
  const f = await fixture(), input = await command('Project', f.project.id, { title: 'Titolo rettificato' }); await save(input);
  const draft = await loadAdminRecord(db, admin.session, 'Project', f.project.id, false, input.commandId);
  assert.equal(draft.values.title, f.project.title);
  await save({ ...await command('Project', f.project.id), values: draft.values });
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).title, f.project.title);
  assert.equal(await db.adminRecordRevision.count({ where: { model: 'Project', recordId: f.project.id } }), 2);
});
test('receipt survives a fresh login for the same Admin but cannot be read by another Admin', options, async () => {
  const f = await fixture(), input = await command('Project', f.project.id, { title: 'Esito persistito' }); await save(input);
  const next = await syntheticSession(db, admin.user), other = await syntheticPerson(db, 'Altro Admin');
  assert.equal((await readAdminRecordReceipt(db, next.session, input.commandId))?.id, f.project.id);
  await assert.rejects(readAdminRecordReceipt(db, other.session, input.commandId));
});
test('durably closing an absent attempt prevents a later delayed request from changing records', options, async () => {
  const f = await fixture(), input = await command('Project', f.project.id, { title: 'Tentativo ritardato' });
  const closed = await closeAdminRecordAttempt(db, admin.session, { commandId: input.commandId, model: input.model, id: input.id });
  assert(closed.closed); await assert.rejects(save(input), /CLOSED/);
  assert((await readAdminRecordReceipt(db, admin.session, input.commandId))?.closed);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: input.id } })).title, f.project.title);
});
test('closing a committed attempt returns its receipt and never changes the successful outcome', options, async () => {
  const f = await fixture(), input = await command('Project', f.project.id, { title: 'Conservato' }); await save(input);
  assert.equal((await closeAdminRecordAttempt(db, admin.session, { commandId: input.commandId, model: input.model, id: input.id })).closed, false);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 1);
});
test('audit failure rolls back the correction and revision together', options, async () => {
  const f = await fixture(), input = await command('Project', f.project.id, { title: 'Rollback sintetico' });
  const failing = db.$extends({ query: { auditLog: { async create() { throw new Error('SYNTHETIC_AUDIT_FAILURE'); } } } }) as unknown as PrismaClient;
  await assert.rejects(saveAdminRecord(failing, admin.session, input, proof()), /SYNTHETIC_AUDIT_FAILURE/);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 0);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: input.id } })).title, f.project.title);
});
test('numeric UUIDs bind the exact command while the audit privacy filter stays effective', options, async () => {
  const f = await fixture(), input = { ...await command('Project', f.project.id, { title: 'UUID numerico salvato' }),
    commandId: '03012345-6789-4012-8123-123456789012' };
  await save(input); await save(input);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).title, 'UUID numerico salvato');
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: `admin-record:${input.commandId}` } });
  assert.match(String((audit.after as Prisma.JsonObject).commandId), /REDACTED:PERSONAL/);
  assert.equal((await readAdminRecordReceipt(db, admin.session, input.commandId))?.id, f.project.id);
  const absent = { ...input, commandId: '03012345-6789-4012-8123-123456789013' };
  assert((await closeAdminRecordAttempt(db, admin.session, { commandId: absent.commandId, model: absent.model, id: absent.id })).closed);
  assert((await readAdminRecordReceipt(db, admin.session, absent.commandId))?.closed);
  await assert.rejects(save(absent), /CLOSED/);
  const target = await syntheticPerson(db, 'Account UUID numerico', 'consulente');
  const before = await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } });
  const account = { commandId: '03012345-6789-4012-8123-123456789014', operation: 'DEACTIVATE', userId: target.user.id, expectedVersion: adminUserVersion(before) };
  await executeAdminUserCommand(db, admin.session, account, {}, proof());
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).active, false);
  assert.equal((await reconcileAdminUserCommand(db, admin.session, account))?.closed, false);
});

test('a deferred audit rejection cannot return a success receipt or leave business changes behind', options, async () => {
  const failing = db.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.id?.startsWith('admin-record:')) args.data.after = { ...args.data.after as Prisma.InputJsonObject, afterHash: '0'.repeat(64) };
    return query(args);
  } } } }) as unknown as PrismaClient;
  const f = await fixture(), input = await command('Project', f.project.id, { title: 'Commit da respingere' });
  await assert.rejects(saveAdminRecord(failing, admin.session, input, proof()), /ADMIN_REVISION_ATOMIC_AUDIT_REQUIRED/);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).title, f.project.title);
  assert.equal(await readAdminRecordReceipt(db, admin.session, input.commandId), null);
  assert.equal(await db.auditLog.count({ where: { id: `admin-record:${input.commandId}` } }), 0);
  const target = await syntheticPerson(db, 'Account per rifiuto differito', 'consulente');
  const before = await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } });
  const accountInput = { commandId: randomUUID(), operation: 'DEACTIVATE', userId: target.user.id, expectedVersion: adminUserVersion(before) };
  await assert.rejects(executeAdminUserCommand(failing, admin.session, accountInput, {}, proof()), /ADMIN_REVISION_ATOMIC_AUDIT_REQUIRED/);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).active, true);
  assert.equal((await db.internalSession.findUniqueOrThrow({ where: { id: target.session.sessionId! } })).revokedAt, null);
  assert.equal(await reconcileAdminUserCommand(db, admin.session, accountInput), null);
});

test('the database rejects revision tampering and unauthorized journal writers', options, async () => {
  const f = await fixture(), input = await command('Project', f.project.id, { title: 'Prova immutabile' }); await save(input);
  await assert.rejects(db.adminRecordRevision.update({ where: { commandId: input.commandId }, data: { reason: 'Alterazione vietata' } }));
  await assert.rejects(db.adminRecordRevision.delete({ where: { commandId: input.commandId } }));
  await assert.rejects(db.auditLog.update({ where: { id: `admin-record:${input.commandId}` }, data: { after: {} } }), /ADMIN_COMMAND_AUDIT_RETAINED/);
  await assert.rejects(db.auditLog.delete({ where: { id: `admin-record:${input.commandId}` } }), /ADMIN_COMMAND_AUDIT_RETAINED/);
  await assert.rejects(db.$executeRaw`TRUNCATE TABLE "AuditLog"`, /ADMIN_COMMAND_AUDIT_RETAINED|foreign key|cannot be truncated/i);
  for (const invalid of [{}, { id: null }, { id: 12 }]) {
    await assert.rejects(db.adminRecordRevision.create({ data: { commandId: randomUUID(), actorId: admin.user.id, sessionId: admin.session.sessionId!,
      model: 'Project', recordId: f.project.id, operation: 'RECTIFY', requestHash: 'a'.repeat(64), beforeHash: 'a'.repeat(64), afterHash: 'a'.repeat(64),
      before: invalid as Prisma.InputJsonObject, after: invalid as Prisma.InputJsonObject, reason: 'Identità della prova assente' } }), /check constraint/i);
  }
  const technician = await syntheticPerson(db, 'Tecnico non autorizzato', 'consulente');
  await assert.rejects(db.adminRecordRevision.create({ data: { commandId: randomUUID(), actorId: technician.user.id, sessionId: technician.session.sessionId!,
    model: 'Project', recordId: f.project.id, operation: 'RECTIFY', requestHash: 'a'.repeat(64), beforeHash: 'a'.repeat(64), afterHash: 'a'.repeat(64),
    before: Prisma.JsonNull, after: Prisma.JsonNull, reason: 'Non consentito' } }));
});

test('document corrections and recoverable deletion preserve the exact original file and all versions', options, async () => {
  const f = await fixture();
  const doc = await db.document.create({ data: { clientId: f.client.id, projectId: f.project.id, type: 'altro', title: 'Documento sintetico',
    fileName: 'synthetic.txt', mimeType: 'text/plain', sizeBytes: 10, checksum: 'a'.repeat(64), storagePath: 'synthetic/not-read.txt', uploadedById: admin.user.id } });
  const version = await db.documentVersion.create({ data: { documentId: doc.id, version: 1, checksum: doc.checksum!, storagePath: doc.storagePath } });
  await save(await command('Document', doc.id, { title: 'Titolo corretto', status: 'da_verificare', validUntil: '2030-10-29T12:00:00.000Z' }));
  assert.equal((await loadAdminRecord(db, admin.session, 'Document', doc.id)).values.status, 'da_verificare');
  await save(await command('Document', doc.id, {}, 'TRASH'));
  assert.equal((await listAdminRecords(db, admin.session, 'Document', doc.id)).rows.length, 0);
  assert.equal((await listAdminRecords(db, admin.session, 'Document', doc.id, 1, true)).rows.length, 1);
  await save(await command('Document', doc.id, {}, 'RESTORE'));
  const restored = await db.document.findUniqueOrThrow({ where: { id: doc.id } });
  assert.equal(restored.deletedAt, null); assert.equal(restored.title, 'Titolo corretto'); assert.equal(restored.status, 'da_verificare');
  assert.equal(restored.checksum, doc.checksum); assert.equal(restored.storagePath, doc.storagePath); assert.equal(restored.uploadedById, doc.uploadedById);
  assert.deepEqual(await db.documentVersion.findUniqueOrThrow({ where: { id: version.id } }), version);
  const manual = await command('Client', randomUUID(), { displayName: 'Anagrafica manuale sintetica', type: 'societa', status: 'attivo' }, 'CREATE');
  await save(manual); const client = await db.client.findUniqueOrThrow({ where: { id: manual.id } });
  assert.equal(client.leadId, null); assert.equal(client.salesOwnerId, null); assert.equal(client.consultantId, null);
});
