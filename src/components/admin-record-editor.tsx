'use client';
import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { AdminRecordForm } from '@/lib/admin-record-catalogue';
import type { AdminRecordCommand } from '@/lib/admin-records';
import { saveAdminRecordAction, verifyAdminRecordAction, closeAdminRecordAction, type AdminSaveResult } from '@/lib/admin-record-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
import { RomeDateTimeInput } from './rome-date-time-input';
import { operationalRomeTime } from '@/lib/operational-time';
import { AdminReferenceSelect } from './admin-reference-select';

const subscribe = () => () => {}, hydrated = () => true, server = () => false;
export function AdminRecordEditor({ data, commandId, recovering = false }: { data: AdminRecordForm; commandId: string; recovering?: boolean }) {
  const ready = useSyncExternalStore(subscribe, hydrated, server);
  const [values, setValues] = useState(data.values), [reason, setReason] = useState('');
  const [evidenceVersionId, setEvidenceVersionId] = useState(''), [effectiveAt, setEffectiveAt] = useState(''), [declared, setDeclared] = useState(false);
  const canUpdate = data.fields.some(field => !field.readOnly);
  const [operation, setOperation] = useState<AdminRecordCommand['operation']>(data.create ? 'CREATE' : data.deleted ? 'RESTORE' : canUpdate ? 'UPDATE' : 'RECTIFY');
  const [pending, setPending] = useState(false), [result, setResult] = useState<AdminSaveResult | null>(recovering
    ? { ok: false, uncertain: true, message: 'Questo riferimento contiene un tentativo da verificare. Nessun salvataggio viene ripetuto automaticamente.' } : null);
  const [confirmedClose, setConfirmedClose] = useState(false);
  const [submitted, setSubmitted] = useState<AdminRecordCommand | null>(null);
  const correctingPayment = data.paymentCorrection && operation === 'UPDATE' && values.status !== data.values.status;
  const frozen = !ready || pending || Boolean(result?.uncertain || result?.ok || result?.closed);
  const fieldClass = 'block w-full rounded-xl border border-slate-300 bg-white p-3';
  const href = `/admin/records/${data.model}/${data.id}`;
  function remember(uncertain: boolean) {
    const url = new URL(window.location.href);
    if (uncertain) url.searchParams.set('decision', commandId); else url.searchParams.delete('decision');
    window.history.replaceState(window.history.state, '', url);
  }
  async function submit(replay = false) {
    if (!ready || pending || (result?.uncertain && !replay)) return;
    const command = replay && submitted ? submitted : { commandId, model: data.model, id: data.id, operation,
      expectedVersion: data.version, reason, values: operation === 'CREATE' || operation === 'UPDATE' ? values : {},
      ...(correctingPayment && declared ? { paymentCorrection: { evidenceVersionId, effectiveAt, confirmed: true as const } } : {}) };
    setSubmitted(command); setPending(true); remember(true);
    try { const saved = await saveAdminRecordAction(command); setResult(saved); if (!saved.uncertain && !saved.ok) remember(false); }
    catch { setResult({ ok: false, uncertain: true, message: 'Risposta interrotta. Il comando è conservato: verifica l’esito prima di proseguire.' }); }
    finally { setPending(false); }
  }
  return <div className="space-y-6">
    <nav className="flex flex-wrap gap-4"><Link className="underline" href={`/admin/records/${data.model}`}>Elenco</Link>
      {data.href && <Link className="underline" href={data.href}>Apri percorso operativo</Link>}
      {!data.create && <Link className="underline" target="_blank" rel="noopener" href={href}>Confronta la scheda attuale in una nuova scheda</Link>}</nav>
    {data.guidance && <p className="rounded-xl bg-slate-100 p-4">{data.guidance}</p>}
    {data.restoringRevision && <p role="status" className="rounded-xl border border-amber-300 p-4">Stai preparando il ripristino dei dati precedenti a una correzione. Controlla i valori e indica la motivazione: il salvataggio crea una nuova revisione e conserva tutte le prove.</p>}
    {data.relationships.length > 0 && <section><h2 className="font-bold">Collegamenti interessati</h2>{data.relationships.map(link => <p key={link.href}><Link className="underline" href={link.href}>{link.label}</Link></p>)}</section>}
    <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-5">
      <fieldset disabled={frozen} className="space-y-5">
        {!data.create && <label className="block font-semibold">Operazione<select className={fieldClass} value={operation}
          onChange={event => setOperation(event.target.value as AdminRecordCommand['operation'])}>
          {data.deleted ? <option value="RESTORE">Ripristina la scheda conservata</option> : <>
            {canUpdate && <option value="UPDATE">Correggi i dati operativi</option>}<option value="RECTIFY">Registra una rettifica motivata nelle evidenze</option>
            {data.trash && <option value="TRASH">Sposta nel cestino recuperabile</option>}</>}
        </select></label>}
        {(operation === 'CREATE' || operation === 'UPDATE' || !canUpdate) && <div className="grid gap-4 md:grid-cols-2">{data.fields.map(field => {
          const change = (value: string) => setValues(current => ({ ...current, [field.name]: value,
            ...Object.fromEntries(data.fields.filter(other => other.dependsOn === field.name).map(other => [other.name, ''])) }));
          return <fieldset key={field.name} disabled={field.readOnly} className={['longtext', 'json'].includes(field.type) ? 'min-w-0 md:col-span-2' : 'min-w-0'}>
            {field.reference ? <AdminReferenceSelect key={field.name + (field.dependsOn ? values[field.dependsOn] : '')} model={data.model} field={field}
              value={values[field.name]} entityType={field.dependsOn ? values[field.dependsOn] : undefined} onChange={change} />
              : field.type === 'date' ? <RomeDateTimeInput label={field.label} value={values[field.name]} onChange={change} required={field.required} className={fieldClass} />
              : <label className="block font-semibold">{field.label}
                {field.type === 'boolean' ? <select className={fieldClass} value={values[field.name]} onChange={event => change(event.target.value)}><option value="true">Sì</option><option value="false">No</option></select>
                  : field.type === 'select' ? <select className={fieldClass} required={field.required} value={values[field.name]} onChange={event => change(event.target.value)}>
                    <option value="">Nessuna selezione</option>{field.options?.filter(option => !field.dependsOn || option.group === values[field.dependsOn])
                      .map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                  : ['longtext', 'json'].includes(field.type) ? <textarea className={fieldClass} rows={5} required={field.required} value={values[field.name]} onChange={event => change(event.target.value)} />
                    : <input className={fieldClass} required={field.required} type={field.type === 'number' ? 'number' : 'text'}
                      step={field.type === 'number' ? 'any' : undefined} value={values[field.name]} onChange={event => change(event.target.value)} />}
              </label>}
            {field.help && <p className="text-sm">{field.help}</p>}
            {field.readOnly && <p className="text-sm">Valore storico conservato. Usa la rettifica o il percorso di nuova bozza indicato sopra.</p>}
          </fieldset>;
        })}</div>}
        {correctingPayment && <section aria-label="Prova della rettifica del pagamento" className="space-y-4 rounded-xl border border-amber-400 p-4">
          <h2 className="font-bold">Rettifica documentata del pagamento</h2>
          <p>L’incasso originario, la sua data e la sua prova restano conservati. I servizi collegati ricevono lo stesso aggiornamento contabile. Il CRM non esegue rimborsi o trasferimenti di denaro.</p>
          <AdminReferenceSelect model="Payment" field={{ name: 'administrativeEvidenceVersionId', label: 'Documento e versione a prova della rettifica', type: 'select', required: true, reference: true, options: [] }} value={evidenceVersionId} onChange={setEvidenceVersionId} />
          <RomeDateTimeInput label="Data effettiva della rettifica documentata" value={effectiveAt} onChange={setEffectiveAt} required className={fieldClass} />
          <label className="flex gap-3"><input type="checkbox" required checked={declared} onChange={event => setDeclared(event.target.checked)} />Dichiaro di avere verificato la prova e lo stato amministrativo indicato; non sto registrando un nuovo incasso.</label>
        </section>}
        {operation === 'RECTIFY' && <p>La rettifica viene aggiunta al registro della scheda. Non cambia il contenuto originale, non sostituisce una firma e non attesta una consegna o una presa in carico.</p>}
        {operation === 'TRASH' && <p>Il record e il suo contenuto vengono conservati per il ripristino. I collegamenti e le prove storiche non vengono ricreati.</p>}
        <label className="block font-semibold">Motivazione della correzione<textarea required minLength={3} maxLength={2000} className={fieldClass}
          value={reason} onChange={event => setReason(event.target.value)} /></label>
        <button type="submit" className="rounded-xl bg-blue-900 px-5 py-3 font-bold text-white">{pending ? 'Registrazione…' : 'Salva operazione'}</button>
      </fieldset>
    </form>
    {result && <p role="status" className="rounded-xl border p-4">{result.message}</p>}
    {result?.stepUp && <InlinePrivilegedConfirmation />}
    {result?.uncertain && <section className="space-y-3 rounded-xl border border-amber-400 p-4" aria-label="Riconciliazione del salvataggio">
      <p>Riferimento: <code>{commandId}</code>. Le scelte sono bloccate fino alla riconciliazione.</p>
      <div className="flex flex-wrap gap-3"><button disabled={pending} className="underline" onClick={async () => {
        setPending(true); try { setResult(await verifyAdminRecordAction(commandId)); }
        catch { setResult({ ok: false, uncertain: true, message: 'Verifica non disponibile. Il comando rimane conservato.' }); }
        finally { setPending(false); }
      }}>Verifica esito</button>{submitted && <button disabled={pending} className="underline" onClick={() => void submit(true)}>Riprendi lo stesso comando</button>}</div>
      <label className="flex gap-2"><input type="checkbox" checked={confirmedClose} onChange={event => setConfirmedClose(event.target.checked)} />Riconcilia le operazioni ancora in corso e chiudi questo tentativo soltanto se non risulta registrato.</label>
      <button disabled={pending || !confirmedClose} className="underline disabled:opacity-50" onClick={async () => {
        setPending(true); try { setResult(await closeAdminRecordAction({ commandId, model: data.model, id: data.id })); }
        catch { setResult({ ok: false, uncertain: true, message: 'La riconciliazione non è confermata. Riprova la verifica.' }); }
        finally { setPending(false); }
      }}>Riconcilia e chiudi il tentativo</button>
    </section>}
    {result?.ok && <Link className="inline-block rounded-xl bg-green-800 px-5 py-3 text-white" href={href}>Riapri e verifica il salvataggio</Link>}
    {result?.closed && <Link className="underline" href={data.create ? `/admin/records/${data.model}/new?draft=${data.id}` : href}>Riapri per una nuova operazione</Link>}
    <section className="space-y-3"><h2 className="text-xl font-bold">Correzioni e rettifiche registrate</h2>
      {!data.history.length && <p>Nessuna correzione amministrativa registrata da questa funzione.</p>}
      {data.history.map(row => <article key={row.id} className="space-y-2 rounded-xl border p-3"><p>{({ CREATE: 'Creazione', UPDATE: 'Correzione dati', TRASH: 'Cestino', RESTORE: 'Ripristino', RECTIFY: 'Rettifica annotata' } as Record<string, string>)[row.action]} · {operationalRomeTime(row.at)} · {row.actor}</p><p className="whitespace-pre-wrap">{row.reason}</p>
        {row.canRestore && <Link className="underline" href={`${href}?restoreRevision=${row.id}`}>Prepara il ripristino dei dati precedenti</Link>}</article>)}
    </section>
  </div>;
}
