'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { previewInternalCommunicationAction, confirmInternalCommunicationAction } from '@/lib/internal-communication-actions';
import { communicationRecipientGroups } from '@/lib/communication-recipient-groups';

type Person = { id: string; name: string; email: string; role: string };
type Preview = Extract<Awaited<ReturnType<typeof previewInternalCommunicationAction>>, { status: 'PREVIEW' }>['preview'];
export function InternalCommunicationEditor({ id, version = 0, title = '', selectedIds = [], people, stepUpActive }:
  { id: string; version?: number; title?: string; selectedIds?: string[]; people: Person[]; stepUpActive: boolean }) {
  const router = useRouter(), pending = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  async function prepare(form: FormData) {
    if (pending.current || uncertain) return;
    pending.current = true; setBusy(true); setPreview(null); setError('');
    try {
      const result = await previewInternalCommunicationAction({ id, expectedVersion: version, title: String(form.get('title') ?? ''),
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
      else { setUncertain(true); setError('Esito da verificare: ricarica la conversazione prima di ripetere.'); }
    } catch { setUncertain(true); setError('Risposta non ricevuta: ricarica e verifica prima di ripetere.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="grid gap-3">
    <form action={prepare} onChange={() => setPreview(null)} className="grid gap-3">
      <label>Titolo della comunicazione interna<input className="w-full rounded-xl border p-2" name="title" required maxLength={200} defaultValue={title} /></label>
      <fieldset className="grid gap-2"><legend>Persone autorizzate alla conversazione</legend>
        {people.map(person => <label key={person.id} className="flex items-start gap-2 break-all"><input type="checkbox" name="participant" value={person.id} defaultChecked={selectedIds.includes(person.id)} />{person.name} · {person.email}</label>)}
      </fieldset>
      <fieldset className="grid gap-2"><legend>Seleziona le persone attuali di un reparto</legend>
        {Object.entries(communicationRecipientGroups).map(([key, group]) => <label key={key} className="flex gap-2"><input type="checkbox" name="group" value={key} />{group.label}</label>)}
      </fieldset>
      <p className="text-sm">Il titolare personale resta partecipante. Le persone confermate potranno leggere la conversazione, compreso lo storico e gli allegati ammessi. La selezione del reparto si applica alle persone mostrate nell’anteprima; nessun nuovo membro viene aggiunto in seguito automaticamente.</p>
      <button className="rounded-xl border p-2 font-bold" disabled={busy || uncertain}>Mostra riepilogo partecipanti</button>
    </form>
    {preview ? <form action={confirm} className="grid gap-3 rounded-xl border p-4">
      <h3 className="font-bold">{preview.input.title} · partecipanti da confermare</h3>
      <ul className="break-all">{preview.people.map(person => <li key={person.id}>{person.name} · {person.email}</li>)}</ul>
      {preview.removedUserIds.length ? <p>Accesso revocato a {preview.removedUserIds.length} persone attualmente partecipanti.</p> : null}
      <p>Nessuna email verrà inviata. L’accesso riguarda soltanto questa conversazione interna.</p>
      <label className="flex gap-2"><input type="checkbox" name="confirm" value="EXACT_PARTICIPANTS" required />Confermo queste persone e l’accesso indicato.</label>
      {!stepUpActive ? <a href="/settings/security" className="underline">Esegui la conferma privilegiata prima di salvare</a> : null}
      <button className="rounded-xl bg-fai-navy p-2 font-bold text-white" disabled={busy || uncertain || !stepUpActive}>Conferma partecipanti</button>
    </form> : null}
    {error ? <p role="status">{error}</p> : null}
  </section>;
}
