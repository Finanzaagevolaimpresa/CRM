'use client';
import { useActionState, useState } from 'react';
import { PrimaryButton } from './actions';
import { saveRecordProfileAction } from '@/lib/record-profile-actions';
import type { ProfileField } from '@/lib/record-profile-fields';
const clientTypes = ['persona_fisica', 'ditta_individuale', 'societa', 'professionista', 'soggetto_da_costituire', 'associazione', 'altro'];
export function RecordProfileForm({ fields, values, hidden, clientType, submitLabel = 'Salva anagrafica' }: {
  fields: ProfileField[]; values: Record<string, string>; hidden: Record<string, string>; clientType?: string; submitLabel?: string;
}) {
  const [state, action, pending] = useActionState(saveRecordProfileAction, { error: null });
  const [draft, setDraft] = useState<Record<string, string>>({ ...values, ...(clientType === undefined ? {} : { type: clientType }) });
  const update = (name: string, value: string) => setDraft(current => ({ ...current, [name]: value }));
  return <form action={action} className="crm-space-y-5">
    <p className="text-sm text-slate-600">I campi con * sono obbligatori. Gli altri possono essere completati in seguito.</p>
    {Object.entries(hidden).map(([name, value]) => <input type="hidden" key={name} name={name} value={value} />)}
    <div className="grid gap-4 md:grid-cols-2">
      {clientType !== undefined && <label className="crm-space-y-1 font-semibold">Tipo cliente *<select name="type" value={draft.type} onChange={event => update('type', event.target.value)} className="block w-full rounded-xl border p-3">{clientTypes.map(type => <option value={type} key={type}>{type.replaceAll('_', ' ')}</option>)}</select></label>}
      {fields.map(field => <label key={field.name} className={`crm-space-y-1 font-semibold ${field.type === 'textarea' ? 'md:col-span-2' : ''}`}>
        {field.label}{field.required ? ' *' : ''}
        {field.type === 'textarea' ? <textarea className="block min-h-28 w-full rounded-xl border p-3 font-normal" name={field.name} value={draft[field.name] ?? ''} onChange={event => update(field.name, event.target.value)} maxLength={field.max ?? 200} />
          : <input className="block w-full rounded-xl border p-3 font-normal" name={field.name} type={field.type ?? 'text'} value={draft[field.name] ?? ''} onChange={event => update(field.name, event.target.value)} required={field.required}
            maxLength={field.type === 'email' ? 254 : field.max ?? 200} min={field.type === 'number' ? 0 : undefined} step={field.step} />}
      </label>)}
    </div>
    {state.error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-800">{state.error}</p>}
    <PrimaryButton type="submit" disabled={pending}>{pending ? 'Salvataggio…' : submitLabel}</PrimaryButton>
  </form>;
}
