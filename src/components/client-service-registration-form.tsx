'use client';

import Link from 'next/link';
import { useRef, useState, useSyncExternalStore } from 'react';
import { previewServiceRegistrationAction, confirmServiceRegistrationAction, verifyServiceRegistrationAction } from '@/lib/client-service-registration-actions';
import type { ServiceRegistrationCommand, ServiceRegistrationPreview } from '@/lib/client-service-registration-contract';

type Setup = {
  client: { id: string; name: string }; catalogs: Array<{ id: string; name: string; code: string }>;
  contracts: Array<{ id: string; label: string }>; payments: Array<{ id: string; contractId: string; label: string }>;
  serviceId: string | null; contractId: string | null; today: string;
};
const field = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'rounded-xl bg-fai-blue px-5 py-3 font-semibold text-white disabled:opacity-50';
function subscribeReceipt(listener: () => void) {
  window.addEventListener('storage', listener); window.addEventListener('fai-service-registration', listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener('fai-service-registration', listener); };
}
export function ClientServiceRegistrationForm({ setup }: { setup: Setup }) {
  const [catalogId, setCatalog] = useState(setup.catalogs.length === 1 ? setup.catalogs[0].id : '');
  const [contractId, setContract] = useState(setup.contractId ?? '');
  const [paymentId, setPayment] = useState(''), [purchasedOn, setPurchased] = useState(setup.today);
  const [preview, setPreview] = useState<ServiceRegistrationPreview | null>(null);
  const [command, setCommand] = useState<ServiceRegistrationCommand | null>(null);
  const [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState(false);
  const [uncertainResponse, setUncertain] = useState(false), [message, setMessage] = useState('');
  const [result, setResult] = useState<{ serviceId: string; clientId: string } | null>(null);
  const commandRef = useRef<string | null>(null), busy = useRef(false);
  const storageKey = `fai-service-registration:${setup.client.id}:${setup.serviceId ?? 'new'}`;
  const storedCommand = useSyncExternalStore(subscribeReceipt, () => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      return saved && /^[a-f0-9-]{36}$/i.test(saved) ? saved : null;
    } catch { return null; }
  }, () => null);
  const uncertain = uncertainResponse || Boolean(storedCommand);
  function clearPendingReceipt() { try { sessionStorage.removeItem(storageKey); window.dispatchEvent(new Event('fai-service-registration')); } catch { /* No persisted form contents. */ } }
  function changed() { setPreview(null); setCommand(null); setConfirmed(false); setMessage(''); }
  async function prepare(event: React.FormEvent) {
    event.preventDefault(); if (busy.current || uncertain) return;
    busy.current = true; setPending(true); setMessage(''); setConfirmed(false);
    const id = crypto.randomUUID(); commandRef.current = id;
    const input: ServiceRegistrationCommand = setup.serviceId
      ? { operation: 'LINK_PAYMENT', commandId: id, clientId: setup.client.id, serviceId: setup.serviceId, paymentId }
      : { operation: 'REGISTER', commandId: id, clientId: setup.client.id, catalogId, contractId, paymentId: paymentId || null, purchasedOn };
    try {
      const response = await previewServiceRegistrationAction(input);
      if (response.ok) { setCommand(input); setPreview(response.preview); }
      else { setPreview(null); setMessage(response.message); }
    } catch { setMessage('Riepilogo non disponibile. Nessun salvataggio è stato richiesto.'); }
    finally { busy.current = false; setPending(false); }
  }
  async function save() {
    if (busy.current || uncertain || !preview || !command || !confirmed) return;
    busy.current = true; setPending(true); setMessage('');
    // Save only the command identifier, before the request, to reconcile a lost
    // response after refresh. Never store names, financial details or documents.
    try { sessionStorage.setItem(storageKey, command.commandId); window.dispatchEvent(new Event('fai-service-registration')); } catch { /* Current command is retained in memory. */ }
    try {
      const response = await confirmServiceRegistrationAction(command, preview.digest);
      if (response.ok) { setResult(response.result); clearPendingReceipt(); }
      else { setMessage(response.message); setUncertain(response.uncertain); if (!response.uncertain) { clearPendingReceipt(); setPreview(null); setCommand(null); } }
    } catch { setUncertain(true); setMessage('La risposta è andata persa. Verifica l’esito prima di riprovare.'); }
    finally { busy.current = false; setPending(false); }
  }
  async function verify() {
    const pendingCommand = storedCommand ?? commandRef.current;
    if (busy.current || !pendingCommand) return;
    busy.current = true; setPending(true);
    try {
      const response = await verifyServiceRegistrationAction(setup.client.id, pendingCommand);
      if (response.ok && response.result) { setResult(response.result); setUncertain(false); clearPendingReceipt(); }
      else if (response.ok) { setMessage('Nessuna registrazione trovata per questa richiesta. Puoi preparare un nuovo riepilogo.'); setUncertain(false); clearPendingReceipt(); setPreview(null); setCommand(null); }
      else setMessage(response.message);
    } catch { setMessage('Verifica non disponibile. Mantieni aperta questa pagina e riprova la verifica.'); }
    finally { busy.current = false; setPending(false); }
  }
  if (result) return <section role="status" className="grid gap-4 rounded-2xl border border-green-300 bg-green-50 p-5">
    <h2 className="text-xl font-bold">{setup.serviceId ? 'Pagamento collegato al servizio' : 'Servizio registrato nel fascicolo'}</h2>
    <p>Il referente tecnico e la sua presa in carico si scelgono nel passaggio successivo.</p>
    <div className="flex flex-wrap gap-4"><Link className={button} href={`/clients/${result.clientId}#service-${result.serviceId}`}>Apri servizio nel fascicolo</Link>
      <Link className="rounded-xl border border-fai-blue px-5 py-3 font-semibold text-fai-blue" href={`/services/${result.serviceId}/handoff`}>Passaggio al tecnico</Link></div>
  </section>;
  return <div className="grid min-w-0 gap-5">
    {message && <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-4">{message}</p>}
    {uncertain && !message && <p role="status">Un salvataggio precedente è da verificare.</p>}
    {uncertain && <button className={button} disabled={pending} onClick={verify}>Verifica esito</button>}
    <form onSubmit={prepare} aria-label="Registrazione servizio acquistato" className="grid gap-5">
      <fieldset disabled={pending || uncertain} className="grid min-w-0 gap-4">
        <label className="grid gap-1 font-semibold">Servizio del catalogo
          <select aria-label="Servizio del catalogo" className={field} value={catalogId} required disabled={Boolean(setup.serviceId)} onChange={e => { setCatalog(e.target.value); changed(); }}>
            <option value="">Seleziona il servizio</option>{setup.catalogs.map(c => <option key={c.id} value={c.id}>{c.name} · {c.code}</option>)}
          </select></label>
        <label className="grid gap-1 font-semibold">Incarico firmato del cliente
          <select aria-label="Incarico firmato del cliente" className={field} value={contractId} required disabled={Boolean(setup.serviceId)} onChange={e => { setContract(e.target.value); setPayment(''); changed(); }}>
            <option value="">Seleziona l’incarico</option>{setup.contracts.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select></label>
        {!setup.serviceId && <label className="grid gap-1 font-semibold">Data di acquisto
          <input className={field} type="date" value={purchasedOn} max={setup.today} required onChange={e => { setPurchased(e.target.value); changed(); }} /></label>}
        <label className="grid gap-1 font-semibold">Rata incassata{!setup.serviceId && ' (facoltativa)'}
          <select aria-label={setup.serviceId ? 'Rata incassata' : 'Rata incassata (facoltativa)'} className={field} value={paymentId} required={Boolean(setup.serviceId)} onChange={e => { setPayment(e.target.value); changed(); }}>
            <option value="">{setup.serviceId ? 'Seleziona la rata' : 'Collegherò il pagamento in seguito'}</option>
            {setup.payments.filter(p => p.contractId === contractId).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select></label>
        <p className="text-sm text-slate-600">Scegli il servizio previsto dall’incarico. La rata deve risultare già incassata nel CRM. Per affidare il lavoro al tecnico servono anche il documento firmato e la prova del pagamento verificati.</p>
        <button className={button} type="submit" disabled={!setup.contracts.length || !setup.catalogs.length}>Controlla riepilogo</button>
      </fieldset>
    </form>
    {preview && <section aria-label="Riepilogo servizio" className="grid gap-4 rounded-2xl border border-fai-blue/30 bg-blue-50 p-5">
      <h2 className="text-xl font-bold">Riepilogo prima della registrazione</h2>
      <dl className="grid gap-2 break-words"><div><dt className="font-semibold">Cliente</dt><dd>{preview.client}</dd></div>
        <div><dt className="font-semibold">Servizio</dt><dd>{preview.service}</dd></div><div><dt className="font-semibold">Incarico</dt><dd>{preview.contract}</dd></div>
        <div><dt className="font-semibold">Attività previste dall’incarico</dt><dd className="whitespace-pre-wrap">{preview.scope}</dd></div>
        <div><dt className="font-semibold">Progetto</dt><dd>{preview.project ?? 'Fascicolo generale del cliente'}</dd></div>
        <div><dt className="font-semibold">Data di acquisto</dt><dd>{preview.purchasedOn}</dd></div>
        <div><dt className="font-semibold">Pagamento collegato</dt><dd>{preview.payment ?? 'Da collegare'}{preview.payment && ` · ${preview.paymentStatus === 'parziale' ? 'Pagamento parziale' : 'Importo dell’incarico coperto'}`}</dd></div></dl>
      <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={confirmed} disabled={pending || uncertain} onChange={e => setConfirmed(e.target.checked)} />
        Confermo che il servizio corrisponde all’incarico e che i collegamenti sono corretti.</label>
      <button className={button} disabled={!confirmed || pending || uncertain} onClick={save}>{pending ? 'Registrazione in corso…' : setup.serviceId ? 'Collega pagamento' : 'Registra servizio acquistato'}</button>
    </section>}
  </div>;
}
