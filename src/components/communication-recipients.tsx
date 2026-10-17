'use client';

import { useState } from 'react';
import type { CommunicationRecipientSelection } from '@/lib/communication-recipient-policy';
import { communicationRecipientGroups } from '@/lib/communication-recipient-groups';

type Person = { id: string; name: string; email: string; role: string };
const bucketNames = { to: 'A', cc: 'CC', bcc: 'BCC' } as const;
type Bucket = keyof typeof bucketNames;
const keys = Object.keys(bucketNames) as Bucket[];
type Group = keyof typeof communicationRecipientGroups;
export function CommunicationRecipients({ directory, internal, participantIds, initialSelection, initialExternal, suggestedRecipients = [] }:
  { directory: Person[]; internal: boolean; participantIds?: string[]; initialSelection?: CommunicationRecipientSelection;
    initialExternal?: Record<Bucket, string[]>; suggestedRecipients?: Array<{ name: string; address: string }> }) {
  const [external,setExternal] = useState<Record<Bucket,string>>({ to: initialExternal?.to.join(', ') ?? '', cc: initialExternal?.cc.join(', ') ?? '', bcc: initialExternal?.bcc.join(', ') ?? '' });
  const [selection, setSelection] = useState<CommunicationRecipientSelection>(initialSelection ?? {
    to: { userIds: [], groups: [] }, cc: { userIds: [], groups: [] }, bcc: { userIds: [], groups: [] },
  });
  const allowed = directory.filter(person => !internal || participantIds?.includes(person.id));
  const selected = (key: Bucket) => allowed.filter(person => selection[key].userIds.includes(person.id)
    || selection[key].groups.some(group => (communicationRecipientGroups[group].roles as readonly string[]).includes(person.role)));
  function toggle(key: Bucket, kind: 'userIds' | 'groups', id: string, checked: boolean) {
    setSelection(previous => ({ ...previous, [key]: { ...previous[key], [kind]: checked
      ? [...previous[key][kind], id] : previous[key][kind].filter(value => value !== id) } }));
  }
  return <fieldset className="grid min-w-0 gap-3 rounded-xl border p-3"><legend>Destinatari espliciti</legend>
    <input type="hidden" name="recipientSelection" value={JSON.stringify(selection)} />
    {keys.map(key => <section key={key} aria-label={`Destinatari ${bucketNames[key]}`} className="grid min-w-0 gap-2">
      <h4 className="font-bold">{bucketNames[key]}</h4>
      {!internal ? <><label>Indirizzi esterni · separati da virgola<input className="w-full rounded-xl border p-2" name={key} value={external[key]} onChange={event=>setExternal(previous=>({...previous,[key]:event.target.value}))} /></label>
        {suggestedRecipients.map(suggestedRecipient=><button key={suggestedRecipient.address} type="button" className="break-all text-left text-sm underline" onClick={()=>setExternal(previous=>({...previous,[key]:[...new Set([...previous[key].split(/[,;\n]+/).map(value=>value.trim()).filter(Boolean),suggestedRecipient.address])].join(', ')}))}>
          Aggiungi in {bucketNames[key]} il contatto del contesto: {suggestedRecipient.name} · {suggestedRecipient.address}
        </button>)}</> : <input type="hidden" name={key} value="" />}
      <details><summary className="cursor-pointer font-bold">Persone e reparti interni</summary>
        <div className="my-2 grid gap-2 md:grid-cols-2">{Object.entries(communicationRecipientGroups).map(([id, group]) => {
          const members = directory.filter(person => (group.roles as readonly string[]).includes(person.role));
          const admitted = members.length > 0 && members.every(person => !internal || participantIds?.includes(person.id));
          return <label key={id} className="flex items-start gap-2"><input type="checkbox" checked={selection[key].groups.includes(id as Group)}
            disabled={!admitted} onChange={event => toggle(key, 'groups', id, event.target.checked)} />{group.label}{!admitted ? ' · nessun membro o partecipanti non ammessi' : ''}</label>;
        })}</div>
        <div className="grid gap-2">{allowed.map(person => <label key={person.id} className="flex items-start gap-2 break-all"><input type="checkbox"
          checked={selection[key].userIds.includes(person.id)} onChange={event => toggle(key, 'userIds', person.id, event.target.checked)} />{person.name} · {person.email}</label>)}</div>
      </details>
      <ul className="break-all text-sm" aria-label={`Destinatari interni ${bucketNames[key]}`}>{selected(key).map(person => <li key={person.id}>{person.name} · {person.email}</li>)}</ul>
    </section>)}
    <p className="text-sm">Massimo 20 indirizzi complessivi, senza duplicati tra A, CC e BCC. Destinatari e appartenenza ai reparti saranno ricontrollati prima dell’invio. La scelta di un destinatario non concede accesso al record.</p>
  </fieldset>;
}
