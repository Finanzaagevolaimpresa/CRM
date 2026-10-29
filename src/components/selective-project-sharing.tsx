'use client';

import { useActionState, useState } from 'react';
import { confirmSharing, prepareSharingPreview, revokeSharing, type SharingState } from '@/lib/selective-project-actions';
import { selectiveProjectFields, type SelectiveProjectField } from '@/lib/selective-project-policy';
import { SelectiveProjectView } from './selective-project-view';

const initial: SharingState = { ok: false, message: '' };
type Grant = { id: string; recipientId: string; revision: number; revoked: boolean; suspended: boolean; expiresAt: string | null };
export function SelectiveProjectSharing({ projectId, recipients, documents, grants }: {
  projectId: string; recipients: { id: string; name: string; email: string; role: string }[];
  documents: { versionId: string; title: string; fileName: string; version: number }[]; grants: Grant[];
}) {
  const [recipientId, setRecipient] = useState('');
  const [fields, setFields] = useState<SelectiveProjectField[]>([]);
  const [selected, setDocuments] = useState<Record<string, boolean>>({});
  const [expires, setExpires] = useState('');
  const [preview, prepare, preparing] = useActionState(prepareSharingPreview, initial);
  const [confirmation, confirm, confirming] = useActionState(confirmSharing, initial);
  const [generation, setGeneration] = useState(0), [previewGeneration, setPreviewGeneration] = useState(-1);
  const grant = grants.find(row => row.recipientId === recipientId);
  const selection = { projectId, recipientId, revision: grant?.revision ?? 0, fields,
    documents: Object.entries(selected).map(([versionId, download]) => ({ versionId, download })),
    expiresAt: expires ? new Date(expires).toISOString() : null };
  const changed = () => setGeneration(value => value + 1);
  return <div className="space-y-6">
    <form action={prepare} onSubmit={() => setPreviewGeneration(generation)} onChange={changed} className="space-y-5 rounded-xl border bg-white p-5">
      <h2 className="text-xl font-bold">Condividi accesso</h2>
      <label className="block">Persona esistente<select required value={recipientId} onChange={event => setRecipient(event.target.value)} className="block rounded border p-2">
        <option value="">Seleziona una persona</option>{recipients.map(person => <option key={person.id} value={person.id}>{person.name} · {person.email} · {person.role}</option>)}</select></label>
      <fieldset><legend className="font-semibold">Informazioni selezionate</legend><div className="grid gap-2 md:grid-cols-2">
        {(Object.entries(selectiveProjectFields) as [SelectiveProjectField, string][]).map(([key, label]) => <label key={key}><input type="checkbox" checked={fields.includes(key)}
          onChange={event => setFields(old => event.target.checked ? [...old, key] : old.filter(value => value !== key))} /> {label}</label>)}
      </div></fieldset>
      <fieldset><legend className="font-semibold">Documenti e versioni</legend><p className="text-sm">Scegli ogni versione. Nuovi documenti e versioni future restano esclusi. Sono consultabili PDF, testo, PNG e JPEG ordinari; i vincoli documentali restano applicati.</p>
        <div className="space-y-2">{documents.map(doc => <div key={doc.versionId} className="rounded border p-2"><label><input type="checkbox" checked={doc.versionId in selected}
          onChange={event => setDocuments(old => event.target.checked ? { ...old, [doc.versionId]: false } : Object.fromEntries(Object.entries(old).filter(([key]) => key !== doc.versionId)))} /> {doc.title} — v{doc.version} ({doc.fileName})</label>
          {doc.versionId in selected && <label className="ml-4"><input type="checkbox" checked={selected[doc.versionId]} onChange={event => setDocuments(old => ({ ...old, [doc.versionId]: event.target.checked }))} /> Consenti scaricamento</label>}</div>)}</div>
      </fieldset>
      <label className="block">Scadenza facoltativa<input type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} className="ml-3 rounded border p-2" /></label>
      <input type="hidden" name="selection" value={JSON.stringify(selection)} />
      <button type="submit" disabled={preparing || !recipientId} className="rounded bg-blue-900 px-4 py-2 text-white">{preparing ? 'Preparazione…' : 'Anteprima come utente'}</button>
      <p role="status">{preview.message}</p>
    </form>
    {preview.preview && previewGeneration === generation && !confirmation.ok && <>
      <div className="rounded border border-amber-500 p-4"><h2 className="font-semibold">Impatto prima della conferma — {preview.preview.recipientName} · {preview.preview.recipientEmail}</h2>
        <p>{preview.preview.impact.previouslyFullProjectAccess ? 'La persona dispone già di accesso ordinario al progetto: verrà sostituito dalla sola selezione.' : 'La persona potrà consultare soltanto la selezione approvata.'}</p>
        <p>Ruoli globali, assegnazioni, perimetri cliente e override non amplieranno questa selezione. Modifica, caricamento, invio e assegnazione saranno bloccati sul progetto. Gli altri fascicoli mantengono i propri permessi.</p>
        {preview.preview.impact.replacesPreviousSelection && <p>Questa conferma sostituirà la precedente selezione.</p>}
        <p>Dopo revoca o scadenza, i permessi più ampi precedenti non si riattiveranno automaticamente.</p>
      </div>
      <SelectiveProjectView projection={preview.preview.projection} preview previewToken={preview.preview.token} />
      <form action={confirm} className="space-y-3"><input type="hidden" name="token" value={preview.preview.token} />
        <label className="block"><input required name="personalConfirmation" type="checkbox" /> Confermo personalmente la selezione e l’impatto indicati.</label>
        <p className="text-sm">È richiesta la conferma di sicurezza dell’account privilegiato autorizzato.</p>
        <button disabled={confirming} className="rounded bg-blue-900 px-4 py-2 text-white">Conferma accesso</button>
      </form>
    </>}
    <p role="status">{confirmation.message}</p>
    <section><h2 className="text-xl font-bold">Concessioni precedenti</h2>{grants.map(row => <Revoke key={`${row.id}:${row.revision}`} grant={row} name={recipients.find(person => person.id === row.recipientId)?.name ?? 'Persona non attiva'} />)}</section>
  </div>;
}
function Revoke({ grant, name }: { grant: Grant; name: string }) {
  const [state, action, pending] = useActionState(revokeSharing, initial);
  return <form action={action} className="my-3 rounded border p-3"><p>{name} · revisione {grant.revision} · {grant.revoked ? 'Revocata' : grant.suspended ? 'Sospesa: serve una nuova anteprima e conferma personale' : grant.expiresAt ? `Scadenza ${grant.expiresAt}` : 'Senza scadenza'}</p>
    <input type="hidden" name="grantId" value={grant.id} /><input type="hidden" name="revision" value={grant.revision} />
    {!grant.revoked && !state.ok && <button disabled={pending} className="underline">Revoca accesso</button>}<p role="status">{grant.revoked ? 'Accesso revocato.' : state.message}</p>
  </form>;
}
