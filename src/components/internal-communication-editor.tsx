'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
import { previewInternalCommunicationAction, confirmInternalCommunicationAction, archiveInternalCommunicationAction } from '@/lib/internal-communication-actions';
import { communicationRecipientGroups } from '@/lib/communication-recipient-groups';

type Person = { id: string; name: string; email: string; role: string };
type Preview = Extract<Awaited<ReturnType<typeof previewInternalCommunicationAction>>, { status: 'PREVIEW' }>['preview'];
export function InternalCommunicationEditor({ id: initialId, version: initialVersion = 0, title = '', selectedIds = [], people, stepUpActive, restore = false }:
  { id: string; version?: number; title?: string; selectedIds?: string[]; people: Person[]; stepUpActive: boolean; restore?: boolean }) {
  const router = useRouter(), pending = useRef(false), [id] = useState(initialId), [version] = useState(initialVersion);
  const [needsStepUp, setNeedsStepUp] = useState(!stepUpActive);
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  async function prepare(form: FormData) {
    if (pending.current || uncertain) return;
    pending.current = true; setBusy(true); setPreview(null); setError('');
    try {
      const result = await previewInternalCommunicationAction({ id, expectedVersion: version, restore, title: String(form.get('title') ?? ''),
        selection: { userIds: form.getAll('participant').map(String), groups: form.getAll('group').map(String) } });
      if (result.status === 'PREVIEW') setPreview(result.preview);
      else setError('Persone o permessi sono cambiati. Aggiorna la pagina e verifica la selezione.');
    } catch { setError('Anteprima non disponibile. Aggiorna la pagina e verifica la selezione.'); }
    finally { pending.current = false; setBusy(false); }
  }
  async function confirm(form: FormData) {
    if (pending.current || uncertain || !preview || form.get('confirm') !== 'EXACT_PARTICIPANTS') return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await confirmInternalCommunicationAction(preview.input, preview.evidenceHash);
      if (result.status === 'RECORDED') { router.push(`/communications?kind=INTERNAL&practice=${result.id}`); router.refresh(); }
      else if (result.status === 'STEP_UP_REQUIRED') { setNeedsStepUp(true); setError(result.message); }
      else { setUncertain(true); setError('Esito da verificare: ricarica la conversazione prima di ripetere.'); }
    } catch { setUncertain(true); setError('Risposta non ricevuta: ricarica e verifica prima di ripetere.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="grid gap-3">
    {restore && <p>Ripristino della conversazione archiviata: scegli di nuovo i partecipanti. Nessun accesso precedente viene riattivato automaticamente.</p>}
    <form action={prepare} onReset={event => event.preventDefault()} onChange={() => setPreview(null)} className="grid gap-3">
      <fieldset disabled={busy || uncertain} className="grid min-w-0 gap-3">
      <label>Titolo della comunicazione interna<input className="w-full rounded-xl border p-2" name="title" required maxLength={200} defaultValue={title} /></label>
      <fieldset className="grid gap-2"><legend>Persone autorizzate alla conversazione</legend>
        {people.map(person => <label key={person.id} className="flex items-start gap-2 break-all"><input type="checkbox" name="participant" value={person.id} defaultChecked={selectedIds.includes(person.id)} />{person.name} · {person.email}</label>)}
      </fieldset>
      <fieldset className="grid gap-2"><legend>Seleziona le persone attuali di un reparto</legend>
        {Object.entries(communicationRecipientGroups).map(([key, group]) => <label key={key} className="flex gap-2"><input type="checkbox" name="group" value={key} />{group.label}</label>)}
      </fieldset>
      <p className="text-sm">Il titolare personale resta partecipante. Le persone confermate potranno leggere la conversazione, compreso lo storico e gli allegati ammessi. La selezione del reparto si applica alle persone mostrate nell’anteprima; nessun nuovo membro viene aggiunto in seguito automaticamente.</p>
      <button className="rounded-xl border p-2 font-bold" disabled={busy || uncertain}>Mostra riepilogo partecipanti</button>
      </fieldset>
    </form>
    {preview ? <form action={confirm} onReset={event => event.preventDefault()} className="grid gap-3 rounded-xl border p-4">
      <h3 className="font-bold">{preview.input.title} · partecipanti da confermare</h3>
      <ul className="break-all">{preview.people.map(person => <li key={person.id}>{person.name} · {person.email}</li>)}</ul>
      {preview.removedUserIds.length ? <p>Accesso revocato a {preview.removedUserIds.length} persone attualmente partecipanti.</p> : null}
      <p>Nessuna email verrà inviata. L’accesso riguarda soltanto questa conversazione interna.</p>
      <label className="flex gap-2"><input type="checkbox" name="confirm" value="EXACT_PARTICIPANTS" required />Confermo queste persone e l’accesso indicato.</label>
      <button className="rounded-xl bg-fai-navy p-2 font-bold text-white" disabled={busy || uncertain}>Conferma partecipanti</button>
    </form> : null}
    {error ? <p role="status">{error}</p> : null}
    {needsStepUp && <InlinePrivilegedConfirmation />}
    {uncertain && <a className="font-semibold underline" href={`/communications?kind=INTERNAL&practice=${id}`}>Apri la conversazione e verifica l’esito</a>}
    {version > 0 && !restore && <details className="rounded-xl border p-3"><summary className="font-semibold">Archivia la conversazione</summary>
      <form className="grid gap-3" onReset={event => event.preventDefault()} onSubmit={async event => {
        event.preventDefault(); if (pending.current || uncertain) return;
        const form = new FormData(event.currentTarget); pending.current = true; setBusy(true); setError('');
        try {
          const result = await archiveInternalCommunicationAction({ id, expectedVersion: version, confirmed: form.get('confirmed') === 'on', reason: form.get('reason') });
          if (result.status === 'RECORDED') { router.push('/communications?archived=1'); router.refresh(); }
          else if (result.status === 'STEP_UP_REQUIRED') { setNeedsStepUp(true); setError(result.message); }
          else { setUncertain(true); setError('Esito da verificare nell’archivio prima di ripetere.'); }
        } catch { setUncertain(true); setError('Risposta interrotta: verifica l’archivio prima di ripetere.'); }
        finally { pending.current = false; setBusy(false); }
      }}><p>Conserva messaggi e file e blocca l’accesso dei partecipanti. Al ripristino sceglierai di nuovo le persone autorizzate.</p>
        <label>Motivazione dell’archiviazione<textarea name="reason" required minLength={3} maxLength={2000} className="block w-full rounded-xl border p-2" /></label>
        <label><input type="checkbox" name="confirmed" required />Confermo l’archiviazione e la sospensione degli accessi.</label>
        <button disabled={busy || uncertain} className="rounded-xl border p-2 font-semibold">Archivia conversazione</button>
      </form><a className="underline" href="/communications?archived=1">Verifica l’archivio delle conversazioni</a></details>}
  </section>;
}
