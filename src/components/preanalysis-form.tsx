'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { PreAnalysisFormState } from '@/lib/form-actions';

const initialState: PreAnalysisFormState = { status: 'idle' };
const fields = [
  ['internalSummary', 'Sintesi interna', 'Annota una sintesi esclusivamente interna.'],
  ['scenarioA', 'Scenario A', 'Descrivi lo scenario da valutare, senza conclusioni automatiche.'],
  ['scenarioB', 'Scenario B', 'Descrivi l’eventuale scenario alternativo.'],
  ['blockingConditions', 'Condizioni bloccanti', 'Indica soltanto condizioni riscontrate o da verificare.'],
  ['requiredDocuments', 'Documenti richiesti', 'Elenca i documenti necessari alla verifica.'],
] as const;

function SubmitButton({ creating }: { creating: boolean }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="rounded-xl bg-fai-blue px-5 py-3 font-bold text-white disabled:cursor-wait disabled:opacity-60">{pending ? 'Salvataggio…' : creating ? 'Crea bozza interna' : 'Salva modifiche'}</button>;
}

export function PreAnalysisForm({ action, hidden, values = {}, creating = false }: { action: (state: PreAnalysisFormState, form: FormData) => Promise<PreAnalysisFormState>; hidden: Record<string, string>; values?: Partial<Record<(typeof fields)[number][0], string | null>>; creating?: boolean }) {
  const [state, formAction] = useActionState(action, initialState);
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map(([name]) => [name, values[name] ?? ''])));
  return <form action={formAction} className="space-y-5">
    {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={name === 'version' ? state.version ?? value : value} />)}
    {fields.map(([name, label, help]) => <label key={name} className="block text-sm font-bold text-fai-navy">{label}<span className="mt-1 block text-xs font-normal text-slate-500">{help} Massimo 5.000 caratteri.</span><textarea name={name} value={draft[name]} onChange={(event) => setDraft((current) => ({ ...current, [name]: event.target.value }))} maxLength={5000} rows={name === 'internalSummary' ? 4 : 6} className="mt-2 w-full rounded-xl border border-slate-200 p-3 font-normal text-slate-900" /></label>)}
    {state.message ? <p role="status" className={`rounded-xl p-3 text-sm font-semibold ${state.status === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>{state.message}</p> : null}
    <SubmitButton creating={creating} />
  </form>;
}
