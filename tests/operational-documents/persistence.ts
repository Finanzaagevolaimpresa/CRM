import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { documentFixture } from './fixture';
import { clientProof } from '../selective-clients/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { confirmOperationalDocument, createOperationalDocument, createOperationalProforma, listOperationalTemplates, operationalDocumentOptions, prepareOperationalDocument,
  readOperationalDocument, saveOperationalTemplate, searchOperationalDocumentClient } from '../../src/lib/operational-documents';
import { renderOperationalPdf } from '../../src/lib/operational-document-pdf';
import { revokeInternalSession } from '../../src/lib/internal-session-registry';
import { emptyDocumentCandidates, resolveDocumentFields } from '../../src/lib/operational-document-contract';
import { convertUnlinkedLeadToClient } from '../../src/lib/lead-client-access';
import { actualDocumentPdfRoute } from './action-harness';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1', options = { skip: !enabled };
before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
after(() => db.$disconnect());

test('pubblicazione, copia e nuove bozze conservano modelli, clienti e fonti indipendenti', options, async () => {
  const f = await documentFixture(db), first = await f.create(), before = await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId: f.publication.commandId } });
  const duplicate = { ...f.template, commandId: randomUUID(), templateId: randomUUID(), sourceTemplateId: f.template.templateId, operation: 'DUPLICATE', title: 'Copia sintetica' };
  // HTML multipart submissions normalize textarea line endings to CRLF.
  const form = new FormData(); form.set('body', duplicate.body);
  const submitted = await new Request('http://localhost', { method: 'POST', body: form }).formData();
  const submittedBody = String(submitted.get('body')); assert(submittedBody.includes('\r\n'));
  await saveOperationalTemplate(db, f.admin.session, { ...duplicate, body: submittedBody }, clientProof(f.admin));
  assert.deepEqual(await saveOperationalTemplate(db, f.admin.session, duplicate, clientProof(f.admin)), { id: duplicate.templateId, replay: true });
  await assert.rejects(saveOperationalTemplate(db, f.admin.session, { ...duplicate, commandId: randomUUID(), templateId: randomUUID(),
    body: submittedBody + '\r\nModifica effettiva del testo.' }, clientProof(f.admin)), /STALE/);
  const changed = await db.lead.update({ where: { id: f.lead.id }, data: { email: 'second@invalid.test' } });
  const second = await f.create(); assert.notEqual(second.id, first.id);
  const a = await readOperationalDocument(db, f.owner.session, first.id), b = await readOperationalDocument(db, f.owner.session, second.id);
  assert.equal(a.snapshot.fields.email, 'synthetic@invalid.test'); assert.equal(b.snapshot.fields.email, changed.email);
  assert.deepEqual(await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId: f.publication.commandId } }), before);
  assert.equal((await listOperationalTemplates(db, f.owner.session)).some(row => row.id === duplicate.templateId), false);
  const anotherLead = await db.lead.create({ data: { firstName: 'Altro', lastName: 'Contatto', companyName: 'Cliente B sintetico', assignedToId: f.owner.user.id } });
  const selection = { ...f.selection, context: { leadId: anotherLead.id } }, next = await prepareOperationalDocument(db, f.owner.session, selection);
  const choices = resolveDocumentFields(next.candidates, {}).values;
  Object.assign(choices, { indirizzo: 'Via Altro Caso 2', partita_iva: '98765432109', firmatario: 'Firmatario B', rate: 'Saldo unico' });
  const another = await createOperationalDocument(db, f.owner.session, { commandId: randomUUID(), ...selection, sourceHash: next.sourceHash, choices, termsConfirmed: true });
  const independent = await readOperationalDocument(db, f.owner.session, another.id);
  assert.equal(independent.snapshot.fields.email, ''); assert.equal(independent.snapshot.fields.denominazione, 'Cliente B sintetico');
  assert(!independent.row.content.includes(f.company.name)); assert(!JSON.stringify(independent.snapshot).includes(f.lead.email!));
});
test('generazione ripetuta riconciliata; payload diverso con stesso comando respinto', options, async () => {
  const f = await documentFixture(db), input = await f.input(), first = await createOperationalDocument(db, f.owner.session, input);
  const repeat = await createOperationalDocument(db, f.owner.session, input); assert.equal(first.id, repeat.id); assert(repeat.replay);
  await assert.rejects(createOperationalDocument(db, f.owner.session, { ...input, termsConfirmed: false }));
  assert.equal(await db.operationalDocument.count({ where: { id: input.commandId } }), 1);
});
test('scelta conflittuale, dati mancanti, condizioni assenti e tariffe manomesse bloccano la conferma', options, async () => {
  const f = await documentFixture(db);
  await db.company.update({ where: { id: f.company.id }, data: { name: 'Denominazione diversa sintetica' } });
  const input = await f.input();
  await assert.rejects(createOperationalDocument(db, f.owner.session, { ...input, choices: { ...input.choices, denominazione: '' } }));
  await assert.rejects(createOperationalDocument(db, f.owner.session, { ...input, choices: { ...input.choices, totale: '1.00' } }));
  const unresolved = await f.create({ choices: { ...input.choices, rate: '' }, termsConfirmed: false });
  const row = await db.operationalDocument.findUniqueOrThrow({ where: { id: unresolved.id } });
  await assert.rejects(confirmOperationalDocument(db, f.owner.session, { commandId: randomUUID(), documentId: row.id, contentHash: row.contentHash, confirmed: true }));
  assert.equal(await db.operationalDocumentDecision.count({ where: { documentId: row.id } }), 0);
});
test('riassegnazione, tecnico, diniego esplicito e sessione revocata negano anche PDF e comandi già preparati', options, async () => {
  const f = await documentFixture(db), draft = await f.create(), input = await f.input();
  await assert.rejects(readOperationalDocument(db, f.other.session, draft.id));
  await assert.rejects(readOperationalDocument(db, f.technical.session, draft.id));
  await assert.rejects(saveOperationalTemplate(db, f.owner.session, { ...f.template, commandId: randomUUID(), templateId: randomUUID() }, clientProof(f.owner)));
  const storedBefore = await db.operationalDocument.findUniqueOrThrow({ where: { id: draft.id } });
  const clientDenied = await db.userPermissionOverride.create({ data: { userId: f.owner.user.id, permission: 'client.read', allowed: false } });
  await assert.rejects(operationalDocumentOptions(db, f.owner.session, f.selection.context), /DENIED/);
  await assert.rejects(f.prepare(), /DENIED/);
  await assert.rejects(createOperationalDocument(db, f.owner.session, input), /DENIED/);
  await assert.rejects(readOperationalDocument(db, f.owner.session, draft.id), /DENIED/);
  await assert.rejects(searchOperationalDocumentClient(db, f.owner.session, f.company.vatNumber!), /DENIED/);
  assert.equal(await db.operationalDocument.count({ where: { leadId: f.lead.id } }), 1);
  assert.deepEqual(await db.operationalDocument.findUniqueOrThrow({ where: { id: draft.id } }), storedBefore);
  await db.userPermissionOverride.update({ where: { id: clientDenied.id }, data: { allowed: true } });
  assert.equal((await readOperationalDocument(db, f.owner.session, draft.id)).row.id, draft.id);
  await db.lead.update({ where: { id: f.lead.id }, data: { assignedToId: f.other.user.id } });
  await assert.rejects(readOperationalDocument(db, f.owner.session, draft.id));
  await assert.rejects(createOperationalDocument(db, f.owner.session, input));
  await db.lead.update({ where: { id: f.lead.id }, data: { assignedToId: f.owner.user.id } });
  await db.userPermissionOverride.create({ data: { userId: f.owner.user.id, permission: 'contract.read', allowed: false } });
  await assert.rejects(readOperationalDocument(db, f.owner.session, draft.id));
  await db.$transaction(tx => revokeInternalSession(tx, f.admin.session.sessionId!, 'INTERNAL_SINGLE', f.admin.user.id));
  await assert.rejects(readOperationalDocument(db, f.admin.session, draft.id));
});
test('cambio di cliente del lead non espone lo snapshot del precedente cliente', options, async () => {
  const f = await documentFixture(db), draft = await f.create();
  const nextClient = await db.client.create({ data: { type: 'societa', displayName: 'Altro cliente sintetico', salesOwnerId: f.owner.user.id } });
  await db.lead.update({ where: { id: f.lead.id }, data: { clientId: nextClient.id } });
  await assert.rejects(readOperationalDocument(db, f.owner.session, draft.id));
});

test('conversione nativa mantiene elenco cliente, storia e PDF esatti del lead e prosegue la proforma senza riscrivere snapshot', options, async () => {
  const f = await documentFixture(db, undefined, { unlinked: true }), draft = await f.create();
  const created = await readOperationalDocument(db, f.owner.session, draft.id);
  await confirmOperationalDocument(db, f.owner.session, { commandId: randomUUID(), documentId: draft.id, contentHash: created.row.contentHash, confirmed: true });
  const input = { commandId: randomUUID(), documentId: draft.id, contentHash: created.row.contentHash,
    templateCommandId: f.proformaPublication.commandId, dueDate: '2027-05-31', confirmed: true };
  const prepared = await createOperationalProforma(db, f.owner.session, input);
  const before = await readOperationalDocument(db, f.owner.session, draft.id), oldProforma = await readOperationalDocument(db, f.owner.session, prepared.id);
  const route = actualDocumentPdfRoute(db, f.owner.session), pdfBefore = await route(draft.id), proformaBefore = await route(prepared.id);
  assert.equal(pdfBefore.status, 200); assert.equal(proformaBefore.status, 200);
  const pdfBytes = Buffer.from(await pdfBefore.arrayBuffer()), proformaBytes = Buffer.from(await proformaBefore.arrayBuffer());
  const converted = await convertUnlinkedLeadToClient(db, f.owner.session, { id: f.lead.id, expectedVersion: f.lead.updatedAt.toISOString(), type: 'societa' });
  assert(converted);
  const client = await db.client.findUniqueOrThrow({ where: { id: converted.id } });
  assert.equal(client.leadId, f.lead.id); assert.equal((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).clientId, client.id);
  const after = await readOperationalDocument(db, f.owner.session, draft.id), afterProforma = await readOperationalDocument(db, f.owner.session, prepared.id);
  assert.equal(after.clientId, client.id); assert.equal(after.row.clientId, null);
  assert.deepEqual(after.row, before.row); assert.deepEqual(after.snapshot, before.snapshot);
  assert.deepEqual(after.decision, before.decision); assert.deepEqual(after.authors, before.authors); assert.deepEqual(after.proformas, before.proformas);
  assert.deepEqual(afterProforma.row, oldProforma.row); assert.deepEqual(afterProforma.snapshot, oldProforma.snapshot);
  for (const context of [{ leadId: f.lead.id }, { clientId: client.id }]) {
    const ids = (await operationalDocumentOptions(db, f.owner.session, context)).documents.map(row => row.id);
    assert(ids.includes(draft.id)); assert(ids.includes(prepared.id));
  }
  assert(pdfBytes.equals(Buffer.from(await (await route(draft.id)).arrayBuffer())));
  assert(proformaBytes.equals(Buffer.from(await (await route(prepared.id)).arrayBuffer())));
  assert.deepEqual(await createOperationalProforma(db, f.owner.session, { ...input, commandId: randomUUID() }), { id: prepared.id, replay: true });
  const next = await createOperationalProforma(db, f.owner.session, { ...input, commandId: randomUUID(), dueDate: '2027-06-30' });
  assert.equal((await readOperationalDocument(db, f.owner.session, next.id)).clientId, client.id);
  assert((await operationalDocumentOptions(db, f.owner.session, { clientId: client.id })).documents.some(row => row.id === next.id));

  await assert.rejects(readOperationalDocument(db, f.other.session, draft.id), /DENIED/);
  await assert.rejects(readOperationalDocument(db, f.technical.session, draft.id), /DENIED/);
  assert.equal((await actualDocumentPdfRoute(db, f.other.session)(prepared.id)).status, 404);
  const denied = await db.userPermissionOverride.create({ data: { userId: f.owner.user.id, permission: 'client.read', allowed: false } });
  await assert.rejects(readOperationalDocument(db, f.owner.session, draft.id), /DENIED/);
  await assert.rejects(operationalDocumentOptions(db, f.owner.session, { clientId: client.id }), /DENIED/);
  assert.equal((await route(prepared.id)).status, 404);
  await db.userPermissionOverride.update({ where: { id: denied.id }, data: { allowed: true } });
  await db.lead.update({ where: { id: f.lead.id }, data: { assignedToId: f.other.user.id } });
  assert.equal((await route(draft.id)).status, 404);
  assert.equal((await operationalDocumentOptions(db, f.owner.session, { clientId: client.id })).documents.length, 0);
  await db.lead.update({ where: { id: f.lead.id }, data: { assignedToId: f.owner.user.id, clientId: f.client.id } });
  await assert.rejects(readOperationalDocument(db, f.owner.session, draft.id), /DENIED/);
  assert.equal((await operationalDocumentOptions(db, f.owner.session, { clientId: client.id })).documents.length, 0);
  assert.equal((await operationalDocumentOptions(db, f.owner.session, { clientId: f.client.id })).documents.length, 0);
  await db.lead.update({ where: { id: f.lead.id }, data: { clientId: client.id } });
  await db.$transaction(tx => revokeInternalSession(tx, f.owner.session.sessionId!, 'INTERNAL_SINGLE', f.admin.user.id));
  assert.equal((await route(draft.id)).status, 404);
  assert.deepEqual(await db.operationalDocument.findUniqueOrThrow({ where: { id: draft.id } }), before.row);
});

test('collegare arbitrariamente il lead a un cliente autorizzato con origine nulla o diversa non trasferisce i documenti', options, async () => {
  const f = await documentFixture(db, undefined, { unlinked: true }), draft = await f.create();
  const anotherLead = await db.lead.create({ data: { firstName: 'Origine', lastName: 'Diversa sintetica', assignedToId: f.owner.user.id } });
  for (const leadId of [null, anotherLead.id]) {
    await db.client.update({ where: { id: f.client.id }, data: { leadId } });
    await db.lead.update({ where: { id: f.lead.id }, data: { clientId: f.client.id } });
    await assert.rejects(readOperationalDocument(db, f.owner.session, draft.id), /DENIED/);
    assert.equal((await actualDocumentPdfRoute(db, f.owner.session)(draft.id)).status, 404);
    assert.equal((await operationalDocumentOptions(db, f.owner.session, { leadId: f.lead.id })).documents.length, 0);
    assert.equal((await operationalDocumentOptions(db, f.owner.session, { clientId: f.client.id })).documents.length, 0);
  }
});
test('modello ripubblicato invalida anteprima ma preserva la bozza precedente', options, async () => {
  const f = await documentFixture(db), draft = await f.create(), input = await f.input();
  await saveOperationalTemplate(db, f.admin.session, { ...f.publication, commandId: randomUUID(), expectedVersion: 2,
    body: f.publication.body + '\nCondizione sintetica aggiornata.' }, clientProof(f.admin));
  await assert.rejects(createOperationalDocument(db, f.owner.session, input));
  assert(!(await readOperationalDocument(db, f.owner.session, draft.id)).row.content.includes('aggiornata'));
});
test('contratto confermato produce un solo PDF proforma per versione e scadenza anche con richieste concorrenti', options, async () => {
  const f = await documentFixture(db), created = await f.create(), source = await readOperationalDocument(db, f.owner.session, created.id);
  const input = { commandId: randomUUID(), documentId: source.row.id, contentHash: source.row.contentHash, templateCommandId: f.proformaPublication.commandId, confirmed: true, dueDate: '2027-01-31' };
  await assert.rejects(prepareOperationalDocument(db, f.owner.session, { ...f.selection, templateCommandId: f.proformaPublication.commandId }));
  await assert.rejects(createOperationalProforma(db, f.owner.session, input));
  await confirmOperationalDocument(db, f.owner.session, { commandId: randomUUID(), documentId: source.row.id, contentHash: source.row.contentHash, confirmed: true });
  const attempts = await Promise.allSettled([createOperationalProforma(db, f.owner.session, input), createOperationalProforma(db, f.owner.session, { ...input, commandId: randomUUID() })]);
  assert(attempts.some(result => result.status === 'fulfilled'));
  const repeat = await createOperationalProforma(db, f.owner.session, input);
  assert.equal(await db.operationalDocument.count({ where: { sourceDocumentId: source.row.id, dueDate: input.dueDate } }), 1);
  const proforma = await readOperationalDocument(db, f.owner.session, repeat.id);
  const pdf = renderOperationalPdf({ title: 'Proforma', content: proforma.row.content, reference: repeat.id, status: 'Documento non fiscale' });
  assert(pdf.toString('ascii').startsWith('%PDF-1.4'));
  assert.equal(proforma.snapshot.fields.totale, source.snapshot.fields.totale);
  assert.equal(proforma.snapshot.fiscalStatus, 'NOT_ISSUED'); assert.equal(proforma.snapshot.deliveryStatus, 'NOT_SENT');
  await assert.rejects(db.operationalDocument.update({ where: { id: source.row.id }, data: { content: 'tampered' } }));
  await assert.rejects(db.operationalDocumentDecision.update({ where: { documentId: source.row.id }, data: { contentHash: '0'.repeat(64) } }));
});
test('ricerca fiscale non rivela schede fuori perimetro e seleziona solo corrispondenze complete', options, async () => {
  const f = await documentFixture(db);
  assert.deepEqual((await searchOperationalDocumentClient(db, f.owner.session, '12345678903')).map(row => row.id), [f.client.id]);
  assert.deepEqual(await searchOperationalDocumentClient(db, f.other.session, '12345678903'), []);
  await assert.rejects(searchOperationalDocumentClient(db, f.owner.session, '12345'));
  await assert.rejects(prepareOperationalDocument(db, f.other.session, f.selection));
  assert.equal(resolveDocumentFields(emptyDocumentCandidates(), {}).values.partita_iva, '');
});

test('fonti anagrafiche e rate mantengono il controllo dei permessi anche dopo il salvataggio', options, async () => {
  const f = await documentFixture(db);
  const contract = await db.contract.create({ data: { clientId: f.client.id, contractNumber: 'SYNTHETIC-' + randomUUID(),
    serviceName: 'Servizio sintetico autorizzato', taxableAmount: 100, vatAmount: 22, totalAmount: 122 } });
  await db.payment.create({ data: { contractId: contract.id, clientId: f.client.id, taxableAmount: 100, vatAmount: 22, totalAmount: 122, dueDate: new Date('2027-03-15T12:00:00Z') } });
  const selection = { context: f.selection.context, templateCommandId: f.publication.commandId, contractId: contract.id };
  await assert.rejects(prepareOperationalDocument(db, f.owner.session, selection));
  const prepared = await prepareOperationalDocument(db, f.admin.session, selection);
  assert.equal(prepared.candidates.rate.length, 1); assert(prepared.candidates.rate[0].value.includes('2027-03-15'));
  const draft = await createOperationalDocument(db, f.admin.session, { commandId: randomUUID(), ...selection, sourceHash: prepared.sourceHash,
    choices: resolveDocumentFields(prepared.candidates, {}).values, termsConfirmed: true });
  const snapshot = (await readOperationalDocument(db, f.admin.session, draft.id)).snapshot;
  assert(snapshot.companySourceIds?.includes(f.company.id)); assert.equal(snapshot.signerSourceIds?.length, 1); assert.equal(snapshot.usesPaymentSchedule, true);
  await assert.rejects(readOperationalDocument(db, f.owner.session, draft.id));
  await db.userPermissionOverride.create({ data: { userId: f.admin.user.id, permission: 'payment.read', allowed: false } });
  assert.deepEqual((await prepareOperationalDocument(db, f.admin.session, selection)).candidates.rate, []);
  await assert.rejects(readOperationalDocument(db, f.admin.session, draft.id));
  const catalogDraft = await f.create();
  await db.userPermissionOverride.create({ data: { userId: f.owner.user.id, permission: 'company.read', allowed: false } });
  assert.deepEqual((await f.prepare()).candidates.firmatario, []);
  await assert.rejects(readOperationalDocument(db, f.owner.session, catalogDraft.id));
});
