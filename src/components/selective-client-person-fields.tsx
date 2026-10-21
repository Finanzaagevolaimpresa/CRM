'use client';

import { useState, type Dispatch, type SetStateAction } from 'react';
import { maxClientPersonChoices, selectiveClientPersonFields, type ClientPersonChoice,
  type ClientPersonOption, type SelectiveClientPersonField } from '@/lib/selective-client-person-policy';

export function SelectiveClientPersonFields({ options, limited, choices, onChange }: {
  options: ClientPersonOption[]; limited: boolean; choices: ClientPersonChoice[];
  onChange: Dispatch<SetStateAction<ClientPersonChoice[]>>;
}) {
  const [search, setSearch] = useState('');
  return <fieldset className="min-w-0 space-y-3"><legend className="mb-2 font-semibold">Informazioni dei referenti da condividere</legend>
    <p className="text-sm text-slate-600">Scegli i singoli campi per ciascun referente e azienda, fino a {maxClientPersonChoices} collegamenti. Nome, cognome e recapiti non vengono inclusi automaticamente.</p>
    <label className="block">Cerca fra i referenti disponibili<input className="block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3" value={search} onChange={event => setSearch(event.target.value)} /></label>
    {!options.length && <p>Nessun referente disponibile con i permessi correnti.</p>}
    {limited && <p>Sono mostrati i primi 100 collegamenti in ordine alfabetico. Gli altri non verranno inclusi.</p>}
    <div className="max-h-96 space-y-3 overflow-y-auto">{options.filter(row => `${row.personName} ${row.companyName}`.toLocaleLowerCase('it').includes(search.toLocaleLowerCase('it'))).map(person => {
      const selected = choices.find(row => row.membershipId === person.membershipId);
      return <fieldset key={person.membershipId} className="min-w-0 rounded-xl border p-3">
        <legend className="max-w-full break-words px-1 font-semibold">{person.personName} · {person.companyName}</legend>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">{(Object.entries(selectiveClientPersonFields) as [SelectiveClientPersonField, string][]).map(([key, label]) => <label key={key} className="flex min-w-0 items-start gap-2">
          <input type="checkbox" checked={selected?.fields.includes(key) ?? false} disabled={!selected && choices.length >= maxClientPersonChoices}
            onChange={event => onChange(old => {
              const previous = old.find(row => row.membershipId === person.membershipId);
              const fields = event.target.checked ? [...(previous?.fields ?? []), key] : (previous?.fields ?? []).filter(value => value !== key);
              return [...old.filter(row => row.membershipId !== person.membershipId), ...(fields.length ? [{ membershipId: person.membershipId, companyId: person.companyId, personId: person.personId, fields }] : [])];
            })} /><span className="break-words">{label}</span></label>)}</div>
      </fieldset>;
    })}</div>
    <p className="text-sm text-slate-600">La scelta riguarda solo il collegamento indicato. Note private e altri collegamenti restano esclusi. Una modifica della persona, del collegamento o dell’azienda richiede una nuova conferma.</p>
  </fieldset>;
}
