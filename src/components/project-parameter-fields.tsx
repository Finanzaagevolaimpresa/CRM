'use client';
import { projectExpenseCategories, type ProjectParameters } from '@/lib/project-parameters-input';

const inputClass = 'w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm';
export function ProjectParameterFields({ value, onChange }: { value: ProjectParameters; onChange: (next: ProjectParameters) => void }) {
  function expense(index: number, patch: Partial<ProjectParameters['expenses'][number]>) {
    onChange({ ...value, expenses: value.expenses.map((row, position) => position === index ? { ...row, ...patch } : row) });
  }
  return <section className="crm-space-y-4 min-w-0" aria-label="Parametri e spese del progetto">
    <label className="block text-sm font-bold">Descrizione del progetto<textarea className={inputClass} rows={4} maxLength={10000} value={value.description} onChange={e => onChange({ ...value, description: e.target.value })} /></label>
    <div className="grid min-w-0 gap-3 md:grid-cols-2">
      <label className="block text-sm font-bold">Investimento totale (€)<input className={inputClass} inputMode="decimal" value={value.totalInvestment} onChange={e => onChange({ ...value, totalInvestment: e.target.value.replace(',', '.') })} /></label>
      <label className="block text-sm font-bold">Importo richiesto (€)<input className={inputClass} inputMode="decimal" value={value.requestedAmount} onChange={e => onChange({ ...value, requestedAmount: e.target.value.replace(',', '.') })} /></label>
    </div>
    <h2 className="text-lg font-bold">Spese del progetto</h2>
    <p className="text-sm text-slate-600">Gli importi usano al massimo due decimali. Le valutazioni di ammissibilità rimangono conservate; questa modifica non approva le spese.</p>
    {!value.expenses.length && <p>Nessuna spesa registrata.</p>}
    {value.expenses.map((row, index) => <fieldset key={row.id ?? `new-${index}`} className="crm-space-y-3 min-w-0 rounded-xl border p-3">
      <legend className="px-1 font-bold">Spesa {index + 1}{row.id ? '' : ' · nuova'}</legend>
      <label className="block text-sm font-bold">Categoria<select className={inputClass} value={row.category} onChange={e => expense(index, { category: e.target.value as typeof row.category })}>{projectExpenseCategories.map(category => <option key={category} value={category}>{category.replaceAll('_', ' ')}</option>)}</select></label>
      <label className="block text-sm font-bold">Descrizione spesa<input className={inputClass} maxLength={500} value={row.description} onChange={e => expense(index, { description: e.target.value })} /></label>
      <label className="block text-sm font-bold">Importo spesa (€)<input className={inputClass} inputMode="decimal" value={row.amount} onChange={e => expense(index, { amount: e.target.value.replace(',', '.') })} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={row.estimated} onChange={e => expense(index, { estimated: e.target.checked })} />Importo stimato</label>
      {!row.id && <button type="button" className="font-bold underline" onClick={() => onChange({ ...value, expenses: value.expenses.filter((_, position) => position !== index) })}>Rimuovi questa spesa non salvata</button>}
    </fieldset>)}
    <button type="button" className="rounded-xl border px-4 py-2 font-bold disabled:opacity-50" disabled={value.expenses.length >= 100} onClick={() => onChange({ ...value, expenses: [...value.expenses, { id: null, category: 'altro', description: '', amount: '', estimated: true }] })}>Aggiungi spesa</button>
    <p className="text-xs text-slate-600">Massimo 100 spese nel modulo. Le spese già registrate non vengono eliminate.</p>
  </section>;
}
