'use client';

import { useRef, useState } from 'react';
import { canPreviewSelectedDocument } from '@/lib/selected-document-formats';
import type { readTechnicalAssignmentManagement } from '@/lib/technical-assignment-management';
import type { TechnicalDocumentCatalogue, TechnicalDocumentChoices as Choices,
  TechnicalDocumentOption } from '@/lib/technical-document-catalog';

type Data = Awaited<ReturnType<typeof readTechnicalAssignmentManagement>>;
export type TechnicalDocumentCatalogueAction = (raw: unknown) => Promise<{
  ok: boolean; message: string; catalogue?: TechnicalDocumentCatalogue }>;

export function TechnicalDocumentChoices({ data, choices, onChange, catalogueAction, onReady }: {
  data: Data; choices: Choices; onChange: (value: Choices) => void;
  catalogueAction: TechnicalDocumentCatalogueAction; onReady: (ready: boolean) => void }) {
  const [catalogue, setCatalogue] = useState<TechnicalDocumentCatalogue | null>(data.documentCatalogueAvailable ? data.documentCatalogue : null);
  const [term, setTerm] = useState(''), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(data.documentCatalogueAvailable ? '' : 'Catalogo documenti non disponibile. La revoca degli incarichi resta disponibile.');
  const inFlight = useRef(false), selected = Object.values(choices);
  async function load(page: number, search = false) {
    if (inFlight.current || !data.recipient) return;
    inFlight.current = true; setBusy(true); onReady(false); setMessage('Caricamento delle versioni…');
    try {
      const result = await catalogueAction({ reference: { ...data.target, recipientId: data.recipient.id },
        contextSha256: data.contextSha256, recipientEpoch: data.recipient.epoch,
        query: { query: search ? term : catalogue?.query.query ?? '', page } });
      if (!result.ok || !result.catalogue) { setCatalogue(null); setMessage(result.message); return; }
      setCatalogue(result.catalogue); setMessage(result.message); onReady(true);
    } catch { setCatalogue(null); setMessage('Catalogo documenti non disponibile. Riprova la ricerca o ricarica; nessuna versione è stata condivisa.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function card(raw: TechnicalDocumentOption) {
    const choice = choices[raw.fileId], doc = choice?.option ?? raw;
    return <div key={doc.fileId} className="min-w-0 space-y-3 rounded-xl border p-3">
      <label className="flex items-start gap-2 break-words"><input type="checkbox" checked={!!choice}
        disabled={!choice && selected.length >= 20} onChange={event => {
          const next = { ...choices };
          if (event.target.checked) next[doc.fileId] = { option: doc, download: false }; else delete next[doc.fileId];
          onChange(next);
        }} />{doc.title} · {doc.fileName} · versione {doc.version}</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!choice}
        checked={choice?.download === true} onChange={event => { if (choice) onChange({ ...choices,
          [doc.fileId]: { ...choice, download: event.target.checked } }); }} />
        {canPreviewSelectedDocument(doc) ? 'Consenti anche il download' : 'Consenti il download (necessario per aprire il file)'}</label>
      {choice && <button type="button" className="rounded-lg border px-3 py-2 underline" onClick={() => {
        const next = { ...choices }; delete next[doc.fileId]; onChange(next);
      }}>Rimuovi questa versione</button>}
    </div>;
  }
  const pageIds = new Set(catalogue?.options.map(row => row.fileId));
  return <fieldset className="min-w-0 space-y-3" disabled={busy}><legend className="font-bold">Documenti e versioni da includere</legend>
    <p>Massimo 20 versioni, scelte singolarmente. Lettura e download sono scelte separate. Le versioni future restano escluse; contratti e pagamenti restano riservati.</p>
    <label className="block font-semibold">Cerca documenti e versioni<input className="block w-full min-w-0 rounded-xl border p-3" maxLength={200}
      value={term} onChange={event => setTerm(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); void load(1, true); }
      }} /></label>
    <button type="button" className="rounded-xl border px-4 py-3 font-semibold" onClick={() => void load(1, true)}>Cerca nel catalogo documenti</button>
    <p role="status">{message}</p>
    {catalogue && <>
      <p>Pagina {catalogue.query.page} · {selected.length} versioni scelte. Le scelte restano conservate tra le pagine e saranno ricontrollate nell’anteprima.</p>
      {!catalogue.options.length && <p>Nessuna versione pertinente per questa ricerca e pagina.</p>}
      {catalogue.options.map(card)}
      <nav aria-label="Pagine del catalogo documenti" className="flex flex-wrap gap-3">
        {catalogue.query.page > 1 && <button type="button" className="rounded-xl border px-4 py-3" onClick={() => void load(catalogue.query.page - 1)}>Versioni precedenti</button>}
        {catalogue.hasNext && <button type="button" className="rounded-xl border px-4 py-3" onClick={() => void load(catalogue.query.page + 1)}>Altre versioni</button>}
      </nav>
      {selected.some(choice => !pageIds.has(choice.option.fileId)) && <section aria-label="Versioni conservate da altre pagine" className="min-w-0 space-y-3 border-t pt-3">
        <h3 className="font-bold">Versioni conservate da altre pagine</h3>
        {selected.filter(choice => !pageIds.has(choice.option.fileId)).map(choice => card(choice.option))}
      </section>}
    </>}
  </fieldset>;
}
