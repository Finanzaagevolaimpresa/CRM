import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OperationalTemplateForm, OperationalDraftForm, OperationalDocumentDecisionForm } from '../src/components/operational-document-forms';
import { ProformaEmailForm, ProformaArchiveForm } from '../src/components/operational-document-delivery-forms';
import { emptyDocumentCandidates, documentFieldLabels } from '../src/lib/operational-document-contract';

const id = '11111111-1111-4111-8111-111111111111', hash = 'a'.repeat(64);
test('i moduli documento non accettano modifiche o conferme prima che React sia pronto', () => {
  const candidates = emptyDocumentCandidates();
  candidates.indirizzo = [{ value: 'Via Sintetica 1', source: 'Fonte A' }, { value: 'Via Sintetica 2', source: 'Fonte B' }];
  const forms = [
    createElement(OperationalTemplateForm, { templateId: id, commandId: id, current: null }),
    createElement(OperationalDraftForm, { commandId: id, sourceHash: hash, candidates,
      selection: { context: { leadId: id }, templateCommandId: id, serviceRevisionId: id } }),
    createElement(OperationalDocumentDecisionForm, { documentId: id, contentHash: hash, commandId: id,
      proforma: true, templates: [{ id, title: 'Modello sintetico' }] }),
    createElement(ProformaEmailForm, { documentId: id, contentHash: hash, commandId: id, email: 'synthetic@invalid.test',
      mailboxes: [{ id, address: 'sender@invalid.test' }] }),
    createElement(ProformaArchiveForm, { documentId: id, contentHash: hash, commandId: id, pdfSha256: hash, folders: [{ id, title: 'Fascicolo sintetico' }] }),
  ];
  const labels = [
    ['Tipo', 'Testo del modello'], [documentFieldLabels.indirizzo], ['Modello proforma approvato'],
    ['Mittente aziendale', 'Testo autorizzato per il caso'], ['Cartella del fascicolo', 'Evidenza della verifica'],
  ];
  for (const [index, form] of forms.entries()) {
    const html = renderToStaticMarkup(form);
    assert.match(html, /<form[^>]*data-interactive-ready="false"/);
    const controls = html.indexOf('<fieldset');
    assert(controls >= 0 && controls < html.indexOf('<input'));
    assert.match(html.slice(controls).split('>')[0], /disabled=""/);
    const names = [...html.matchAll(/<(?:select|textarea)\b[^>]*>/g)].map(([tag]) => tag.match(/aria-label="([^"]+)"/)?.[1]);
    assert.deepEqual(names, labels[index], 'Il nome accessibile non deve inglobare opzioni, testo iniziale o istruzioni');
  }
});
