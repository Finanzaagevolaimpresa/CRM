import assert from 'node:assert/strict';
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
import { loadAdminRecord, saveAdminRecord, listAdminRecords, readAdminRecordReceipt, closeAdminRecordAttempt,
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
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).notes, 'Nota corretta');
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
test('the database rejects revision tampering and unauthorized journal writers', options, async () => {
  const f = await fixture(), input = await command('Project', f.project.id, { title: 'Prova immutabile' }); await save(input);
  await assert.rejects(db.adminRecordRevision.update({ where: { commandId: input.commandId }, data: { reason: 'Alterazione vietata' } }));
  await assert.rejects(db.adminRecordRevision.delete({ where: { commandId: input.commandId } }));
  const technician = await syntheticPerson(db, 'Tecnico non autorizzato', 'consulente');
  await assert.rejects(db.adminRecordRevision.create({ data: { commandId: randomUUID(), actorId: technician.user.id, sessionId: technician.session.sessionId!,
    model: 'Project', recordId: f.project.id, operation: 'RECTIFY', requestHash: 'a'.repeat(64), beforeHash: 'a'.repeat(64), afterHash: 'a'.repeat(64),
    before: Prisma.JsonNull, after: Prisma.JsonNull, reason: 'Non consentito' } }));
});
