import { listOrdinaryTechnicalDocuments } from '../src/lib/technical-ordinary-documents';
import { readPrivateDocument } from '../src/lib/storage';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { technicalFixture, technicalTarget, assignmentInput, assignTechnical, revokeTechnical } from './technical-assignments/fixtures';
import { readAdminTechnicalDisclosure, saveAdminTechnicalDisclosure, reconcileAdminTechnicalDisclosure } from '../src/lib/admin-technical-disclosure';
import { technicalVersionDisclosureAllowed } from '../src/lib/technical-document-disclosure';
import { readOrdinaryDocument } from '../src/lib/ordinary-document-download';
import { readTechnicalWork, readTechnicalWorkDocument } from '../src/lib/technical-assignment-access';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../src/lib/technical-assignment-service';
import { technicalCollaborationSelection } from '../src/lib/technical-collaboration';
import { currentRecordUpdateUser } from '../src/lib/record-update-context';
import { hasPermission } from '../src/lib/permission-evaluator';
import { readTechnicalAssignmentManagement } from '../src/lib/technical-assignment-management';
import { withTechnicalAssignmentManagementRead } from '../src/lib/technical-assignment-transaction';
import { assertCommunicationTechnicalRecipients } from '../src/lib/communication-contexts';

const enabled = process.env.RUN_TECHNICAL_CONFIDENTIALITY_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
let admin: Person;
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.CI, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
});
after(async () => db.$disconnect());
const fixture = () => technicalFixture(db, admin);
async function command(id: string, classification: 'RESTRICTED' | 'TECHNICAL_CONTENT' = 'RESTRICTED') {
  const view = await readAdminTechnicalDisclosure(db, admin.session, id);
  return { commandId: randomUUID(), id, expectedVersion: view.version, expectedSource: view.sourceSha256,
    classification, assertions: classification === 'RESTRICTED' ? null : {
      noPayments: true, noSignedCustomerContracts: true, noFreeOrInternalNotes: true, reviewedExactVersion: true },
    reason: 'Classificazione della sola prova sintetica', confirmed: true };
}
test('classification is persisted, reopened and reconciled after response loss without a second revision or altered bytes', options, async () => {
  const f = await fixture(), id = f.documents[0].version.id, input = await command(id);
  const before = await db.documentVersion.findUniqueOrThrow({ where: { id } });
  assert.deepEqual(await saveAdminTechnicalDisclosure(db, admin.session, input, leadProof(admin)), { replayed: false });
  assert.deepEqual(await reconcileAdminTechnicalDisclosure(db, admin.session, { commandId: input.commandId, id, close: false }), { status: 'RECORDED' });
  assert.deepEqual(await saveAdminTechnicalDisclosure(db, admin.session, input, leadProof(admin)), { replayed: true });
  const reopened = await readAdminTechnicalDisclosure(db, admin.session, id);
  assert.equal(reopened.current.classification, 'RESTRICTED'); assert.equal(reopened.history.length, 2);
  assert.equal(await db.auditLog.count({ where: { id: 'admin-record:' + input.commandId } }), 1);
  assert.deepEqual(await db.documentVersion.findUniqueOrThrow({ where: { id } }), before);
  await assert.rejects(db.adminRecordRevision.delete({ where: { commandId: input.commandId } }));
  await assert.rejects(db.auditLog.delete({ where: { id: 'admin-record:' + input.commandId } }));
});
test('an unresolved classification can be closed explicitly; a later blind retry cannot apply it', options, async () => {
  const f = await fixture(), id = f.documents[0].version.id, input = await command(id);
  assert.deepEqual(await reconcileAdminTechnicalDisclosure(db, admin.session, { commandId: input.commandId, id, close: false }), { status: 'UNKNOWN' });
  assert.deepEqual(await reconcileAdminTechnicalDisclosure(db, admin.session, { commandId: input.commandId, id, close: true }), { status: 'CLOSED' });
  await assert.rejects(saveAdminTechnicalDisclosure(db, admin.session, input, leadProof(admin)), /CLOSED/);
  assert.equal((await readAdminTechnicalDisclosure(db, admin.session, id)).current.classification, 'TECHNICAL_CONTENT');
});
test('expired Admin step-up, revoked login and changed exact metadata cannot classify a version', options, async () => {
  const f = await fixture(), id = f.documents[0].version.id, input = await command(id);
  await assert.rejects(saveAdminTechnicalDisclosure(db, admin.session, input, leadProof(admin, Math.floor(Date.now() / 1000) - 1801)));
  const login = { user: admin.user, ...await syntheticSession(db, admin.user) };
  await db.internalSession.update({ where: { id: login.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(saveAdminTechnicalDisclosure(db, login.session, input, leadProof(login)));
  await db.document.update({ where: { id: f.documents[0].doc.id }, data: { title: 'Titolo tecnico modificato' } });
  await assert.rejects(saveAdminTechnicalDisclosure(db, admin.session, input, leadProof(admin)), /STALE/);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 0);
});
for (const role of ['consulente', 'backoffice'] as const) test(role + ': unclassified/forbidden versions and personal override grants never expose files or reserved fields', options, async () => {
  const f = await fixture(), person = role === 'consulente' ? f.techA : f.techB, target = technicalTarget(f);
  for (const permission of ['contract.read', 'payment.read', 'audit.read', 'document.download']) {
    await db.userPermissionOverride.create({ data: { userId: person.user.id, permission, allowed: true } });
  }
  const actor = await db.$transaction(tx => currentRecordUpdateUser(tx, person.user.id)); assert(actor);
  for (const permission of ['contract.read', 'payment.read', 'audit.read'] as const) assert.equal(hasPermission(actor, permission), false);
  await assert.rejects(readAdminTechnicalDisclosure(db, person.session, f.documents[0].version.id));
  const unknown = await db.documentVersion.create({ data: { documentId: f.documents[0].doc.id, version: 2,
    storagePath: f.documents[0].version.storagePath, checksum: f.documents[0].version.checksum } });
  assert.equal(await db.$transaction(tx => technicalVersionDisclosureAllowed(tx, actor, f.documents[0].doc, unknown)), false);
  await assignTechnical(db, admin, target, person, { documents: [{ fileId: f.documents[0].version.id, allowDownload: true }] });
  const view = await readTechnicalWork(db, person.session, target);
  for (const note of [f.practice.internalNotes!, f.practice.clientVisibleStatus!, f.contract.serviceName, f.payment.notes!]) assert(!JSON.stringify(view).includes(note));
  assert.deepEqual((await readTechnicalWorkDocument(db, person.session, target, f.documents[0].version.id, true, readPrivateDocument)).bytes, f.documents[0].bytes);
  await assert.rejects(readTechnicalWorkDocument(db, person.session, target, unknown.id, false, readPrivateDocument));
  await assert.rejects(readOrdinaryDocument(db, person.session, f.documents[2].doc.id, f.documents[2].version.id));
  const bad = await assignmentInput(db, admin, target, person);
  if (bad.selection.kind !== 'TechnicalPractice') throw new Error('fixture');
  bad.selection.readableFields.push('integrationRequestNote');
  await assert.rejects(previewTechnicalAssignment(db, admin.session, { ...target, recipientId: person.user.id }, 'ASSIGN', bad));
});
test('all signed client contracts and payment evidence deny technical classification even with neutral file metadata', options, async () => {
  const f = await fixture();
  const signed = await command(f.documents[2].version.id, 'TECHNICAL_CONTENT');
  await assert.rejects(saveAdminTechnicalDisclosure(db, admin.session, signed, leadProof(admin)), /DENIED/);
  await db.payment.update({ where: { id: f.payment.id }, data: { accountingDocumentId: f.documents[0].doc.id } });
  await assert.rejects(saveAdminTechnicalDisclosure(db, admin.session, await command(f.documents[0].version.id, 'TECHNICAL_CONTENT'), leadProof(admin)), /DENIED/);
  // Admin's legitimate master access is separately preserved.
  assert.deepEqual((await readOrdinaryDocument(db, admin.session, f.documents[2].doc.id, f.documents[2].version.id)).bytes, f.documents[2].bytes);
});
test('a restrictive reclassification immediately closes a previously granted version without changing the grant', options, async () => {
  const f = await fixture(), target = technicalTarget(f), doc = f.documents[0];
  const a = await assignTechnical(db, admin, target, f.techA, { documents: [{ fileId: doc.version.id, allowDownload: true }] });
  const before = await db.$queryRaw`SELECT * FROM "TechnicalAssignment" WHERE id=${a.receipt.assignmentId}::uuid`;
  await saveAdminTechnicalDisclosure(db, admin.session, await command(doc.version.id), leadProof(admin));
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, target, doc.version.id, true, readPrivateDocument));
  assert.equal((await readTechnicalWork(db, f.techA.session, target)).documents.length, 0);
  assert.deepEqual(await db.$queryRaw`SELECT * FROM "TechnicalAssignment" WHERE id=${a.receipt.assignmentId}::uuid`, before);
});
test('nominal collaboration is an explicit independent grant; revoke one of three technicians without impersonation or wider scope', options, async () => {
  const f = await fixture(), target = technicalTarget(f), doc = f.documents[0], third = await syntheticPerson(db, 'Terzo tecnico sintetico', 'consulente');
  const first = await assignTechnical(db, admin, target, f.techA, { documents: [{ fileId: doc.version.id, allowDownload: true }] });
  for (const recipient of [f.techB, third]) {
    await assert.rejects(readTechnicalWork(db, recipient.session, target));
    const next = await assignmentInput(db, admin, target, recipient);
    next.selection = technicalCollaborationSelection({ recipientId: f.techA.user.id, revokedAt: null, selection: first.input.selection }, recipient.user.id, new Date());
    const ref = { ...target, recipientId: recipient.user.id }, p = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', next);
    await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', next, p.token, true);
    const view = await readTechnicalWork(db, recipient.session, target);
    assert.equal(view.responsibility, 'supporto');
    assert.deepEqual(view.fields, (await readTechnicalWork(db, f.techA.session, target)).fields);
    assert.deepEqual((await readTechnicalWorkDocument(db, recipient.session, target, doc.version.id, true, readPrivateDocument)).bytes, doc.bytes);
  }
  await revokeTechnical(db, admin, target, f.techB);
  await assert.rejects(readTechnicalWorkDocument(db, f.techB.session, target, doc.version.id, true, readPrivateDocument));
  assert.deepEqual((await readTechnicalWorkDocument(db, third.session, target, doc.version.id, true, readPrivateDocument)).bytes, doc.bytes);
  const practice = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } });
  assert.equal(practice.technicalOwnerId, f.techA.user.id);
});
test('a second canonical technical function restricts an account with a nontechnical financial role despite its old session and financial permissions', options, async () => {
  const f = await fixture(), person = await syntheticPerson(db, 'Profilo finanziario con seconda funzione sintetico', 'amministrazione');
  for (const permission of ['document.download', 'contract.read', 'payment.read']) await db.userPermissionOverride.create({
    data: { userId: person.user.id, permission, allowed: true } });
  const ordinary = await db.$transaction(tx => currentRecordUpdateUser(tx, person.user.id)); assert(ordinary);
  assert.equal(ordinary.technicalRestricted, false);
  assert.equal(hasPermission(ordinary, 'payment.read'), true); assert.equal(hasPermission(ordinary, 'contract.read'), true);
  await db.project.create({ data: { clientId: f.client.id, consultantId: person.user.id, title: 'Seconda funzione tecnica sintetica' } });
  const mixed = await db.$transaction(tx => currentRecordUpdateUser(tx, person.user.id)); assert(mixed);
  assert.equal(mixed.technicalRestricted, true);
  assert.equal(hasPermission(mixed, 'payment.read'), false); assert.equal(hasPermission(mixed, 'contract.read'), false);
  await assert.rejects(readOrdinaryDocument(db, person.session, f.documents[2].doc.id, f.documents[2].version.id));
  await assert.rejects(db.$transaction(tx => assertCommunicationTechnicalRecipients(tx, { to: [person.user.email], cc: [], bcc: [] })));
});
test('unclassified communications reject every known technical address in To, Cc and Bcc, preserving Admin and ordinary Commerciale', options, async () => {
  const f = await fixture();
  for (const person of [f.techA, f.techB]) for (const kind of ['to', 'cc', 'bcc'] as const) {
    await assert.rejects(db.$transaction(tx => assertCommunicationTechnicalRecipients(tx, { to: [], cc: [], bcc: [], [kind]: [person.user.email.toUpperCase()] })));
  }
  await db.$transaction(tx => assertCommunicationTechnicalRecipients(tx, { to: [admin.user.email, f.salesA.user.email], cc: [], bcc: [] }));
});

test('ordinary technical record lists only current classified files; ownership, future versions and stale sessions never substitute for classification', options, async () => {
  for (const role of ['consulente', 'backoffice'] as const) {
    const f = await fixture(), person = role === 'consulente' ? f.techA : f.techB;
    if (role === 'backoffice') {
      await db.client.update({ where: { id: f.client.id }, data: { consultantId: person.user.id } });
      await db.project.update({ where: { id: f.project.id }, data: { consultantId: person.user.id } });
      await db.technicalPractice.update({ where: { id: f.practice.id }, data: { technicalOwnerId: person.user.id } });
    }
    for (const kind of ['Project', 'TechnicalPractice'] as const) {
      const listed = await listOrdinaryTechnicalDocuments(db, person.session, technicalTarget(f, kind));
      assert.equal(listed.limited, false);
      assert.deepEqual(listed.items.map(row => row.versionId).sort(), f.documents.slice(0, 2).map(row => row.version.id).sort());
      assert(!JSON.stringify(listed).includes(f.documents[2].doc.id), 'neutral signed contract metadata is excluded');
      assert(!JSON.stringify(listed).includes('storagePath'));
    }
    const original = f.documents[0];
    await db.documentVersion.create({ data: { documentId: original.doc.id, version: 2, storagePath: original.version.storagePath, checksum: original.version.checksum } });
    const latest = await listOrdinaryTechnicalDocuments(db, person.session, technicalTarget(f));
    assert(!latest.items.some(row => row.id === original.doc.id), 'even identical future bytes require their own exact-version classification');
    await db.internalSession.update({ where: { id: person.session.sessionId! }, data: { revokedAt: new Date() } });
    await assert.rejects(listOrdinaryTechnicalDocuments(db, person.session, technicalTarget(f)), /UNAVAILABLE/);
  }
});


test('management catalog keeps financial bindings private and its longer read budget never extends a session', options, async () => {
  const f = await fixture();
  for (const person of [f.techA, f.techB]) for (const kind of ['Project', 'TechnicalPractice'] as const) {
    const view = await readTechnicalAssignmentManagement(db, admin.session, technicalTarget(f, kind), person.user.id);
    assert(view.documentCatalogueAvailable);
    assert.deepEqual(view.documentOptions.map(row => row.fileId).sort(), f.documents.slice(0, 2).map(row => row.version.id).sort());
    for (const forbidden of [f.documents[2].doc.title, f.documents[2].doc.fileName, f.documents[2].version.id])
      assert(!JSON.stringify(view.documentCatalogue).includes(forbidden));
  }
  // A formerly technical version becomes accounting evidence without any
  // change to its neutral metadata or earlier classification.
  await db.payment.update({ where: { id: f.payment.id }, data: { accountingDocumentId: f.documents[0].doc.id } });
  for (const person of [f.techA, f.techB]) {
    const view = await readTechnicalAssignmentManagement(db, admin.session, technicalTarget(f), person.user.id);
    assert.deepEqual(view.documentOptions.map(row => row.fileId), [f.documents[1].version.id]);
  }
  const read = await withTechnicalAssignmentManagementRead(db, admin.session, 'TechnicalPractice', f.techA.user.id,
    tx => tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM pg_sleep(5.1)`);
  assert.deepEqual(read, [{ ok: 1 }], 'a valid management read may outlast the old five-second default');
  const expiring = { ...admin.session, expiresAt: Math.floor(Date.now() / 1000) + 1 };
  await assert.rejects(withTechnicalAssignmentManagementRead(db, expiring, 'TechnicalPractice', f.techA.user.id,
    tx => tx.$queryRaw`SELECT 1 AS ok FROM pg_sleep(1.2)`), /DENIED/);
});
