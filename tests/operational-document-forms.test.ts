import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OperationalTemplateForm, OperationalDraftForm, OperationalDocumentDecisionForm } from '../src/components/operational-document-forms';
import { ProformaEmailForm, ProformaArchiveForm } from '../src/components/operational-document-delivery-forms';
import { emptyDocumentCandidates } from '../src/lib/operational-document-contract';

const id = '11111111-1111-4111-8111-111111111111', hash = 'a'.repeat(64);
test('i moduli documento non accettano modifiche o conferme prima che React sia pronto', () => {
  const forms = [
    createElement(OperationalTemplateForm, { templateId: id, commandId: id, current: null }),
    createElement(OperationalDraftForm, { commandId: id, sourceHash: hash, candidates: emptyDocumentCandidates(),
      selection: { context: { leadId: id }, templateCommandId: id, serviceRevisionId: id } }),
    createElement(OperationalDocumentDecisionForm, { documentId: id, contentHash: hash, commandId: id }),
    createElement(ProformaEmailForm, { documentId: id, contentHash: hash, commandId: id, email: 'synthetic@invalid.test',
      mailboxes: [{ id, address: 'sender@invalid.test' }] }),
    createElement(ProformaArchiveForm, { documentId: id, contentHash: hash, commandId: id, pdfSha256: hash, folders: [] }),
  ];
  for (const form of forms) {
    const html = renderToStaticMarkup(form);
    assert.match(html, /<form[^>]*data-interactive-ready="false"/);
    const controls = html.indexOf('<fieldset');
    assert(controls >= 0 && controls < html.indexOf('<input'));
    assert.match(html.slice(controls).split('>')[0], /disabled=""/);
  }
  const email = renderToStaticMarkup(forms[3]);
  assert.match(email, /<select[^>]*name="mailboxId"[^>]*aria-label="Mittente aziendale"/);
});
