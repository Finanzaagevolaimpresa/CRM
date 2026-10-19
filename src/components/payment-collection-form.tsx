'use client';

import Link from 'next/link';
import { useRef, useState, useSyncExternalStore } from 'react';
import { previewPaymentCollectionAction, confirmPaymentCollectionAction, verifyPaymentCollectionAction } from '@/lib/payment-collection-actions';
import type { PaymentCollectionCommand, PaymentCollectionPreview } from '@/lib/payment-collection-contract';

type Setup = { clientId: string; paymentId: string; client: string; contract: string; amount: string;
  reconciliationOnly: boolean; documents: Array<{ id: string; title: string; version: number }> };
const field = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'rounded-xl bg-fai-blue px-5 py-3 font-semibold text-white disabled:opacity-50';
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener); window.addEventListener('fai-payment-collection', listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener('fai-payment-collection', listener); };
}
export function PaymentCollectionForm({ setup }: { setup: Setup }) {
  const [documentVersionId, setDocument] = useState(''), [date, setDate] = useState('');
  const [preview, setPreview] = useState<PaymentCollectionPreview | null>(null);
  const [command, setCommand] = useState<PaymentCollectionCommand | null>(null);
  const [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState(false);
  const [uncertainResponse, setUncertain] = useState(false), [message, setMessage] = useState('');
  const [result, setResult] = useState<{ clientId: string; paymentId: string } | null>(null);
  const busy = useRef(false), commandId = useRef<string | null>(null);
  const key = `fai-payment-collection:${setup.clientId}:${setup.paymentId}`;
  const saved = useSyncExternalStore(subscribe, () => {
    try { const value = sessionStorage.getItem(key); return value && /^[a-f0-9-]{36}$/i.test(value) ? value : null; }
    catch { return null; }
  }, () => null);
  const uncertain = uncertainResponse || Boolean(saved);
  function clear() { try { sessionStorage.removeItem(key); window.dispatchEvent(new Event('fai-payment-collection')); } catch { /* Keep in-memory outcome. */ } }
  function changed() { setPreview(null); setCommand(null); setConfirmed(false); setMessage(''); }
  async function prepare(event: React.FormEvent) {
    event.preventDefault(); if (busy.current || uncertain || setup.reconciliationOnly) return;
    const timestamp = new Date(date);
    if (!Number.isFinite(timestamp.getTime())) { setMessage('Inserisci la data e l’ora effettive dell’incasso.'); return; }
    busy.current = true; setPending(true); setConfirmed(false); setMessage('');
    const input: PaymentCollectionCommand = { commandId: crypto.randomUUID(), clientId: setup.clientId,
      paymentId: setup.paymentId, documentVersionId, collectedAt: timestamp.toISOString(), confirmed: true };
    commandId.current = input.commandId;
    try {
      const response = await previewPaymentCollectionAction(input);
      if (response.ok) { setCommand(input); setPreview(response.preview); }
      else { setPreview(null); setMessage(response.message); }
    } catch { setMessage('Riepilogo non disponibile. Nessuna conferma di incasso è stata richiesta.'); }
    finally { busy.current = false; setPending(false); }
  }
  async function save() {
    if (busy.current || uncertain || setup.reconciliationOnly || !preview || !command || !confirmed) return;
    busy.current = true; setPending(true); setMessage('');
    try { sessionStorage.setItem(key, command.commandId); window.dispatchEvent(new Event('fai-payment-collection')); }
    catch {
      setMessage('Il browser non può conservare il riferimento della richiesta. Nessuna conferma è stata inviata; abilita la memoria della sessione e riprova.');
      busy.current = false; setPending(false); return;
    }
    try {
      const response = await confirmPaymentCollectionAction(command, preview.digest);
      if (response.ok) { setResult(response.result); clear(); }
      else { setMessage(response.message); setUncertain(response.uncertain); if (!response.uncertain) { clear(); changed(); setMessage(response.message); } }
    } catch { setUncertain(true); setMessage('La risposta non è arrivata. Verifica l’esito prima di ripetere la conferma.'); }
    finally { busy.current = false; setPending(false); }
  }
  async function verify() {
    const id = saved ?? commandId.current;
    if (busy.current || !id) return;
    busy.current = true; setPending(true);
    try {
      const response = await verifyPaymentCollectionAction(setup.clientId, setup.paymentId, id);
      if (response.ok && response.result) { setResult(response.result); setUncertain(false); clear(); }
      else if (response.ok) { clear(); setUncertain(false); changed(); setMessage('Nessuna registrazione trovata per questa richiesta. Puoi preparare un nuovo riepilogo se la rata è ancora disponibile.'); }
      else setMessage(response.message);
    } catch { setMessage('Verifica non disponibile. Mantieni il comando in sospeso e riprova la verifica.'); }
    finally { busy.current = false; setPending(false); }
  }
  if (result) return <section role="status" className="grid gap-4 rounded-2xl border border-green-300 bg-green-50 p-5">
    <h2 className="text-xl font-bold">Incasso registrato</h2>
    <p>La tua dichiarazione e la versione della prova sono registrate. Puoi ora collegare questa rata al servizio acquistato nel fascicolo.</p>
    <Link className={button} href={`/clients/${result.clientId}#servizi-acquistati`}>Apri servizi acquistati</Link>
  </section>;
  return <div className="grid min-w-0 gap-5">
    {message && <p role="status" className="rounded-xl bg-amber-50 p-4">{message}</p>}
    {uncertain && <div className="grid gap-3"><p>Una conferma precedente è da verificare.</p><button className={button} disabled={pending} onClick={verify}>Verifica esito</button></div>}
    {setup.reconciliationOnly && <p className="rounded-xl bg-blue-50 p-4">Questa rata non è disponibile per una nuova conferma. Puoi verificare l’esito di una richiesta in sospeso oppure tornare all’elenco dei pagamenti.</p>}
    {!setup.reconciliationOnly && <form onSubmit={prepare} aria-label="Conferma incasso" className="grid gap-4">
      <fieldset disabled={pending || uncertain} className="grid min-w-0 gap-4">
        <label className="grid gap-1 font-semibold">Data e ora effettive dell’incasso<input className={field} type="datetime-local" value={date} required onChange={e => { setDate(e.target.value); changed(); }} /></label>
        <div className="grid gap-1 font-semibold"><label htmlFor="collection-proof">Prova dell’incasso</label>
          <select id="collection-proof" className={field} value={documentVersionId} required onChange={e => { setDocument(e.target.value); changed(); }}>
            <option value="">Scegli il documento verificato</option>{setup.documents.map(d => <option key={d.id} value={d.id}>{d.title} · versione {d.version}</option>)}</select></div>
        <button className={button} type="submit" disabled={!setup.documents.length}>Controlla riepilogo</button>
      </fieldset>
    </form>}
    {!setup.reconciliationOnly && preview && <section aria-label="Riepilogo incasso" className="grid gap-4 rounded-2xl border border-fai-blue/30 bg-blue-50 p-5">
      <h2 className="text-xl font-bold">Riepilogo prima della conferma</h2>
      <dl className="grid gap-2 break-words"><div><dt className="font-semibold">Cliente</dt><dd>{preview.client}</dd></div>
        <div><dt className="font-semibold">Incarico</dt><dd>{preview.contract}</dd></div><div><dt className="font-semibold">Rata</dt><dd>€ {preview.amount}</dd></div>
        <div><dt className="font-semibold">Incasso dichiarato</dt><dd>{new Date(preview.collectedAt).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })} · ora italiana</dd></div>
        <div><dt className="font-semibold">Prova</dt><dd>{preview.document} · versione {preview.documentVersion}</dd></div>
        <div><dt className="font-semibold">Progetto</dt><dd>{preview.project ?? 'Fascicolo generale del cliente'}</dd></div></dl>
      <label className="flex items-start gap-3"><input type="checkbox" checked={confirmed} disabled={pending || uncertain} onChange={e => setConfirmed(e.target.checked)} />Dichiaro che l’intero importo di questa rata è stato effettivamente incassato alla data indicata e che la prova scelta è pertinente.</label>
      <p className="text-sm">Il CRM verifica il file e i suoi collegamenti. La dichiarazione dell’incasso è tua; non è una verifica bancaria automatica.</p>
      <p className="text-sm">Serve la <Link className="underline" href="/settings/security">conferma amministrativa personale</Link> attiva.</p>
      <button className={button} disabled={!confirmed || pending || uncertain} onClick={save}>{pending ? 'Registrazione…' : 'Conferma incasso'}</button>
    </section>}
  </div>;
}
