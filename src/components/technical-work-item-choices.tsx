'use client';

import { technicalItemFields } from '@/lib/technical-work-item-grant';
import type { readTechnicalAssignmentManagement } from '@/lib/technical-assignment-management';

type Data = Awaited<ReturnType<typeof readTechnicalAssignmentManagement>>;
export type ItemChoices = Record<string, { readable: string[]; editable: string[] }>;
export function TechnicalWorkItemChoices({ data, actions, choices, onChange }: {
  data: Data; actions: string[]; choices: ItemChoices; onChange: (value: ItemChoices) => void }) {
  return <fieldset className="space-y-3"><legend className="font-bold">Checklist, attività e scadenze da includere</legend>
    <p>Scegli fino a 20 elementi e i singoli campi. Le nuove attività restano escluse. Gli stati e i collegamenti documentali non sono modificabili da qui; i documenti richiedono la scelta separata della versione.</p>
    {!data.workItemOptions.length && <p>Nessun elemento pertinente disponibile per questo record.</p>}
    {data.workItemOptions.map(item => {
      const key = `${item.kind}:${item.itemId}`, choice = choices[key];
      const enabled = actions.includes(item.kind === 'Task' ? 'manage_deadlines' : 'manage_checklist');
      return <div key={key} className="min-w-0 space-y-3 rounded-xl border p-3">
        <label className="flex items-start gap-2 break-words font-semibold"><input type="checkbox" disabled={!enabled}
          checked={!!choice && enabled} onChange={event => { const next = { ...choices };
            if (event.target.checked) next[key] = { readable: [], editable: [] }; else delete next[key]; onChange(next); }} />
          {item.kind === 'Task' ? 'Attività' : 'Checklist'} · {item.title}</label>
        {choice && enabled && <div className="grid gap-3 sm:grid-cols-2">{technicalItemFields(item.kind).map(field => <div key={field.key} className="space-y-2">
          <label className="flex items-center gap-2"><input type="checkbox" checked={choice.readable.includes(field.key)} onChange={event => onChange({ ...choices,
            [key]: { readable: event.target.checked ? [...choice.readable, field.key] : choice.readable.filter(value => value !== field.key),
              editable: event.target.checked ? choice.editable : choice.editable.filter(value => value !== field.key) } })} />{field.label}</label>
          {field.editable && <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!choice.readable.includes(field.key)}
            checked={choice.editable.includes(field.key)} onChange={event => onChange({ ...choices, [key]: { ...choice,
              editable: event.target.checked ? [...choice.editable, field.key] : choice.editable.filter(value => value !== field.key) } })} />Consenti modifica {field.label.toLocaleLowerCase('it-IT')}</label>}
        </div>)}</div>}
      </div>;
    })}
    {data.workItemsLimited && <p>Catalogo limitato ai primi 50 elementi di ciascun tipo; gli altri non sono inclusi.</p>}
  </fieldset>;
}
