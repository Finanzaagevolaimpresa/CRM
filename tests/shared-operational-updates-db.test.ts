import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { sharedFixture, shareAssignment, sharedInput } from './shared-operational/fixtures';
import { readSharedOperationalPanel, saveSharedOperationalUpdate, settleSharedOperationalReceipt } from '../src/lib/shared-operational-updates';
import { listRecordUpdates, readRecordUpdate } from '../src/lib/record-update-delivery';
import { revokeTechnical } from './technical-assignments/fixtures';
import { previewRecordUpdate, confirmRecordUpdate } from '../src/lib/record-updates';
import { readRecordUpdateSetup } from '../src/lib/record-updates';
import type { UpdateCommand } from '../src/lib/record-update-input';
import type { SharedUpdateCommand, SharedUpdateTarget } from '../src/lib/shared-operational-update-contract';
import { saveRecordProfile } from '../src/lib/record-profiles';
import { personProfileVersion } from '../src/lib/record-profile-contract';
import { withTechnicalAssignmentRecipient, TechnicalAssignmentError } from '../src/lib/technical-assignment-transaction';
const enabled = process.env.RUN_SHARED_OPERATIONAL_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
let admin: Person;
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.CI, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`.then(r => Number(r[0].n)), 76);
  admin = await syntheticAuthority(db);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
});
after(async () => db.$disconnect());
const targetOf = (f: Awaited<ReturnType<typeof sharedFixture>>): SharedUpdateTarget => ({ kind: 'PRACTICE', id: f.practice.id });
const commit = (actor: Person, input: SharedUpdateCommand) => saveSharedOperationalUpdate(db, actor.session, input, actor.user.role === 'admin' ? leadProof(actor) : undefined);
async function fixture() {
  const f = await sharedFixture(db, admin), target = targetOf(f);
  await shareAssignment(db, admin, target, f.tech);
  await shareAssignment(db, admin, target, f.second);
  return { ...f, target };
}
test('one assigned save produces one canonical event, three coherent views and only Admin/current commercial notices', options, async () => {
  const f = await fixture(), input = await sharedInput(db, f.tech, f.target, { state: 'in_progettazione' });
  const saved = await commit(f.tech, input);
  assert.equal(saved.eventId, saved.commandId);
  assert.equal(await db.recordUpdateEvent.count({ where: { kind: 'PRACTICE', recordId: f.practice.id } }), 1);
  for (const target of [f.target, { kind: 'PROJECT', id: f.project.id }, { kind: 'CLIENT', id: f.client.id }] as SharedUpdateTarget[]) {
    const panel = await readSharedOperationalPanel(db, admin.session, target);
    assert.equal(panel.history.length, 1); assert.equal(panel.history[0].eventId, saved.eventId);
    assert.equal(panel.history[0].text, input.text);
  }
  const deliveries = await db.recordUpdateDelivery.findMany({ where: { eventId: saved.eventId } });
  assert.deepEqual(deliveries.map(row => row.recipientId).sort(), [admin.user.id, f.sales.user.id].sort());
  const notices = await listRecordUpdates(db, f.sales.session);
  const notice = notices.find(row => row.recordHref.endsWith(f.practice.id))!;
  assert(notice); assert.equal(notice.readAt, null);
  assert((await readRecordUpdate(db, f.sales.session, notice.id, true))?.readAt);
  assert.equal((await listRecordUpdates(db, f.sales.session)).some(row => row.id === notice.id), false);
  assert.equal(await db.approvedCommunication.count({ where: { updateDeliveryId: { in: deliveries.map(row => row.id) } } }), 0);
});
test('unassigned technician, unrelated commercial and foreign target receive no panel and cannot save', options, async () => {
  const f = await fixture(), input = await sharedInput(db, f.tech, f.target);
  for (const actor of [f.stranger, f.otherSales]) {
    await assert.rejects(readSharedOperationalPanel(db, actor.session, f.target));
    await assert.rejects(commit(actor, input));
  }
  await assert.rejects(readSharedOperationalPanel(db, f.tech.session, { kind: 'PRACTICE', id: f.sibling.id }));
  await assert.rejects(readSharedOperationalPanel(db, f.tech.session, { kind: 'CLIENT', id: f.client.id }));
  assert.equal(await db.sharedOperationalUpdate.count({ where: { clientId: f.client.id } }), 0);
});
test('two nominal technical roles append separate authors without changing responsibility or personal acceptance', options, async () => {
  const f = await fixture();
  for (const actor of [f.tech, f.second]) await commit(actor, await sharedInput(db, actor, f.target));
  const rows = await db.sharedOperationalUpdate.findMany({ where: { practiceId: f.practice.id } });
  assert.deepEqual(rows.map(row => row.authorId).sort(), [f.tech.user.id, f.second.user.id].sort());
  assert(rows.every(row => row.assignmentRevisionId));
  assert.equal((await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } })).technicalOwnerId, f.tech.user.id);
});
test('practice approval never changes its sibling, Client lifecycle, Lead, contract or payment', options, async () => {
  const f = await fixture();
  const before = await Promise.all([db.client.findUnique({ where: { id: f.client.id } }), db.lead.findUnique({ where: { id: f.lead.id } }),
    db.technicalPractice.findUnique({ where: { id: f.sibling.id } }), db.contract.findUnique({ where: { id: f.contract.id } }), db.payment.findUnique({ where: { id: f.payment.id } })]);
  await commit(f.tech, await sharedInput(db, f.tech, f.target, { state: 'approvata' }));
  const after = await Promise.all([db.client.findUnique({ where: { id: f.client.id } }), db.lead.findUnique({ where: { id: f.lead.id } }),
    db.technicalPractice.findUnique({ where: { id: f.sibling.id } }), db.contract.findUnique({ where: { id: f.contract.id } }), db.payment.findUnique({ where: { id: f.payment.id } })]);
  assert.deepEqual(after, before);
});
test('Admin client operational transition is distinct from lifecycle and a commercial is read-only', options, async () => {
  const f = await fixture(), target: SharedUpdateTarget = { kind: 'CLIENT', id: f.client.id };
  await commit(admin, await sharedInput(db, admin, target, { state: 'in_attesa_cliente' }));
  const client = await db.client.findUniqueOrThrow({ where: { id: f.client.id } });
  assert.equal(client.operationalState, 'in_attesa_cliente'); assert.equal(client.status, 'attivo');
  const view = await readSharedOperationalPanel(db, f.sales.session, target);
  assert.equal(view.canWrite, false);
  await assert.rejects(commit(f.sales, await sharedInput(db, f.sales, target)));
});
test('canonical contact projection distinguishes companies, administrator, actual contact and Lead origin without private fields', options, async () => {
  const f = await fixture(), panel = await readSharedOperationalPanel(db, f.tech.session, f.target);
  assert.equal(panel.contacts.companies.length, 1);
  const c = panel.contacts.companies[0];
  assert.equal(c.id, f.company.id); assert.equal(c.sdiCode, 'SYN0001');
  assert.equal(c.legalPostalCode, '00001'); assert.equal(c.operatingPostalCode, '00002');
  assert.equal(c.people.find(p => p.isAdministrator)?.person.id, f.administrator.id);
  assert.equal(c.people.find(p => p.isOperationalContact)?.person.id, f.contact.id);
  assert.equal(panel.contacts.lead?.id, f.lead.id);
  const text = JSON.stringify(panel);
  for (const forbidden of ['PRIVATE_', 'totalAmount', 'totalInvestment', 'ownershipPercent', 'internalNotes', 'signedDocumentId'])
    assert(!text.includes(forbidden), forbidden);
  assert.equal((await readSharedOperationalPanel(db, admin.session, { kind: 'CLIENT', id: f.client.id })).contacts.companies.length, 2);
});

test('canonical profile edits persist SDI, structured addresses and explicit contact membership; old forms preserve new values', options, async () => {
  const f = await fixture();
  const companyData = { name: f.company.name, vatNumber: '', taxCode: '', rea: '', pec: '', legalAddress: '', operatingAddress: '',
    region: '', province: '', city: '', legalForm: '', atecoCode: '', atecoDescription: '', incorporationDate: '', activityStartDate: '',
    activityStatus: '', employees: '', annualRevenue: '', durcStatus: '', taxRegime: '', notes: '' };
  await saveRecordProfile(db, admin.session, { kind: 'company', id: f.company.id, expectedVersion: f.company.updatedAt.toISOString(),
    data: { ...companyData, sdiCode: 'upd0001', legalStreet: 'Via canonica sintetica', legalStreetNumber: '12/B', legalPostalCode: '12345',
      legalCity: 'Città canonica', legalProvince: 'XX', operatingStreet: 'Piazza diversa', operatingStreetNumber: '8',
      operatingPostalCode: '54321', operatingCity: 'Altra sede', operatingProvince: 'YY' } });
  const after = await db.company.findUniqueOrThrow({ where: { id: f.company.id } });
  assert.equal(after.sdiCode, 'UPD0001'); assert.equal(after.legalPostalCode, '12345');
  await saveRecordProfile(db, admin.session, { kind: 'company', id: f.company.id, expectedVersion: after.updatedAt.toISOString(), data: companyData });
  const reopened = (await readSharedOperationalPanel(db, f.tech.session, f.target)).contacts.companies[0];
  assert.equal(reopened.sdiCode, 'UPD0001'); assert.equal(reopened.legalStreetNumber, '12/B'); assert.equal(reopened.operatingPostalCode, '54321');
  const link = await db.companyPerson.findFirstOrThrow({ where: { companyId: f.company.id, personId: f.contact.id } });
  const personData = { firstName: f.contact.firstName, lastName: f.contact.lastName, email: f.contact.email, phone: f.contact.phone,
    taxCode: '', notes: '', role: 'Referente operativo canonico', ownershipPercent: '' };
  await saveRecordProfile(db, admin.session, { kind: 'person', id: link.id, companyId: f.company.id,
    expectedVersion: personProfileVersion(f.contact, link), data: { ...personData, isAdministrator: 'false', isOperationalContact: 'true' } });
  const currentPerson = await db.person.findUniqueOrThrow({ where: { id: f.contact.id } });
  const currentLink = await db.companyPerson.findUniqueOrThrow({ where: { id: link.id } });
  await saveRecordProfile(db, admin.session, { kind: 'person', id: link.id, companyId: f.company.id,
    expectedVersion: personProfileVersion(currentPerson, currentLink), data: personData });
  const contact = (await readSharedOperationalPanel(db, f.tech.session, f.target)).contacts.companies[0].people.find(p => p.person.id === f.contact.id)!;
  assert.equal(contact.isAdministrator, false); assert.equal(contact.isOperationalContact, true);
  assert.equal(contact.role, personData.role);
  const latest = await db.company.findUniqueOrThrow({ where: { id: f.company.id } });
  await assert.rejects(saveRecordProfile(db, admin.session, { kind: 'company', id: f.company.id,
    expectedVersion: latest.updatedAt.toISOString(), data: { ...companyData, sdiCode: 'INVALID-LONG' } }));
  assert.deepEqual(await db.company.findUnique({ where: { id: f.company.id } }), latest);
  const audit = await db.auditLog.findMany({ where: { event: 'record_profile_saved', entityId: { in: [f.company.id, link.id] } } });
  assert.equal(audit.length, 4); assert(!JSON.stringify(audit).includes('Via canonica sintetica'));
});

test('project updates preserve the role ceiling and permit the explicitly authorized second technician', options, async () => {
  const f = await fixture(), target: SharedUpdateTarget = { kind: 'PROJECT', id: f.project.id };
  await assert.rejects(shareAssignment(db, admin, target, f.second));
  await db.userPermissionOverride.create({ data: { userId: f.second.user.id, permission: 'project.write', allowed: true } });
  for (const actor of [f.tech, f.second]) {
    await shareAssignment(db, admin, target, actor);
    await commit(actor, await sharedInput(db, actor, target, { state: 'in_analisi' }));
  }
  const rows = await db.sharedOperationalUpdate.findMany({ where: { kind: 'PROJECT', recordId: f.project.id } });
  assert.deepEqual(rows.map(row => row.authorId).sort(), [f.tech.user.id, f.second.user.id].sort());
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).consultantId, f.tech.user.id);
  assert.equal((await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } })).status, f.practice.status);
  assert.equal((await readSharedOperationalPanel(db, f.sales.session, target)).history.length, 2);
});
test('missing company/contact/address facts do not prevent a typed operational update', options, async () => {
  const f = await fixture();
  await db.project.update({ where: { id: f.project.id }, data: { companyId: null } });
  // Reconfirm the changed canonical context through the ordinary signed path.
  await shareAssignment(db, admin, f.target, f.tech);
  await db.company.updateMany({ where: { clientId: f.client.id }, data: { deletedAt: new Date() } });
  const view = await readSharedOperationalPanel(db, f.tech.session, f.target);
  assert.equal(view.contacts.companies.length, 0);
  assert((await commit(f.tech, await sharedInput(db, f.tech, f.target))).eventId);
});
test('title and status not selected in the assignment are not disclosed by the new panel/history', options, async () => {
  const f = await fixture();
  await commit(admin, await sharedInput(db, admin, f.target, { state: 'in_progettazione' }));
  await shareAssignment(db, admin, f.target, f.tech, { title: false, status: false, readStatus: false });
  const view = await readSharedOperationalPanel(db, f.tech.session, f.target);
  assert.equal(view.title, 'Incarico tecnico'); assert.equal(view.currentState, null);
  assert.equal(view.history[0].sourceLabel, 'Incarico tecnico'); assert.equal(view.history[0].stateAfter, null);
  assert.equal(view.states.length, 0);
  await assert.rejects(commit(f.tech, await sharedInput(db, f.tech, f.target, { state: 'approvata' })));
});
test('revocation with a form open denies saving and reading, while receipt reconciliation stays opaque', options, async () => {
  const f = await fixture(), input = await sharedInput(db, f.tech, f.target);
  await revokeTechnical(db, admin, { kind: 'TechnicalPractice', targetId: f.practice.id }, f.tech);
  await assert.rejects(commit(f.tech, input)); await assert.rejects(readSharedOperationalPanel(db, f.tech.session, f.target));
  const outcome = await settleSharedOperationalReceipt(db, f.tech.session, { commandId: input.commandId, target: f.target });
  assert.equal(outcome.status, 'CLOSED_WITHOUT_UPDATE');
  assert.equal(await db.sharedOperationalUpdate.count({ where: { practiceId: f.practice.id } }), 0);
});
test('commercial reassignment invalidates an open command and removes the old recipient access', options, async () => {
  const f = await fixture(), input = await sharedInput(db, admin, f.target);
  const first = await commit(f.tech, await sharedInput(db, f.tech, f.target));
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { commercialOwnerId: f.otherSales.user.id } });
  await assert.rejects(commit(admin, input)); await assert.rejects(readSharedOperationalPanel(db, f.sales.session, f.target));
  assert.equal((await listRecordUpdates(db, f.sales.session)).some(row => row.recordHref.endsWith(f.practice.id)), false);
  assert(await db.sharedOperationalUpdate.findUnique({ where: { id: first.commandId } }));
});
test('double click, replay and response loss retain exactly one event and immutable payload', options, async () => {
  const f = await fixture(), input = await sharedInput(db, f.tech, f.target);
  await Promise.allSettled([commit(f.tech, input), commit(f.tech, input)]);
  const outcome = await settleSharedOperationalReceipt(db, f.tech.session, { commandId: input.commandId, target: f.target });
  assert.equal(outcome.status, 'RECORDED');
  assert.equal((await commit(f.tech, input)).replayed, true);
  await assert.rejects(commit(f.tech, { ...input, text: 'Payload differente' }));
  assert.equal(await db.sharedOperationalUpdate.count({ where: { practiceId: f.practice.id } }), 1);
  assert.equal(await db.recordUpdateEvent.count({ where: { recordId: f.practice.id } }), 1);
});
test('concurrent save and settlement leave one committed event or one durable closure, never both', options, async () => {
  const f = await fixture(), input = await sharedInput(db, f.tech, f.target);
  await Promise.allSettled([commit(f.tech, input), settleSharedOperationalReceipt(db, f.tech.session, { commandId: input.commandId, target: f.target })]);
  const result = await settleSharedOperationalReceipt(db, f.tech.session, { commandId: input.commandId, target: f.target });
  const command = await db.recordUpdateCommand.findUniqueOrThrow({ where: { id: input.commandId } });
  assert.equal(await db.sharedOperationalUpdate.count({ where: { id: input.commandId } }), result.status === 'RECORDED' ? 1 : 0);
  assert.equal(command.operation, result.status === 'RECORDED' ? 'UPDATE' : 'CLOSE_ATTEMPT');
  if (result.status !== 'RECORDED') await assert.rejects(commit(f.tech, input));
});
test('concurrent different updates detect version conflict and allow a fresh deliberate continuation', options, async () => {
  const f = await fixture(), a = await sharedInput(db, f.tech, f.target), b = await sharedInput(db, f.second, f.target);
  const results = await Promise.allSettled([commit(f.tech, a), commit(f.second, b)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const second = results[0].status === 'fulfilled' ? f.second : f.tech;
  await commit(second, await sharedInput(db, second, f.target));
  assert.equal(await db.sharedOperationalUpdate.count({ where: { practiceId: f.practice.id } }), 2);
});
test('correction is append-only, maintains original author/time and denies another technician rectifying it', options, async () => {
  const f = await fixture(), saved = await commit(f.tech, await sharedInput(db, f.tech, f.target));
  await assert.rejects(commit(f.second, await sharedInput(db, f.second, f.target, { correctionOfId: saved.commandId })));
  const correction = await commit(admin, await sharedInput(db, admin, f.target, { correctionOfId: saved.commandId, text: 'Rettifica motivata sintetica' }));
  const view = await readSharedOperationalPanel(db, admin.session, f.target);
  assert.equal(view.history.length, 2);
  assert.equal(view.history.find(r => r.id === saved.commandId)?.correctedById, correction.commandId);
  await assert.rejects(db.sharedOperationalUpdate.update({ where: { id: saved.commandId }, data: { text: 'false history' } }));
  await assert.rejects(db.auditLog.delete({ where: { id: 'shared-operational:' + saved.commandId } }), /SHARED_OPERATIONAL_AUDIT_RETAINED/);
});
test('failure after event construction rolls back state, command, event, deliveries and audit atomically', options, async () => {
  const f = await fixture(), input = await sharedInput(db, f.tech, f.target, { state: 'approvata' });
  await db.$executeRawUnsafe(`CREATE FUNCTION shared_synthetic_fail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."commandId"='${input.commandId}'::uuid THEN RAISE EXCEPTION 'SYNTHETIC_ROLLBACK'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER shared_synthetic_fail_delivery BEFORE INSERT ON "RecordUpdateDelivery" FOR EACH ROW EXECUTE FUNCTION shared_synthetic_fail_delivery()');
  try { await assert.rejects(commit(f.tech, input), /SYNTHETIC_ROLLBACK/); }
  finally {
    await db.$executeRawUnsafe('DROP TRIGGER shared_synthetic_fail_delivery ON "RecordUpdateDelivery"');
    await db.$executeRawUnsafe('DROP FUNCTION shared_synthetic_fail_delivery()');
  }
  assert.equal(await db.recordUpdateCommand.count({ where: { id: input.commandId } }), 0);
  assert.equal(await db.recordUpdateEvent.count({ where: { id: input.commandId } }), 0);
  assert.equal(await db.auditLog.count({ where: { id: 'shared-operational:' + input.commandId } }), 0);
  assert.equal((await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } })).status, f.practice.status);
});
test('an existing persistent update rule does not duplicate the typed event, while later native changes still notify', options, async () => {
  const f = await fixture(), setup = await readRecordUpdateSetup(db, admin.session, 'PRACTICE', f.practice.id);
  const input: UpdateCommand = { commandId: randomUUID(), kind: 'PRACTICE', recordId: f.practice.id, operation: 'RULE',
    expectedVersion: setup.expectedVersion, ruleVersion: 0, selection: { people: [admin.user.id], groups: [] },
    events: ['STATE_CHANGED'], persistent: false, expiresAt: null, patch: null };
  const preview = await previewRecordUpdate(db, admin.session, input);
  await confirmRecordUpdate(db, admin.session, input, preview.digest, leadProof(admin));
  await commit(f.tech, await sharedInput(db, f.tech, f.target, { state: 'in_progettazione' }));
  assert.equal(await db.recordUpdateEvent.count({ where: { recordId: f.practice.id } }), 1);
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { status: 'documenti_richiesti' } });
  assert.equal(await db.recordUpdateEvent.count({ where: { recordId: f.practice.id } }), 2);
});

test('a deferred completion rejection cannot return a saved receipt and leaves no partial result', options, async () => {
  const f = await fixture(), input = await sharedInput(db, f.tech, f.target);
  // Simulate a missing audit component, after the normal insertion path.
  await db.$executeRawUnsafe(`CREATE FUNCTION shared_synthetic_incomplete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='shared-operational:${input.commandId}' THEN NEW."after"=NEW."after"-'mode'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER shared_synthetic_incomplete_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION shared_synthetic_incomplete_audit()');
  try { await assert.rejects(commit(f.tech, input), /SHARED_OPERATIONAL_ATOMIC_RESULT_REQUIRED/); }
  finally {
    await db.$executeRawUnsafe('DROP TRIGGER shared_synthetic_incomplete_audit ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION shared_synthetic_incomplete_audit()');
  }
  assert.equal(await db.sharedOperationalUpdate.count({ where: { id: input.commandId } }), 0);
  assert.equal(await db.recordUpdateCommand.count({ where: { id: input.commandId } }), 0);
  assert.equal(await db.recordUpdateEvent.count({ where: { id: input.commandId } }), 0);
  assert.equal(await db.recordUpdateDelivery.count({ where: { eventId: input.commandId } }), 0);
  assert.equal((await settleSharedOperationalReceipt(db, f.tech.session, { commandId: input.commandId, target: f.target })).status, 'CLOSED_WITHOUT_UPDATE');
});
test('explicit permission denial and revoked session remain server-side ceilings', options, async () => {
  const f = await fixture(), input = await sharedInput(db, f.tech, f.target);
  await db.userPermissionOverride.create({ data: { userId: f.tech.user.id, permission: 'technical.write', allowed: false } });
  await assert.rejects(commit(f.tech, input)); await assert.rejects(readSharedOperationalPanel(db, f.tech.session, f.target));
  const revoked = await sharedInput(db, f.second, f.target);
  await db.internalSession.update({ where: { id: f.second.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(commit(f.second, revoked));
  await assert.rejects(settleSharedOperationalReceipt(db, f.second.session, { commandId: revoked.commandId, target: f.target }));
});
test('assignment expiry while a form is open denies both reading and writing', options, async () => {
  const f = await fixture(), expiry = new Date(Date.now() + 6000);
  await shareAssignment(db, admin, f.target, f.tech, { expiresAt: expiry.toISOString() });
  const input = await sharedInput(db, f.tech, f.target);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry.getTime() - Date.now() + 30)));
  await assert.rejects(commit(f.tech, input));
  await assert.rejects(readSharedOperationalPanel(db, f.tech.session, f.target));
  assert.equal(await db.sharedOperationalUpdate.count({ where: { practiceId: f.practice.id } }), 0);
});
test('shared technical transaction budget exceeds five seconds without extending session validity', options, async () => {
  const f = await fixture();
  const started = Date.now();
  const userId = await withTechnicalAssignmentRecipient(db, f.tech.session, 'TechnicalPractice', async (tx, state) => {
    await tx.$executeRaw`SELECT pg_sleep(6)`;
    return state.current.userId;
  }, { timeout: 30_000 });
  assert.equal(userId, f.tech.user.id); assert(Date.now() - started >= 6000);
  const expiring = { ...f.tech.session, expiresAt: Math.floor(Date.now() / 1000) + 4 };
  let entered = false;
  await assert.rejects(withTechnicalAssignmentRecipient(db, expiring, 'TechnicalPractice', async tx => {
    entered = true;
    await tx.$executeRaw`SELECT pg_sleep(6)`;
  }, { timeout: 30_000 }), error => error instanceof TechnicalAssignmentError && error.code === 'DENIED');
  assert(entered, 'the session must be admitted before expiring inside the bounded transaction');
  assert.equal(await db.sharedOperationalUpdate.count({ where: { practiceId: f.practice.id } }), 0);
});
test('Admin proof is mandatory and a known closed attempt never becomes a later save', options, async () => {
  const f = await fixture(), input = await sharedInput(db, admin, f.target);
  await assert.rejects(saveSharedOperationalUpdate(db, admin.session, input));
  const result = await settleSharedOperationalReceipt(db, admin.session, { commandId: input.commandId, target: f.target });
  assert.equal(result.status, 'CLOSED_WITHOUT_UPDATE');
  await assert.rejects(commit(admin, input));
  const other = await syntheticPerson(db, 'Altro Admin sintetico');
  await assert.rejects(settleSharedOperationalReceipt(db, other.session, { commandId: input.commandId, target: f.target }));
});
