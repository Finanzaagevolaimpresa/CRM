'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import type { readAdminTechnicalDisclosure } from '@/lib/admin-technical-disclosure';
import { saveTechnicalDisclosureAction, reconcileTechnicalDisclosureAction, type TechnicalDisclosureResult } from '@/lib/admin-technical-disclosure-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
type Data = Awaited<ReturnType<typeof readAdminTechnicalDisclosure>>;
const subscribe = () => () => {}, clientReady = () => true, serverReady = () => false;
export function AdminTechnicalDisclosureEditor({ data, commandId: initialCommandId, recovering }: { data: Data; commandId: string; recovering: boolean }) {
  const [commandId] = useState(initialCommandId);
  const [opened] = useState({ id: data.id, version: data.version, source: data.sourceSha256 });
  const sourceChanged = data.id !== opened.id || data.version !== opened.version || data.sourceSha256 !== opened.source;
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady), sending = useRef(false);
  const [classification, setClassification] = useState<'RESTRICTED' | 'TECHNICAL_CONTENT'>('RESTRICTED');
  const [reason, setReason] = useState(''), [verified, setVerified] = useState(false), [confirmed, setConfirmed] = useState(false),
    [closeConfirmed, setCloseConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TechnicalDisclosureResult | null>(recovering ? { ok: false, uncertain: true, message: 'Verifica il tentativo conservato prima di registrare altre scelte.' } : null);
  const frozen = !ready || busy || sourceChanged || !data.canWrite || !!(result?.ok || result?.closed || result?.uncertain);
  const path = '/admin/document-disclosure/' + data.id;
  const preview = data.private ? '/acquired-documents/' + data.documentId + '?version=' + data.id
    : '/documents/' + data.documentId + '/view?versionId=' + data.id;
  function remember() {
    const url = new URL(window.location.href); url.searchParams.set('decision', commandId); window.history.replaceState(window.history.state, '', url);
  }
  async function save() {
    if (frozen || sending.current || !confirmed || classification === 'TECHNICAL_CONTENT' && !verified) return;
    sending.current = true; setBusy(true); remember();
    try {
      const next = await saveTechnicalDisclosureAction({ commandId, id: opened.id, expectedVersion: opened.version, expectedSource: opened.source,
        classification, assertions: classification === 'TECHNICAL_CONTENT' ? { noPayments: true, noSignedCustomerContracts: true,
          noFreeOrInternalNotes: true, reviewedExactVersion: true } : null, reason, confirmed: true });
      setResult(next);
    } catch { setResult({ ok: false, uncertain: true, message: 'Risposta interrotta. Verifica lo stesso tentativo, senza un secondo salvataggio.' }); }
    finally { sending.current = false; setBusy(false); }
  }
  async function reconcile(close = false) {
    if (!ready || sending.current) return; sending.current = true; setBusy(true);
    try { setResult(await reconcileTechnicalDisclosureAction({ commandId, id: data.id, close })); }
    catch { setResult({ ok: false, uncertain: true, message: 'Verifica interrotta. Conserva il riferimento del tentativo.' }); }
    finally { sending.current = false; setBusy(false); }
  }
  return <div className="space-y-5" data-interactive-ready={ready}>
    <p>{data.title} · {data.fileName} · versione {data.documentVersion}</p>
    <p>Classificazione corrente: {data.current.classification === 'TECHNICAL_CONTENT' ? 'Contenuto tecnico verificato' : data.current.classification === 'RESTRICTED' ? 'Riservato ai profili ammessi' : 'Non classificato · negato ai tecnici'}.</p>
    <a className="underline" href={preview} target="_blank" rel="noopener noreferrer">Esamina questa versione</a>
    <p>La classificazione non concede accesso. Destinatario, campi, scadenza e singola versione restano una decisione separata. Contratti firmati dal cliente di qualunque provenienza, pagamenti e note restano esclusi.</p>
    {sourceChanged && !result?.ok && <p role="status">La versione o la classificazione è cambiata. Conserva queste scelte e riapri la versione corrente prima di un nuovo tentativo.</p>}
    {data.prohibited && <p>Il documento presenta un collegamento o metadati riservati: non è ammesso classificarlo come contenuto tecnico.</p>}
    <form onSubmit={e => { e.preventDefault(); void save(); }} className="space-y-4"><fieldset disabled={frozen} className="space-y-4">
      <label className="block">Classificazione<select className="block rounded-lg border p-2" value={classification} onChange={e => { setClassification(e.target.value as typeof classification); setConfirmed(false); }}>
        <option value="RESTRICTED">Riservato · accesso tecnico negato</option>
        <option value="TECHNICAL_CONTENT" disabled={data.prohibited}>Contenuto tecnico verificato della singola versione</option>
      </select></label>
      {classification === 'TECHNICAL_CONTENT' && <label className="block"><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />
        Ho esaminato questa versione completa e i suoi metadati: non contiene pagamenti, riferimenti o ricevute di pagamento, contratti firmati dal cliente, né note libere, comuni o interne. Il nome o l’uso nella pratica non costituisce prova.</label>}
      <label className="block">Motivazione<textarea className="block w-full rounded-lg border p-2" required minLength={3} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <label className="block"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Confermo questa classificazione, senza aggiungere destinatari o versioni.</label>
      <button className="rounded-lg bg-blue-900 px-4 py-3 font-bold text-white" disabled={!confirmed || classification === 'TECHNICAL_CONTENT' && !verified}>Registra classificazione</button>
    </fieldset></form>
    {result && <p role="status">{result.message}</p>}{result?.stepUp && <InlinePrivilegedConfirmation />}
    {result?.uncertain && <section className="space-y-3"><p>Riferimento: {commandId}</p>
      <button className="block underline" disabled={!ready || busy} onClick={() => void reconcile()}>Verifica esito registrato</button>
      <label><input type="checkbox" checked={closeConfirmed} onChange={e => setCloseConfirmed(e.target.checked)} />Chiudi soltanto un tentativo senza effetto registrato.</label>
      <button className="block underline" disabled={!ready || busy || !closeConfirmed} onClick={() => void reconcile(true)}>Riconcilia e chiudi il tentativo</button>
    </section>}
    {(result?.ok || result?.closed) && <a className="block underline" href={path}>Riapri e verifica la classificazione</a>}
    <section><h2 className="font-bold">Cronologia conservata</h2>{data.history.map(row => <p key={row.commandId}>
      Revisione {row.after.revision} · {row.createdAt} · {row.after.classification} · {row.reason}</p>)}</section>
  </div>;
}
