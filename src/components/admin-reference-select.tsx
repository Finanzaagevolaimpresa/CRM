'use client';
import { useRef, useState } from 'react';
import type { AdminField } from '@/lib/admin-record-catalogue';
import { searchAdminRecordReferencesAction } from '@/lib/admin-record-actions';

export function AdminReferenceSelect({ model, field, value, entityType, onChange, lookup }: {
  model: string; field: AdminField; value: string; entityType?: string; onChange: (value: string) => void;
  lookup?: (input: { model: string; field: string; query: string; page: number }) => Promise<{ options: NonNullable<AdminField['options']>; hasNext: boolean } | { error: string }>;
}) {
  const initial = (field.options ?? []).filter(option => !field.dependsOn || option.group === entityType);
  const [options, setOptions] = useState(initial), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(initial.length >= 50), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), [lastQuery, setLastQuery] = useState('');
  async function search(next: number) {
    if (pending.current || (field.dependsOn && !entityType)) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await (lookup ?? searchAdminRecordReferencesAction)({ model, field: field.name, query, page: next,
        ...(entityType ? { entityType } : {}) });
      if ('error' in result) { setError(result.error); return; }
      setOptions(current => [...current.filter(option => option.value === value && !result.options.some(found => found.value === value)), ...result.options]);
      setPage(next); setLastQuery(query); setHasNext(result.hasNext);
    } catch { setError('Ricerca interrotta. Il collegamento scelto resta conservato.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="space-y-2">
    <label className="block font-semibold">{field.label}<select aria-label={field.label} className="block w-full rounded-xl border p-3" value={value}
      required={field.required} onChange={event => onChange(event.target.value)} disabled={busy}>
      <option value="">Nessuna selezione</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>
    {!field.readOnly && <div className="space-y-2 rounded-xl bg-slate-50 p-2">
      <label className="block text-sm">Cerca {field.label}<input aria-label={`Cerca ${field.label}`} className="block w-full rounded-xl border p-2" value={query} maxLength={200}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search(1); } }} /></label>
      <div className="flex flex-wrap gap-3"><button type="button" disabled={busy || Boolean(field.dependsOn && !entityType)} className="underline" onClick={() => void search(1)}>Cerca collegamenti</button>
        <button type="button" disabled={busy || page === 1 || query !== lastQuery} className="underline disabled:opacity-40" onClick={() => void search(page - 1)}>Precedenti</button>
        <button type="button" disabled={busy || !hasNext || query !== lastQuery} className="underline disabled:opacity-40" onClick={() => void search(page + 1)}>Successivi</button></div>
      <p className="text-sm">Pagina {page} · fino a 50 risultati. {busy ? 'Ricerca in corso…' : 'La ricerca non cambia il collegamento selezionato.'}</p>
      {error && <p role="status">{error}</p>}
    </div>}
  </div>;
}
