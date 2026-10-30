'use client';

export function sharingLocalExpiry(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
}

/** Retain an existing exact choice until the Admin explicitly removes it.
 * Never silently replace an unavailable version with the latest upload. */
export function UnavailableSharingChoices({ label, ids, remove }: { label: string; ids: string[]; remove: (id: string) => void }) {
  if (!ids.length) return null;
  return <section className="space-y-2 rounded-xl border border-amber-500 p-3" aria-label={label}>
    <p>{label}: {ids.length}. Sono conservate nella bozza. Rimuovi le scelte non più disponibili oppure riapri il contesto per verificarle. L’anteprima ricontrolla ogni autorizzazione.</p>
    {ids.map((id, index) => <div className="flex flex-wrap gap-2" key={id}><span>Scelta {index + 1} · <code>{id}</code></span><button type="button" className="underline" onClick={() => remove(id)}>Rimuovi dalla bozza</button></div>)}
  </section>;
}
