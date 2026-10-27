'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { historicalClientTypeLabels, historicalSourceLabels, type HistoricalConversionViewPreview,
  type HistoricalConversionViewReceipt, type HistoricalConversionViewResult } from '@/lib/commercial-lead-historical-view';

type Context = Readonly<{ leadId: string; leadLabel: string; commandId: string; expectedInboxVersion: number;
  expectedAssignmentId: string; contactId: string; recoverCommandId?: string }>;
type Actions = { previewAction: (input: unknown) => Promise<HistoricalConversionViewResult>;
  confirmAction: (input: { token: string; confirmed: true }) => Promise<HistoricalConversionViewResult>;
  outcomeAction: (input: { leadId: string; commandId: string }) => Promise<HistoricalConversionViewResult> };
const subscribe = () => () => {}, browser = () => true, server = () => false;
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const when = (value: string) => new Date(value).toLocaleString('it-IT', { timeZone: 'UTC' }) + ' UTC';

export function HistoricalConversionReceipt({ receipt }: { receipt: HistoricalConversionViewReceipt }) {
  return <section aria-label="Ricevuta conversione" className="space-y-3 rounded-xl border border-green-500 p-4">
    <h2 className="text-xl font-bold">Cliente registrato</h2><p>Registrazione nel CRM: {when(receipt.recordedAt)}</p>
    <p>Il contatto precedente è conservato come base della conversione. Nessuna prima risposta o puntualità SLA è stata inventata.</p>
    <a className="font-semibold underline" href={`/clients/${receipt.clientId}`}>Apri cliente</a>
  </section>;
}
export function CommercialLeadHistoricalConversion({ context, ...actions }: { context: Context } & Actions) {
  const ready = useSyncExternalStore(subscribe, browser, server), flight = useRef(false);
  const [pending, setPending] = useState(false), [type, setType] = useState('');
  const [preview, setPreview] = useState<HistoricalConversionViewPreview | null>(null);
  const [receipt, setReceipt] = useState<HistoricalConversionViewReceipt | null>(null);
  const [recover, setRecover] = useState(context.recoverCommandId ?? ''), [message, setMessage] = useState('');
  const busy = !ready || pending;
  async function prepare() {
    if (flight.current || recover) return;
    flight.current = true; setPending(true); setMessage('');
    try {
      const result = await actions.previewAction({ commandId: context.commandId, leadId: context.leadId,
        expectedInboxVersion: context.expectedInboxVersion, expectedAssignmentId: context.expectedAssignmentId,
        contactId: context.contactId, clientType: type });
      if (result.state === 'PREVIEW') setPreview(result.preview);
      else setMessage('Riepilogo non disponibile. Nessuna conversione richiesta.');
    } catch { setMessage('Riepilogo non disponibile. Nessuna conversione richiesta.'); }
    finally { flight.current = false; setPending(false); }
  }
  async function confirm(data: FormData) {
    if (flight.current || recover || !preview || data.get('confirmed') !== 'on') return;
    try { const url = new URL(window.location.href); url.searchParams.set('historicalConversionCommand', preview.input.commandId);
      window.history.replaceState(window.history.state, '', url);
    } catch { setMessage('Non è possibile conservare la decisione. Conversione non avviata.'); return; }
    flight.current = true; setPending(true); setRecover(preview.input.commandId);
    try {
      const result = await actions.confirmAction({ token: preview.token, confirmed: true });
      if (result.state === 'CONVERTED' && result.receipt.commandId === preview.input.commandId) setReceipt(result.receipt);
      else setMessage('Esito da verificare. Non ripetere la conversione.');
    } catch { setMessage('Risposta non disponibile. Verifica l’esito senza ripetere la conversione.'); }
    finally { flight.current = false; setPending(false); }
  }
  async function reconcile() {
    if (flight.current || !recover) return;
    flight.current = true; setPending(true);
    try {
      const result = await actions.outcomeAction({ leadId: context.leadId, commandId: recover });
      if (result.state === 'CONVERTED' && result.receipt.commandId === recover) setReceipt(result.receipt);
      else setMessage('Decisione non osservata o non consultabile. Non ripetere finché l’esito non è riconciliato.');
    } catch { setMessage('Verifica non disponibile. La conversione rimane bloccata.'); }
    finally { flight.current = false; setPending(false); }
  }
  return <section aria-label="Conversione da contatto precedente" data-interactive-ready={ready} className="min-w-0 space-y-4 rounded-2xl border bg-white p-4 sm:p-6">
    <p className="break-words">Lead: {context.leadLabel}</p>
    <p>Registra il cliente sulla base del contatto già attestato. Contratto, incasso, avvio del servizio e pratica restano passaggi separati.</p>
    {!preview && !recover && <form action={prepare} className="space-y-4">
      <label className="block">Tipo cliente<select aria-label="Tipo cliente" required value={type} onChange={e => setType(e.target.value)} disabled={busy}
        className="block w-full min-w-0 rounded-xl border p-3"><option value="">Scegli il tipo</option>
        {Object.entries(historicalClientTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className={button} disabled={busy}>Prepara conversione</button>
    </form>}
    {preview && !recover && <section aria-label="Riepilogo conversione" className="space-y-3 rounded-xl border border-blue-200 p-4">
      <h2 className="text-xl font-bold">Verifica il cliente da registrare</h2>
      <p className="break-words">Cliente: {preview.leadLabel} · {historicalClientTypeLabels[preview.input.clientType]}</p>
      <p>Evento reale: {when(preview.occurredAt)} · registrato: {when(preview.contactRecordedAt)}</p>
      <p className="break-words">Fonte: {historicalSourceLabels[preview.source]} · {preview.evidenceReference}</p>
      {preview.notes && <div><h3 className="font-bold">Note del lead conservate nel cliente</h3><p className="whitespace-pre-wrap break-words">{preview.notes}</p></div>}
      <p>Il referente commerciale rimane quello corrente. Nessun incarico tecnico, documento condiviso o messaggio viene creato.</p>
      <p>Riepilogo valido fino a {when(preview.expiresAt)}.</p>
      <form action={confirm} className="space-y-3"><label className="flex gap-2"><input name="confirmed" type="checkbox" required disabled={busy} />
        Confermo il cliente e la base storica riepilogati.</label><button className={button} disabled={busy}>Registra cliente da contatto precedente</button></form>
      <button className="font-semibold underline" type="button" disabled={busy} onClick={() => setPreview(null)}>Modifica tipo cliente</button>
    </section>}
    {recover && !receipt && <div className="space-y-3 rounded-xl border border-amber-400 p-4"><p>Consulta soltanto la decisione già inviata.</p>
      <button className={button} type="button" disabled={busy} onClick={reconcile}>Verifica esito della conversione</button></div>}
    {receipt && <HistoricalConversionReceipt receipt={receipt} />}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
