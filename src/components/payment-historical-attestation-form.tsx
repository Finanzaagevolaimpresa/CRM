'use client';
import Link from 'next/link';
import { useRef, useState, useSyncExternalStore } from 'react';
import { previewHistoricalPaymentAction, confirmHistoricalPaymentAction, verifyHistoricalPaymentAction } from '@/lib/payment-historical-attestation-actions';
import { historicalDayLabel, type HistoricalPaymentCommand, type HistoricalPaymentPreview, type HistoricalPaymentReceipt } from '@/lib/payment-historical-attestation-contract';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

type Setup = { clientId: string; paymentId: string; amount: string; eligible: boolean; result: HistoricalPaymentReceipt | null };
const field = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'rounded-xl bg-fai-blue px-5 py-3 font-semibold text-white disabled:opacity-50';
const noop = () => () => {}, clientReady = () => true, serverReady = () => false;
function subscribe(listener: () => void) {
  window.addEventListener('fai-historical-payment', listener);
  return () => window.removeEventListener('fai-historical-payment', listener);
}
export function PaymentHistoricalAttestationForm({ setup }: { setup: Setup }) {
  const ready = useSyncExternalStore(noop, clientReady, serverReady);
  const [values, setValues] = useState({ effectiveDay: '', attestedOn: '', declarant: '', provenance: '', reason: '' });
  const [preview, setPreview] = useState<HistoricalPaymentPreview | null>(null);
  const [command, setCommand] = useState<HistoricalPaymentCommand | null>(null);
  const [result, setResult] = useState(setup.result), [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false), [message, setMessage] = useState('');
  const [uncertainResponse, setUncertain] = useState(false), [needsStepUp, setNeedsStepUp] = useState(false);
  const busy = useRef(false), lastCommand = useRef<string | null>(null);
  const key = `fai-historical-payment:${setup.clientId}:${setup.paymentId}`;
  const saved = useSyncExternalStore(subscribe, () => {
    try { const value = sessionStorage.getItem(key); return value && /^[a-f0-9-]{36}$/i.test(value) ? value : null; }
    catch { return null; }
  }, () => null);
  const uncertain = uncertainResponse || Boolean(saved);
  function clear() { try { sessionStorage.removeItem(key); window.dispatchEvent(new Event('fai-historical-payment')); } catch { /* Keep local result. */ } }
  function change(name: keyof typeof values, value: string) {
    setValues(v => ({ ...v, [name]: value })); setPreview(null); setCommand(null); setConfirmed(false); setMessage('');
  }
  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy.current || uncertain || !setup.eligible || result) return;
    busy.current = true; setPending(true); setMessage(''); setConfirmed(false);
    const input: HistoricalPaymentCommand = { commandId: crypto.randomUUID(), clientId: setup.clientId,
      paymentId: setup.paymentId, expectedAmount: setup.amount, ...values,
      expiresAt: new Date(Date.now() + 180_000).toISOString(), confirmed: true };
    lastCommand.current = input.commandId;
    try {
      const response = await previewHistoricalPaymentAction(input);
      if (response.ok) { setPreview(response.preview); setCommand(input); }
      else { setPreview(null); setCommand(null); setMessage(response.message); }
    } catch { setMessage('Riepilogo non disponibile. Nessuna rettifica è stata richiesta.'); }
    finally { busy.current = false; setPending(false); }
  }
  async function save() {
    if (!ready || busy.current || uncertain || !preview || !command || !confirmed || result) return;
    busy.current = true; setPending(true); setMessage('');
    try { sessionStorage.setItem(key, command.commandId); window.dispatchEvent(new Event('fai-historical-payment')); }
    catch { setMessage('Il browser non conserva il riferimento: nessuna rettifica è stata inviata.'); busy.current = false; setPending(false); return; }
    try {
      const response = await confirmHistoricalPaymentAction(command, preview.digest);
      if (response.ok) { setResult(response.result); clear(); }
      else if ('stepUpRequired' in response && response.stepUpRequired) { clear(); setNeedsStepUp(true); setMessage(response.message); }
      else {
        setUncertain(response.uncertain);
        if (!response.uncertain) { clear(); setPreview(null); setCommand(null); setConfirmed(false); }
        setMessage(response.message);
      }
    } catch { setUncertain(true); setMessage('La risposta non è arrivata. Verifica l’esito della stessa richiesta.'); }
    finally { busy.current = false; setPending(false); }
  }
  async function verify() {
    const id = saved ?? lastCommand.current;
    if (!ready || busy.current || !id) return;
    busy.current = true; setPending(true);
    try {
      const response = await verifyHistoricalPaymentAction(setup.clientId, setup.paymentId, id);
      if (response.ok && response.result) { setResult(response.result); clear(); setUncertain(false); }
      else if (response.ok) {
        clear(); setUncertain(false); setPreview(null); setCommand(null); setConfirmed(false);
        setMessage('Nessuna rettifica trovata per questo riferimento. Puoi controllare un nuovo riepilogo.');
      } else setMessage(response.message);
    } catch { setMessage('Verifica non disponibile: conserva il riferimento senza ripetere la rettifica.'); }
    finally { busy.current = false; setPending(false); }
  }
  if (result) return <section role="status" className="grid min-w-0 gap-4 rounded-xl border border-green-300 p-5">
    <h2 className="text-xl font-bold">Incasso storico registrato su attestazione Admin</h2>
    <p>Stato attuale: <strong>{result.currentStatus.replaceAll('_', ' ')}</strong>. Importo: € {result.amount}.</p>
    <dl className="grid gap-3 break-words">
      <div><dt>Giorno effettivo dichiarato</dt><dd>{historicalDayLabel(result.source.effectiveDay)} · precisione solo giorno</dd></div>
      <div><dt>Ora e metodo dell’accredito</dt><dd>Non dichiarati</dd></div>
      <div><dt>Fonte</dt><dd>Attestazione amministrativa di {result.source.declarant}, ricevuta il {historicalDayLabel(result.source.attestedOn)}</dd></div>
      <div><dt>Provenienza</dt><dd>{result.source.provenance}</dd></div>
      <div><dt>Motivazione</dt><dd>{result.reason}</dd></div>
      <div><dt>Autore della registrazione</dt><dd>{result.actorName}</dd></div>
      <div><dt>Registrazione nel CRM</dt><dd>{new Date(result.recordedAt).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })} · ora italiana</dd></div>
      <div><dt>Riferimento della rettifica</dt><dd>{result.commandId}</dd></div>
      <div><dt>Stato precedente</dt><dd>{result.previousStatus.replaceAll('_', ' ')}</dd></div>
    </dl>
    <p>Questa fonte non è una prova bancaria verificata. L’orario normalizzato nell’archivio non è un’ora effettiva di accredito. Contratto e servizi restano nei propri percorsi.</p>
    <Link className="underline" href="/payments">Apri pagamenti e verifica lo stato</Link>
    <Link className="underline" href={`/clients/${result.clientId}#pagamenti`}>Apri pagamenti del fascicolo</Link>
  </section>;
  return <div data-testid="historical-payment-form" data-interactive-ready={ready} className="grid min-w-0 gap-4">
    {needsStepUp && <InlinePrivilegedConfirmation />}
    {message && <p role="status">{message}</p>}
    {uncertain && <div><p>Una rettifica è da verificare.</p><button className={button} disabled={pending} onClick={verify}>Verifica esito</button></div>}
    {!setup.eligible && <p>Questa rata non ammette una nuova rettifica storica: verifica lo stato e le registrazioni già presenti.</p>}
    {setup.eligible && !uncertain && <form onSubmit={prepare} aria-label="Rettifica storica su attestazione Admin" className="grid gap-4">
      <fieldset disabled={!ready || pending} className="grid gap-3">
        <label>Giorno effettivo dell’incasso<input type="date" className={field} required value={values.effectiveDay} onChange={e => change('effectiveDay', e.target.value)} /></label>
        <p>Precisione solo giorno. Non sono richiesti né dedotti ora, metodo, contratto firmato o allegati bancari.</p>
        <label>Giorno dell’attestazione del titolare<input type="date" className={field} required value={values.attestedOn} onChange={e => change('attestedOn', e.target.value)} /></label>
        <label>Titolare dichiarante<input className={field} required minLength={2} maxLength={120} value={values.declarant} onChange={e => change('declarant', e.target.value)} /></label>
        <label>Provenienza dell’attestazione<textarea className={field} required minLength={10} maxLength={1000} value={values.provenance} onChange={e => change('provenance', e.target.value)} /></label>
        <label>Motivazione della rettifica<textarea className={field} required minLength={10} maxLength={2000} value={values.reason} onChange={e => change('reason', e.target.value)} /></label>
        <button className={button} type="submit">Controlla rettifica storica</button>
      </fieldset>
    </form>}
    {!uncertain && preview && <section aria-label="Riepilogo rettifica storica" className="grid gap-3 break-words rounded-xl border p-5">
      <h2 className="text-xl font-bold">Riepilogo prima della rettifica</h2>
      <p>{preview.client} · rata esistente € {preview.amount} · contratto {preview.contract}</p>
      <p>{preview.previousStatus.replaceAll('_', ' ')} → Incassato. Giorno dichiarato: <strong>{historicalDayLabel(preview.effectiveDay)}</strong>.</p>
      <p>Ora e metodo dell’accredito: non dichiarati. Metodo precedentemente registrato: {preview.previousMethod ?? 'non indicato'}; il valore precedente resta nello storico.</p>
      <p>Attestazione di {preview.declarant} del {historicalDayLabel(preview.attestedOn)}. Provenienza: {preview.provenance}</p>
      <p>Motivazione: {preview.reason}</p>
      <p>Importi, firma del contratto, documenti e servizi non vengono modificati. Nessuna verifica bancaria è attestata.</p>
      <label className="flex items-start gap-3"><input type="checkbox" checked={confirmed} disabled={pending} onChange={e => setConfirmed(e.target.checked)} />Confermo di registrare l’attestazione espressa del titolare per questa rata e questo giorno, distinta da una prova bancaria.</label>
      <button className={button} disabled={!confirmed || pending} onClick={save}>Registra incasso storico</button>
    </section>}
  </div>;
}
