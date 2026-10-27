'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { historicalEventInstant, historicalOffsetLabels, historicalSourceLabels,
  type HistoricalContactViewPreview, type HistoricalContactViewReceipt, type HistoricalContactViewResult } from '@/lib/commercial-lead-historical-view';

type Context = Readonly<{ leadId: string; leadLabel: string; commandId: string; expectedInboxVersion: number;
  expectedAssignmentId: string; initializedAt: string; recoverCommandId?: string }>;
type Actions = {
  previewAction: (input: unknown) => Promise<HistoricalContactViewResult>;
  confirmAction: (input: { token: string; confirmed: true }) => Promise<HistoricalContactViewResult>;
  outcomeAction: (input: { leadId: string; commandId: string }) => Promise<HistoricalContactViewResult>;
};
const subscribe = () => () => {}, browser = () => true, server = () => false;
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const when = (value: string) => new Date(value).toLocaleString('it-IT', { timeZone: 'UTC' }) + ' UTC';

/** Native candidate flow. Server callbacks recheck the locked session/scope and
 * signed preview at each operation; a receipt is never a new write permission. */
export function CommercialLeadHistoricalContact({ context, initialReceipt = null, conversionHref, ...actions }:
  { context: Context; initialReceipt?: HistoricalContactViewReceipt | null; conversionHref?: string } & Actions) {
  const ready = useSyncExternalStore(subscribe, browser, server);
  const [pending, setPending] = useState(false), flight = useRef(false);
  const [preview, setPreview] = useState<HistoricalContactViewPreview | null>(null);
  const [receipt, setReceipt] = useState<HistoricalContactViewReceipt | null>(initialReceipt);
  const [recover, setRecover] = useState(context.recoverCommandId ?? '');
  const [message, setMessage] = useState('');
  const [date, setDate] = useState(''), [offset, setOffset] = useState('');
  const [source, setSource] = useState(''), [reference, setReference] = useState('');
  const busy = !ready || pending;

  async function prepare(form: FormData) {
    if (flight.current || recover) return;
    const occurredAt = historicalEventInstant(date, offset);
    if (!occurredAt || form.get('attested') !== 'on') { setMessage('Indica la data effettiva, il fuso e la tua attestazione.'); return; }
    flight.current = true; setPending(true); setMessage('');
    try {
      const result = await actions.previewAction({ commandId: context.commandId, leadId: context.leadId,
        expectedInboxVersion: context.expectedInboxVersion, expectedAssignmentId: context.expectedAssignmentId,
        occurredAt, source, evidenceReference: reference, attested: true });
      if (result.state === 'PREVIEW') setPreview(result.preview);
      else setMessage('Anteprima non disponibile con i dati e i permessi correnti. Nessuna registrazione richiesta.');
    } catch { setMessage('Anteprima non disponibile. Nessuna registrazione richiesta.'); }
    finally { flight.current = false; setPending(false); }
  }
  async function confirm(form: FormData) {
    if (flight.current || recover || !preview || form.get('confirmed') !== 'on') return;
    // Remember only the command reference before sending. Reloading the page
    // must open reconciliation, not generate a fresh write after a lost reply.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('historicalContactCommand', preview.input.commandId);
      window.history.replaceState(window.history.state, '', url);
    } catch { setMessage('Non è possibile conservare il riferimento della decisione. Registrazione non avviata.'); return; }
    flight.current = true; setPending(true); setRecover(preview.input.commandId);
    setMessage('Registrazione in corso.');
    try {
      const result = await actions.confirmAction({ token: preview.token, confirmed: true });
      if (result.state === 'RECORDED' && result.receipt.id === preview.input.commandId) {
        setReceipt(result.receipt); setMessage('Contatto precedente registrato.');
      } else setMessage('Esito da verificare. Non ripetere la registrazione.');
    } catch { setMessage('Risposta non disponibile. Verifica l’esito senza ripetere la registrazione.'); }
    finally { flight.current = false; setPending(false); }
  }
  async function reconcile() {
    if (flight.current || !recover) return;
    flight.current = true; setPending(true);
    try {
      const result = await actions.outcomeAction({ leadId: context.leadId, commandId: recover });
      if (result.state === 'RECORDED' && result.receipt.id === recover) {
        setReceipt(result.receipt); setMessage('Registrazione verificata.');
      } else setMessage('Registrazione non osservata o non più consultabile. Non ripetere finché l’esito non è riconciliato.');
    } catch { setMessage('Verifica non disponibile. La registrazione rimane bloccata.'); }
    finally { flight.current = false; setPending(false); }
  }

  return <section aria-label="Contatto precedente al CRM" data-interactive-ready={ready} className="min-w-0 space-y-4 rounded-2xl border bg-white p-4 sm:p-6">
    <h2 className="text-xl font-bold">Contatto precedente al CRM</h2>
    <p className="break-words">Lead: {context.leadLabel}</p>
    <p>Ingresso nel CRM: {when(context.initializedAt)}. Registra un evento già avvenuto, con la sua fonte.
      La registrazione non crea una nuova risposta, non riscrive i tempi SLA e non invia messaggi.</p>
    {!preview && !recover && <form action={prepare} className="space-y-4">
      <label className="block">Data e ora effettive dell’evento<input className={control} type="datetime-local" required
        value={date} onChange={e => setDate(e.target.value)} disabled={busy} /></label>
      <label className="block">Fuso orario dell’evento<select aria-label="Fuso orario dell’evento" className={control} required value={offset} onChange={e => setOffset(e.target.value)} disabled={busy}>
        <option value="">Scegli il fuso dell’evento</option>{Object.entries(historicalOffsetLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="block">Fonte<select aria-label="Fonte" className={control} required value={source} onChange={e => setSource(e.target.value)} disabled={busy}>
        <option value="">Seleziona una fonte</option>{Object.entries(historicalSourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="block">Riferimento della prova<input className={control} required minLength={3} maxLength={500}
        value={reference} onChange={e => setReference(e.target.value)} disabled={busy} /></label>
      <p className="text-sm">Indica un riferimento rintracciabile, senza password, allegati o contenuti non necessari. La fonte è una tua dichiarazione e non viene verificata automaticamente.</p>
      <label className="flex items-start gap-2"><input type="checkbox" name="attested" required disabled={busy} />
        Attesto che l’evento indicato è avvenuto prima dell’ingresso nel CRM.</label>
      <button className={button} disabled={busy}>Prepara riepilogo</button>
    </form>}
    {preview && !recover && <section aria-label="Riepilogo del contatto precedente" className="space-y-3 rounded-xl border border-blue-200 p-4">
      <h3 className="font-bold">Verifica prima di registrare</h3>
      <p>Evento reale: {when(preview.input.occurredAt)}</p>
      <p>Fonte: {historicalSourceLabels[preview.input.source]}</p><p className="break-words">Riferimento: {preview.input.evidenceReference}</p>
      <p>La data di registrazione sarà l’ora effettiva del salvataggio. Riepilogo valido fino a {when(preview.expiresAt)}.</p>
      <form action={confirm} className="space-y-3"><label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required disabled={busy} />
        Confermo l’evento, la data e la fonte qui riepilogati.</label><button className={button} disabled={busy}>Registra contatto precedente</button></form>
      <button className="font-semibold underline" type="button" disabled={busy} onClick={() => setPreview(null)}>Modifica prima di registrare</button>
    </section>}
    {recover && !receipt && <div className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4">
      <p>La verifica consulta soltanto l’esito della decisione già inviata.</p>
      <button className={button} type="button" disabled={busy} onClick={reconcile}>Verifica esito del contatto</button>
    </div>}
    {receipt && <section aria-label="Ricevuta contatto precedente" className="space-y-2 rounded-xl border border-green-500 p-4">
      <h3 className="font-bold">Contatto registrato</h3><p>Evento reale: {when(receipt.input.occurredAt)}</p>
      <p>Registrazione nel CRM: {when(receipt.recordedAt)}</p><p>Fonte: {historicalSourceLabels[receipt.input.source]}</p>
      <p className="break-words">Riferimento: {receipt.input.evidenceReference}</p>
      <p>La conversione in cliente richiede una decisione distinta. Prima risposta e tempi SLA non sono stati modificati.</p>
      {conversionHref && <a className="inline-block font-semibold underline" href={conversionHref}>Prepara la conversione in cliente</a>}
    </section>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
