'use client';
import { useActionState, useState } from 'react';
import { documentFields, documentFieldLabels, documentKindLabels, type DocumentField, type DocumentCandidates, type DocumentTemplate, type DraftDocumentCommand } from '@/lib/operational-document-contract';
import { saveOperationalTemplateAction, createOperationalDocumentAction, confirmOperationalDocumentAction, createOperationalProformaAction } from '@/lib/operational-document-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
import { useInteractiveReady } from './interactive-ready-marker';

const inputClass = 'w-full rounded-xl border border-slate-300 p-3';
const buttonClass = 'rounded-xl bg-fai-green px-5 py-3 font-bold text-white disabled:opacity-50';
export function OperationalTemplateForm({ templateId: initialTemplateId, commandId: initialCommandId, current: initialCurrent, duplicateFrom }: { templateId: string; commandId: string; current: DocumentTemplate | null; duplicateFrom?: string }) {
  const ready = useInteractiveReady();
  const [templateId] = useState(initialTemplateId), [commandId] = useState(initialCommandId), [current] = useState(initialCurrent);
  const [title, setTitle] = useState(current ? current.title + (duplicateFrom ? ' · copia' : '') : '');
  const [kind, setKind] = useState<DocumentTemplate['kind']>(current?.kind ?? 'CONTRACT');
  const [body, setBody] = useState(current?.body ?? 'Cliente: {{denominazione}}\nSede: {{indirizzo}}\nP.IVA: {{partita_iva}} · CF: {{codice_fiscale}}\nFirmatario: {{firmatario}}\n\nServizio: {{servizio}}\nAttività: {{attivita}}\nImponibile: EUR {{imponibile}}\nIVA: EUR {{iva}}\nTotale: EUR {{totale}}\nRate: {{rate}}');
  const [required, setRequired] = useState<DocumentField[]>(current?.required ?? ['denominazione', 'indirizzo', 'firmatario', 'servizio']);
  const [approved, setApproved] = useState(false);
  const [state, action, pending] = useActionState(saveOperationalTemplateAction, { error: null });
  return <><form action={action} data-interactive-ready={ready}><fieldset disabled={!ready} className="space-y-4">
    <input type="hidden" name="commandId" value={commandId}/><input type="hidden" name="templateId" value={templateId}/>
    <input type="hidden" name="expectedVersion" value={duplicateFrom ? 0 : current?.revision ?? 0}/>
    {duplicateFrom && <input type="hidden" name="sourceTemplateId" value={duplicateFrom}/>}
    <label className="block">Nome modello<input name="title" className={inputClass} value={title} onChange={event => { setTitle(event.target.value); setApproved(false); }} required minLength={3} maxLength={160}/></label>
    <label className="block">Tipo<select name="kind" className={inputClass} value={kind} onChange={event => { setKind(event.target.value as DocumentTemplate['kind']); setApproved(false); }}>
      {Object.entries(documentKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <label className="block">Testo del modello<textarea name="body" className={inputClass} rows={14} maxLength={16000} required value={body} onChange={event => { setBody(event.target.value); setApproved(false); }}/></label>
    <p className="text-sm text-slate-600">Inserisci solo testo aziendale autorizzato e campi variabili. I dati dei clienti vengono inseriti esclusivamente nelle nuove bozze.</p>
    <fieldset className="rounded-xl border p-3"><legend>Campi necessari prima della conferma</legend><div className="grid gap-2 md:grid-cols-3">
      {documentFields.map(field => <label key={field}><input type="checkbox" name="required" value={field} checked={required.includes(field)} onChange={event => { setRequired(current => event.target.checked ? [...current, field] : current.filter(item => item !== field)); setApproved(false); }}/> {documentFieldLabels[field]} <code className="text-xs">{'{{' + field + '}}'}</code></label>)}
    </div></fieldset>
    {!duplicateFrom && current && <label className="block"><input type="checkbox" name="approved" checked={approved} onChange={event => setApproved(event.target.checked)}/> Confermo che il testo è autorizzato e può essere utilizzato dai commerciali sulle proprie schede.</label>}
    {state.error && <p role="alert" className="text-red-700">{state.error}</p>}
    <div className="flex flex-wrap gap-3"><button className={buttonClass} disabled={pending} name="operation" value={duplicateFrom ? 'DUPLICATE' : 'SAVE'}>{pending ? 'Salvataggio…' : duplicateFrom ? 'Duplica come bozza' : 'Salva nuova versione in bozza'}</button>
      {!duplicateFrom && current && <button className={buttonClass} disabled={pending} name="operation" value="PUBLISH">Pubblica modello autorizzato</button>}</div>
  </fieldset></form>{state.stepUpRequired && <InlinePrivilegedConfirmation />}</>;
}
export function OperationalDraftForm({ commandId: initialCommandId, selection, sourceHash, candidates }: { commandId: string; selection: Pick<DraftDocumentCommand, 'context' | 'templateCommandId' | 'serviceRevisionId' | 'contractId'>; sourceHash: string; candidates: DocumentCandidates }) {
  const ready = useInteractiveReady();
  const [commandId] = useState(initialCommandId);
  const [choices, setChoices] = useState(() => Object.fromEntries(documentFields.map(field => [field, candidates[field].length === 1 ? candidates[field][0].value : ''])) as Record<DocumentField, string>);
  const [termsConfirmed, setTermsConfirmed] = useState(false);
  const [state, action, pending] = useActionState(createOperationalDocumentAction, { error: null });
  return <form action={action} data-interactive-ready={ready}><fieldset disabled={!ready} className="space-y-4">
    <input type="hidden" name="commandId" value={commandId}/><input type="hidden" name="sourceHash" value={sourceHash}/>
    <input type="hidden" name="templateCommandId" value={selection.templateCommandId}/>
    {Object.entries(selection.context).map(([name, value]) => <input key={name} type="hidden" name={name} value={value}/>)}
    {selection.serviceRevisionId && <input type="hidden" name="serviceRevisionId" value={selection.serviceRevisionId}/>}
    {selection.contractId && <input type="hidden" name="contractId" value={selection.contractId}/>}
    <div className="grid gap-4 md:grid-cols-2">{documentFields.map(field => <label key={field} className="block">{documentFieldLabels[field]}
      {candidates[field].length > 1 ? <><select className={inputClass} name={field} value={choices[field]} onChange={event => { setChoices(current => ({ ...current, [field]: event.target.value })); setTermsConfirmed(false); }} required>
        <option value="">Conflitto: scegli il dato da usare</option>{candidates[field].map(option => <option key={option.value} value={option.value}>{option.value} — {option.source}</option>)}
      </select><span className="text-sm text-amber-800">Le fonti differiscono: è necessaria una scelta esplicita.</span></> :
        <><input className={inputClass} name={field} value={choices[field]} onChange={event => { setChoices(current => ({ ...current, [field]: event.target.value })); setTermsConfirmed(false); }} readOnly={candidates[field].length === 1} maxLength={5000}/>
          <span className="text-sm text-slate-600">{candidates[field][0]?.source ?? 'Dato mancante: puoi completarlo sul caso. La scheda originale resta invariata.'}</span></>}
    </label>)}</div>
    <label className="block"><input type="checkbox" name="termsConfirmed" checked={termsConfirmed} onChange={event => setTermsConfirmed(event.target.checked)}/> Ho verificato sul caso servizio, imponibile, importo IVA, totale e rate. Le integrazioni indicate sono corrette.</label>
    <p>Puoi salvare una bozza con campi mancanti; la conferma e la proforma richiedono dati completi.</p>
    {state.error && <p role="alert" className="text-red-700">{state.error}</p>}
    <button className={buttonClass} disabled={pending}>{pending ? 'Creazione…' : 'Genera bozza indipendente'}</button>
  </fieldset></form>;
}
export function OperationalDocumentDecisionForm({ documentId, contentHash, commandId: initialCommandId, proforma = false, templates = [] }: { documentId: string; contentHash: string; commandId: string; proforma?: boolean; templates?: { id: string; title: string }[] }) {
  const ready = useInteractiveReady();
  const [commandId] = useState(initialCommandId);
  const [template, setTemplate] = useState(''), [dueDate, setDueDate] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [state, action, pending] = useActionState(proforma ? createOperationalProformaAction : confirmOperationalDocumentAction, { error: null });
  return <form action={action} data-interactive-ready={ready}><fieldset disabled={!ready} className="space-y-3">
    <input type="hidden" name="documentId" value={documentId}/><input type="hidden" name="contentHash" value={contentHash}/><input type="hidden" name="commandId" value={commandId}/>
    {proforma && <><label className="block">Modello proforma approvato<select name="templateCommandId" aria-label="Modello proforma approvato" required className={inputClass} value={template} onChange={event => { setTemplate(event.target.value); setConfirmed(false); }}><option value="">Seleziona modello</option>{templates.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
      <label className="block">Scadenza proforma<input name="dueDate" type="date" required className={inputClass} value={dueDate} onChange={event => { setDueDate(event.target.value); setConfirmed(false); }}/></label></>}
    <label className="block"><input type="checkbox" name="confirmed" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/> {proforma ? 'Confermo dati e scadenza per preparare la proforma.' : 'Ho controllato l’anteprima, i dati, le fonti e le condizioni. Confermo questo documento.'}</label>
    {state.error && <p role="alert" className="text-red-700">{state.error}</p>}
    <button className={buttonClass} disabled={pending}>{pending ? 'Salvataggio…' : proforma ? 'Prepara proforma PDF' : 'Conferma contenuto'}</button>
  </fieldset></form>;
}
