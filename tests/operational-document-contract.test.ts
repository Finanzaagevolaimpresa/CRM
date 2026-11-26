import assert from 'node:assert/strict';
import test from 'node:test';
import { canUseOperationalDocuments, catalogAmounts, documentFields, emptyDocumentCandidates, missingDocumentFields,
  proformaDedupKey, renderDocumentTemplate, resolveDocumentFields, templateTokens, validateDocumentAmounts } from '../src/lib/operational-document-contract';
import { renderOperationalPdf } from '../src/lib/operational-document-pdf';

test('commerciale assegnato è candidato, profili tecnici e diniego individuale restano esclusi', () => {
  assert.equal(canUseOperationalDocuments({ role: 'commerciale', active: true }), true);
  for (const actor of [{ role: 'consulente' }, { role: 'backoffice' }, { role: 'commerciale', technicalRestricted: true },
    { role: 'commerciale', permissionOverrides: [{ permission: 'contract.read', allowed: false }] }, { role: 'admin', active: false }]) {
    assert.equal(canUseOperationalDocuments(actor), false);
  }
});
test('il conflitto richiede scelta, un valore esterno non sostituisce la fonte e il modello non viene contaminato', () => {
  const candidates = emptyDocumentCandidates(); candidates.denominazione = [{ value: 'Azienda A', source: 'Lead' }, { value: 'Azienda B', source: 'Cliente' }];
  assert.deepEqual(resolveDocumentFields(candidates, {}).conflicts, ['denominazione']);
  assert.throws(() => resolveDocumentFields(candidates, { denominazione: 'Azienda C' }), /CONFLICT/);
  const selected = resolveDocumentFields(candidates, { denominazione: 'Azienda B' });
  assert.equal(selected.sources.denominazione, 'Cliente');
  const body = 'Cliente {{denominazione}}';
  assert.equal(renderDocumentTemplate(body, selected.values), 'Cliente Azienda B');
  assert.equal(body, 'Cliente {{denominazione}}');
  const independent = resolveDocumentFields(emptyDocumentCandidates(), { denominazione: 'Azienda C' });
  assert.equal(renderDocumentTemplate(body, independent.values), 'Cliente Azienda C');
  assert.equal(independent.values.email, '');
});
test('campi sconosciuti, template attivi e parentesi malformate sono rifiutati', () => {
  for (const value of ['{{client.secret}}', '{{constructor}}', '{{email}', 'foo {bar}']) assert.throws(() => templateTokens(value), /TEMPLATE/);
  assert.deepEqual(templateTokens('{{denominazione}} {{email}} {{email}}'), ['denominazione', 'email']);
});
test('campi fiscali e importi non si inventano; arrotondamento esatto in centesimi', () => {
  const fields = resolveDocumentFields(emptyDocumentCandidates(), {}).values;
  assert(missingDocumentFields({ required: [] }, fields).includes('codice_fiscale'));
  assert.deepEqual(catalogAmounts('123.45', 2200), { taxable: '123.45', vat: '27.16', total: '150.61' });
  const complete = { ...fields, imponibile: '123.45', iva: '27.16', totale: '150.61' };
  validateDocumentAmounts(complete);
  assert.throws(() => validateDocumentAmounts({ ...complete, totale: '150.62' }), /INVALID_AMOUNT/);
  assert.throws(() => catalogAmounts('1e3', 2200), /INVALID_AMOUNT/);
});
test('proforma unica per documento/versione/scadenza e date impossibili escluse', () => {
  const key = proformaDedupKey('doc-a', 'a'.repeat(64), '2027-02-28');
  assert.equal(key, proformaDedupKey('doc-a', 'a'.repeat(64), '2027-02-28'));
  assert.notEqual(key, proformaDedupKey('doc-a', 'b'.repeat(64), '2027-02-28'));
  assert.notEqual(key, proformaDedupKey('doc-a', 'a'.repeat(64), '2027-03-01'));
  assert.throws(() => proformaDedupKey('doc-a', 'a'.repeat(64), '2027-02-30'));
});
test('PDF passivo multipagina con xref corretto, euro e italiano; nessuna istruzione PDF nel testo', () => {
  const input = { title: 'Proforma società', content: ['È una prova: € 150,61. (test) /JavaScript', ...Array.from({ length: 70 }, (_, i) => 'Riga ' + i)].join('\n'), reference: 'synthetic', status: 'Documento non fiscale' };
  const result = renderOperationalPdf(input), pdf = result.toString('ascii');
  assert(result.equals(renderOperationalPdf(input)));
  assert(pdf.startsWith('%PDF-1.4\n')); assert(pdf.endsWith('%%EOF\n')); assert(pdf.includes('/Count 2'));
  const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]); assert.equal(pdf.slice(xref, xref + 4), 'xref');
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n /gm)].map(match => Number(match[1]));
  offsets.forEach((offset, index) => assert.equal(pdf.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`));
  assert(!pdf.includes('/JavaScript')); assert(pdf.includes('\\200'));
  assert.throws(() => renderOperationalPdf({ ...input, content: '不支持' }), /PDF_CHARACTER/);
});
test('ogni campo ha uno slot distinto nel documento', () => {
  assert.equal(Object.keys(emptyDocumentCandidates()).length, documentFields.length);
});
