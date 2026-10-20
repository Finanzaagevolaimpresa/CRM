'use client';

import Link from 'next/link';
import { useRef, useState, useSyncExternalStore } from 'react';
import { previewContractActivitiesAction, confirmContractActivitiesAction, verifyContractActivitiesAction } from '@/lib/contract-activities-actions';
import type { ContractActivitiesCommand, ContractActivitiesPreview } from '@/lib/contract-activities-contract';

type Setup = { clientId: string; contractId: string; reconciliationOnly: boolean };
const button = 'rounded-xl bg-fai-blue px-5 py-3 font-semibold text-white disabled:opacity-50';
const subscribeReady = () => () => {}, browserReady = () => true, serverReady = () => false;
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener); window.addEventListener('fai-contract-activities', listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener('fai-contract-activities', listener); };
}
export function ContractActivitiesForm({ setup }: { setup: Setup }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [activities, setActivities] = useState('');
  const [preview, setPreview] = useState<ContractActivitiesPreview | null>(null);
  const [command, setCommand] = useState<ContractActivitiesCommand | null>(null);
  const [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState(false);
  const [uncertainResponse, setUncertain] = useState(false), [message, setMessage] = useState('');
  const [result, setResult] = useState<{ clientId: string; contractId: string } | null>(null);
  const busy = useRef(false), commandId = useRef<string | null>(null);
  const key = `fai-contract-activities:${setup.clientId}:${setup.contractId}`;
  const saved = useSyncExternalStore(subscribe, () => {
    try { const value = sessionStorage.getItem(key); return value && /^[a-f0-9-]{36}$/i.test(value) ? value : null; }
    catch { return null; }
  }, () => null);
  const uncertain = uncertainResponse || Boolean(saved);
  function clear() { try { sessionStorage.removeItem(key); window.dispatchEvent(new Event('fai-contract-activities')); } catch { /* Retain the observed in-memory result. */ } }
  function changed() { setPreview(null); setCommand(null); setConfirmed(false); setMessage(''); }
  async function prepare(event: React.FormEvent) {
    event.preventDefault(); if (!ready || busy.current || uncertain || setup.reconciliationOnly) return;
    busy.current = true; setPending(true); setConfirmed(false); setMessage('');
    const input: ContractActivitiesCommand = { commandId: crypto.randomUUID(), clientId: setup.clientId,
      contractId: setup.contractId, activities, confirmed: true };
    commandId.current = input.commandId;
    try {
      const response = await previewContractActivitiesAction(input);
      if (response.ok) { setCommand(input); setPreview(response.preview); }
      else { setPreview(null); setMessage(response.message); }
    } catch { setMessage('Riepilogo non disponibile. Nessun salvataggio è stato richiesto.'); }
    finally { busy.current = false; setPending(false); }
  }
  async function save() {
    if (!ready || busy.current || uncertain || setup.reconciliationOnly || !preview || !command || !confirmed) return;
    busy.current = true; setPending(true); setMessage('');
    try { sessionStorage.setItem(key, command.commandId); window.dispatchEvent(new Event('fai-contract-activities')); }
    catch {
      setMessage('Il browser non può conservare il riferimento della richiesta. Nessun salvataggio è stato inviato; abilita la memoria della sessione e riprova.');
      busy.current = false; setPending(false); return;
    }
    try {
      const response = await confirmContractActivitiesAction(command, preview.digest);
      if (response.ok) { setResult(response.result); clear(); }
      else { setMessage(response.message); setUncertain(response.uncertain); if (!response.uncertain) { clear(); changed(); setMessage(response.message); } }
    } catch { setUncertain(true); setMessage('La risposta non è arrivata. Verifica l’esito prima di ripetere il salvataggio.'); }
    finally { busy.current = false; setPending(false); }
  }
  async function verify() {
    const id = saved ?? commandId.current;
    if (!ready || busy.current || !id) return;
    busy.current = true; setPending(true);
    try {
      const response = await verifyContractActivitiesAction(setup.clientId, setup.contractId, id);
      if (response.ok && response.result) { setResult(response.result); setUncertain(false); clear(); }
      else if (response.ok) { clear(); setUncertain(false); changed(); setMessage('Nessuna registrazione trovata per questa richiesta. Puoi preparare un nuovo riepilogo se il contratto è ancora disponibile.'); }
      else setMessage(response.message);
    } catch { setMessage('Verifica non disponibile. Mantieni la richiesta in sospeso e riprova la verifica.'); }
    finally { busy.current = false; setPending(false); }
  }
  if (result) return <section role="status" className="grid gap-4 rounded-2xl border border-green-300 bg-green-50 p-5">
    <h2 className="text-xl font-bold">Attività salvate nel contratto</h2>
    <p>La descrizione è stata aggiunta al contratto esistente. Firma, documento firmato, incasso e passaggio al tecnico mantengono le rispettive verifiche.</p>
    <Link className={button} href={`/contracts/${result.contractId}`}>Torna al contratto</Link>
  </section>;
  return <div className="grid min-w-0 gap-5" data-testid="contract-activities-form" data-interactive-ready={ready}>
    {message && <p role="status" className="rounded-xl bg-amber-50 p-4">{message}</p>}
    {uncertain && <div className="grid gap-3"><p>Un salvataggio precedente è da verificare.</p><button className={button} disabled={pending} onClick={verify}>Verifica esito</button></div>}
    {setup.reconciliationOnly && <p className="rounded-xl bg-blue-50 p-4">Le attività sono già compilate oppure questo contratto è chiuso o collegato a un servizio. Puoi verificare l’esito di una richiesta in sospeso oppure tornare alla scheda.</p>}
    {!setup.reconciliationOnly && <form onSubmit={prepare} aria-label="Completa attività dell’incarico" className="grid gap-4">
      <fieldset disabled={!ready || pending || uncertain} className="grid min-w-0 gap-4">
        <label className="grid gap-1 font-semibold">Attività previste dall’incarico
          <textarea className="block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3" rows={7} maxLength={5000}
            value={activities} required onChange={e => { setActivities(e.target.value); changed(); }}
            placeholder="Riporta le attività effettivamente concordate, indicando cosa comprende l’incarico." />
        </label>
        <p className="text-sm text-fai-gray">Massimo 5.000 caratteri. La compilazione descrive l’incarico esistente e non aggiunge prestazioni al contratto.</p>
        <button className={button} type="submit" disabled={!activities.trim()}>Controlla riepilogo</button>
      </fieldset>
    </form>}
    {!setup.reconciliationOnly && preview && <section aria-label="Riepilogo attività" className="grid gap-4 rounded-2xl border border-fai-blue/30 bg-blue-50 p-5">
      <h2 className="text-xl font-bold">Riepilogo prima del salvataggio</h2>
      <dl className="grid gap-3 break-words"><div><dt className="font-semibold">Cliente</dt><dd>{preview.client}</dd></div>
        <div><dt className="font-semibold">Contratto</dt><dd>{preview.contract}</dd></div>
        <div><dt className="font-semibold">Servizio</dt><dd>{preview.service}</dd></div>
        <div><dt className="font-semibold">Attività da aggiungere</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{preview.activities}</dd></div>
        <div><dt className="font-semibold">Progetto</dt><dd>{preview.project ?? 'Fascicolo generale del cliente'}</dd></div></dl>
      <label className="flex items-start gap-3"><input type="checkbox" checked={confirmed} disabled={pending || uncertain} onChange={e => setConfirmed(e.target.checked)} />Confermo che queste attività corrispondono a quanto effettivamente concordato nell’incarico.</label>
      <button className={button} disabled={!confirmed || pending || uncertain} onClick={save}>{pending ? 'Salvataggio…' : 'Salva attività nel contratto'}</button>
    </section>}
  </div>;
}
