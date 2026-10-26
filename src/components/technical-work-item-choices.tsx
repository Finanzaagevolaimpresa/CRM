'use client';

import { useId, useRef, useState } from 'react';
import { technicalItemFields } from '@/lib/technical-work-item-grant';
import type { readTechnicalAssignmentManagement } from '@/lib/technical-assignment-management';
import { technicalWorkItemOptionKey, type TechnicalWorkItemCatalogue, type TechnicalWorkItemChoices as ItemChoices,
  type TechnicalWorkItemOption } from '@/lib/technical-work-item-catalog';

type Data = Awaited<ReturnType<typeof readTechnicalAssignmentManagement>>;
export type { ItemChoices };
export type TechnicalItemCatalogueAction = (raw: unknown) => Promise<{ ok: boolean; message: string; catalogue?: TechnicalWorkItemCatalogue }>;
export function TechnicalWorkItemChoices({ data, actions, choices, onChange, catalogueAction, onReady }: {
  data: Data; actions: string[]; choices: ItemChoices; onChange: (value: ItemChoices) => void;
  catalogueAction: TechnicalItemCatalogueAction; onReady: (ready: boolean) => void }) {
  const kindId = useId();
  const [catalogue, setCatalogue] = useState<TechnicalWorkItemCatalogue | null>(data.workItemCatalogueAvailable ? data.workItemCatalogue : null);
  const [term, setTerm] = useState(''), [kind, setKind] = useState<'ALL' | 'Task' | 'ChecklistItem'>('ALL');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(data.workItemCatalogueAvailable ? '' : 'Catalogo non disponibile. Ricarica per verificare le scelte. La revoca degli incarichi resta disponibile.');
  const inFlight = useRef(false);
  const selected = Object.values(choices);
  async function load(page: number, search = false) {
    if (inFlight.current || !data.recipient) return;
    inFlight.current = true; setBusy(true); onReady(false); setMessage('Caricamento del catalogo…');
    try {
      const result = await catalogueAction({ reference: { ...data.target, recipientId: data.recipient.id },
        contextSha256: data.contextSha256, recipientEpoch: data.recipient.epoch,
        query: { query: search ? term : catalogue?.query.query ?? '', kind: search ? kind : catalogue?.query.kind ?? 'ALL', page } });
      if (!result.ok || !result.catalogue) { setCatalogue(null); setMessage(result.message); return; }
      setCatalogue(result.catalogue); setMessage(result.message); onReady(true);
    } catch { setCatalogue(null); setMessage('Catalogo non disponibile. Riprova la ricerca o ricarica la pagina; le scelte non sono state confermate.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function card(raw: TechnicalWorkItemOption) {
      const key = technicalWorkItemOptionKey(raw), choice = choices[key], item = choice?.option ?? raw;
      const enabled = actions.includes(item.kind === 'Task' ? 'manage_deadlines' : 'manage_checklist');
      return <div key={key} className="min-w-0 space-y-3 rounded-xl border p-3">
        <label className="flex items-start gap-2 break-words font-semibold"><input type="checkbox" disabled={!enabled || (!choice && selected.length >= 20)}
          checked={!!choice && enabled} onChange={event => { const next = { ...choices };
            if (event.target.checked) next[key] = { option: item, readable: [], editable: [] }; else delete next[key]; onChange(next); }} />
          {item.kind === 'Task' ? 'Attività' : 'Checklist'} · {item.title}</label>
        {choice && !enabled && <p>Scelta conservata ma esclusa dal riepilogo: riabilita l’operazione pertinente oppure rimuovila.</p>}
        {choice && enabled && <div className="grid gap-3 sm:grid-cols-2">{technicalItemFields(item.kind).map(field => <div key={field.key} className="space-y-2">
          <label className="flex items-center gap-2"><input type="checkbox" checked={choice.readable.includes(field.key)} onChange={event => onChange({ ...choices,
            [key]: { ...choice, readable: event.target.checked ? [...choice.readable, field.key] : choice.readable.filter(value => value !== field.key),
              editable: event.target.checked ? choice.editable : choice.editable.filter(value => value !== field.key) } })} />{field.label}</label>
          {field.editable && <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!choice.readable.includes(field.key)}
            checked={choice.editable.includes(field.key)} onChange={event => onChange({ ...choices, [key]: { ...choice,
              editable: event.target.checked ? [...choice.editable, field.key] : choice.editable.filter(value => value !== field.key) } })} />Consenti modifica {field.label.toLocaleLowerCase('it-IT')}</label>}
        </div>)}</div>}
        {choice && <button type="button" className="rounded-lg border px-3 py-2 underline" onClick={() => { const next = { ...choices }; delete next[key]; onChange(next); }}>Rimuovi questa scelta</button>}
      </div>;
  }
  const pageKeys = new Set(catalogue?.options.map(technicalWorkItemOptionKey));
  return <fieldset className="min-w-0 space-y-3" disabled={busy}><legend className="font-bold">Checklist, attività e scadenze da includere</legend>
    <p>Scegli fino a 20 elementi e i singoli campi. Le nuove attività restano escluse. Gli stati e i collegamenti documentali non sono modificabili da qui; i documenti richiedono la scelta separata della versione.</p>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className="block font-semibold">Cerca attività e checklist<input className="block w-full min-w-0 rounded-xl border p-3" maxLength={200} value={term}
        onChange={event => setTerm(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void load(1, true); } }} /></label>
      <div><label htmlFor={kindId} className="block font-semibold">Tipo di elemento</label><select id={kindId} className="block w-full rounded-xl border p-3" value={kind}
        onChange={event => setKind(event.target.value as typeof kind)}><option value="ALL">Tutti</option><option value="Task">Attività e scadenze</option><option value="ChecklistItem">Checklist</option></select></div>
    </div>
    <button type="button" className="rounded-xl border px-4 py-3 font-semibold" onClick={() => void load(1, true)}>Cerca nel catalogo</button>
    <p role="status">{message}</p>
    {catalogue && <>
      <p>Pagina {catalogue.query.page} · {selected.length} elementi scelti. Le scelte restano conservate quando cambi pagina o ricerca e vengono ricontrollate nell’anteprima.</p>
      {!catalogue.options.length && <p>Nessun elemento pertinente per questa ricerca e pagina.</p>}
      {catalogue.options.map(card)}
      <nav aria-label="Pagine del catalogo attività" className="flex flex-wrap gap-3">
        {catalogue.query.page > 1 && <button type="button" className="rounded-xl border px-4 py-3" onClick={() => void load(catalogue.query.page - 1)}>Elementi precedenti</button>}
        {catalogue.hasNext && <button type="button" className="rounded-xl border px-4 py-3" onClick={() => void load(catalogue.query.page + 1)}>Altri elementi</button>}
      </nav>
      {selected.some(choice => !pageKeys.has(technicalWorkItemOptionKey(choice.option))) && <section aria-label="Scelte conservate da altre pagine" className="min-w-0 space-y-3 border-t pt-3">
        <h3 className="font-bold">Scelte conservate da altre pagine</h3>
        {selected.filter(choice => !pageKeys.has(technicalWorkItemOptionKey(choice.option))).map(choice => card(choice.option))}
      </section>}
    </>}
  </fieldset>;
}
