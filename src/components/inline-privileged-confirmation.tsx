'use client';
import { useActionState, useState } from 'react';
import { establishPrivilegedStepUpInline } from '@/lib/privileged-access-actions';

export function InlinePrivilegedConfirmation() {
  const [attempt, setAttempt] = useState(0);
  return <Confirmation key={attempt} again={() => setAttempt(value => value + 1)} />;
}
function Confirmation({ again }: { again: () => void }) {
  const [state, action, pending] = useActionState(establishPrivilegedStepUpInline, { ok: false, message: '' });
  return <section aria-label="Conferma identità senza lasciare il lavoro" className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4">
    <h2 className="font-bold">Conferma identità senza lasciare il lavoro</h2>
    <p>Le scelte della scheda restano disponibili. La conferma non esegue incarichi, salvataggi o invii.</p>
    {!state.ok && <form action={action} data-privileged-confirmation="true" className="space-y-3">
      <label className="block font-semibold">Password corrente<input name="password" type="password" autoComplete="current-password"
        required maxLength={1024} className="block w-full max-w-md rounded-xl border p-3" /></label>
      <button disabled={pending} className="rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50">
        {pending ? 'Verifica in corso…' : 'Conferma identità e conserva le scelte'}</button>
    </form>}
    <p role="status">{state.message}</p>
    {state.ok && <button type="button" className="font-semibold underline" onClick={again}>Riconferma identità se la finestra è scaduta</button>}
  </section>;
}
