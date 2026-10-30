'use client';
import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { AdminRecordForm } from '@/lib/admin-record-catalogue';
import type { AdminRecordCommand } from '@/lib/admin-records';
import { saveAdminRecordAction, verifyAdminRecordAction, closeAdminRecordAction, prepareAdminCatalogPublicationAction, prepareAdminContextMoveAction, type AdminSaveResult } from '@/lib/admin-record-actions';
import { AdminCatalogRevisionContent } from './admin-catalog-revision-content';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
import { RomeDateTimeInput } from './rome-date-time-input';
import { operationalRomeTime } from '@/lib/operational-time';
import { AdminReferenceSelect } from './admin-reference-select';

const subscribe = () => () => {}, hydrated = () => true, server = () => false;
export function AdminRecordEditor({ data, commandId, recovering = false }: { data: AdminRecordForm; commandId: string; recovering?: boolean }) {
  const ready = useSyncExternalStore(subscribe, hydrated, server);
  const [values, setValues] = useState(data.values), [reason, setReason] = useState('');
  const [evidenceVersionId, setEvidenceVersionId] = useState(''), [effectiveAt, setEffectiveAt] = useState(''), [declared, setDeclared] = useState(false);
  const [noticeReviewed, setNoticeReviewed] = useState(false);
  const [catalogBinding, setCatalogBinding] = useState<{ serviceId: string; serviceCode: string; hash: string; name: string; digitalProjectTypes: unknown; activeVersions: { version: number; name: string; contentHash: string }[] } | null>(null);
  const [catalogConfirmed, setCatalogConfirmed] = useState(false);
  const [catalogContentReady, setCatalogContentReady] = useState(false);
  const publishingCatalog = data.model === 'ServiceCatalogRevision' && data.create;
  const boundCatalog = catalogBinding?.serviceId === values.serviceCatalogId ? catalogBinding : null;
  const [graphBinding, setGraphBinding] = useState<{ hash: string; blocked: string[]; rows: { model: string; id: string; label: string; changedFields: string[] }[]; draft: string } | null>(null);
  const [graphConfirmed, setGraphConfirmed] = useState(false);
  const boundGraph = graphBinding?.draft === JSON.stringify(values) ? graphBinding : null;
  const canUpdate = data.fields.some(field => !field.readOnly);
  const [operation, setOperation] = useState<AdminRecordCommand['operation']>(data.create ? 'CREATE' : data.deleted ? 'RESTORE' : canUpdate ? 'UPDATE' : 'RECTIFY');
  const needsContextMove = !data.create && operation === 'UPDATE' && ['Company', 'Project', 'TechnicalPractice'].includes(data.model)
    && ['clientId', 'companyId', 'projectId', 'clientServiceId', 'incorporationSubjectId'].some(name => values[name] !== data.values[name]);
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
    if (!replay && needsContextMove && (!boundGraph || boundGraph.blocked.length || !graphConfirmed)) return;
    const command = replay && submitted ? submitted : { commandId, model: data.model, id: data.id, operation,
      expectedVersion: data.version, reason, values: operation === 'CREATE' || operation === 'UPDATE' ? values : {},
      ...(needsContextMove && boundGraph && graphConfirmed ? { contextMove: { expectedGraphHash: boundGraph.hash, confirmed: true as const } } : {}),
      ...(correctingPayment && declared ? { paymentCorrection: { evidenceVersionId, effectiveAt, confirmed: true as const } } : {}),
      ...(data.noticeLifecycle?.action && noticeReviewed && operation === 'UPDATE'
        ? { noticeLifecycle: { action: data.noticeLifecycle.action, contentHash: data.noticeLifecycle.contentHash, reviewed: true as const } } : {}),
      ...(publishingCatalog && boundCatalog && catalogConfirmed ? { catalogPublication: { expectedCurrentHash: boundCatalog.hash, confirmed: true as const } } : {}),
      ...(data.revokeDelivery && operation === 'UPDATE' ? { deliveryRevocation: true as const } : {}) };
    setSubmitted(command); setPending(true); remember(true);
    try { const saved = await saveAdminRecordAction(command); setResult(saved); if (!saved.uncertain && !saved.ok) remember(false); }
    catch { setResult({ ok: false, uncertain: true, message: 'Risposta interrotta. Il comando è conservato: verifica l’esito prima di proseguire.' }); }
    finally { setPending(false); }
  }
  return <div className="space-y-6">
    <nav className="flex flex-wrap gap-4"><Link className="underline" href={`/admin/records/${data.model}`}>Elenco</Link>
      {data.href && !data.create && <Link className="underline" href={data.href}>Apri percorso operativo</Link>}
      {!data.create && <Link className="underline" target="_blank" rel="noopener" href={href}>Confronta la scheda attuale in una nuova scheda</Link>}</nav>
    {data.model === 'ServiceCatalogRevision' && !data.create && <Link className="font-bold underline" href={`/admin/records/ServiceCatalogRevision/new?copyFrom=${data.id}`}>Prepara una nuova revisione da questi contenuti</Link>}
    {data.guidance && <p className="rounded-xl bg-slate-100 p-4">{data.guidance}</p>}
    {data.noticeLifecycle && <p>Stato informativa: {data.noticeLifecycle.status}.
      {data.noticeLifecycle.effectiveFrom && ' Attiva dal ' + operationalRomeTime(data.noticeLifecycle.effectiveFrom) + '.'}
      {data.noticeLifecycle.retiredAt && ' Ritirata il ' + operationalRomeTime(data.noticeLifecycle.retiredAt) + '.'}</p>}
    {data.restoringRevision && <p role="status" className="rounded-xl border border-amber-300 p-4">Stai preparando il ripristino dei dati precedenti a una correzione. Controlla i valori e indica la motivazione: il salvataggio crea una nuova revisione e conserva tutte le prove.</p>}
    {data.relationships.length > 0 && <section><h2 className="font-bold">Collegamenti interessati</h2>{data.relationships.map(link => <p key={link.href}><Link className="underline" href={link.href}>{link.label}</Link></p>)}</section>}
    <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-5">
      <fieldset disabled={frozen} className="space-y-5">
        {!data.create && <label className="block font-semibold">Operazione<select aria-label="Operazione" className={fieldClass} value={operation}
          onChange={event => setOperation(event.target.value as AdminRecordCommand['operation'])}>
          {data.deleted ? <option value="RESTORE">Ripristina la scheda conservata</option> : <>
            {canUpdate && <option value="UPDATE">Correggi i dati operativi</option>}{data.revokeDelivery && <option value="UPDATE">Revoca questa autorizzazione di consegna</option>}
            {data.noticeLifecycle?.action && <option value="UPDATE">{data.noticeLifecycle.action === 'ACTIVATE' ? 'Attiva questa versione verificata' : 'Ritira questa versione'}</option>}<option value="RECTIFY">Registra una rettifica motivata nelle evidenze</option>
            {data.trash && <option value="TRASH">Sposta nel cestino recuperabile</option>}</>}
        </select></label>}
        {(operation === 'CREATE' || operation === 'UPDATE' || !canUpdate) && <div className="grid gap-4 md:grid-cols-2">{data.fields.filter(field => !publishingCatalog || !['operationalConditions','checklist'].includes(field.name)).map(field => {
          const change = (value: string) => setValues(current => ({ ...current, [field.name]: value,
            ...Object.fromEntries(data.fields.filter(other => other.dependsOn === field.name).map(other => [other.name, ''])) }));
          return <fieldset key={field.name} disabled={field.readOnly} className={['longtext', 'json'].includes(field.type) ? 'min-w-0 md:col-span-2' : 'min-w-0'}>
            {field.reference ? <AdminReferenceSelect key={field.name + (field.dependsOn ? values[field.dependsOn] : '')} model={data.model} field={field}
              value={values[field.name]} entityType={field.dependsOn ? values[field.dependsOn] : undefined} onChange={change} />
              : field.type === 'date' ? <RomeDateTimeInput label={field.label} value={values[field.name]} onChange={change} required={field.required} className={fieldClass} />
              : <label className="block font-semibold">{field.label}
                {field.type === 'boolean' ? <select aria-label={field.label} className={fieldClass} value={values[field.name]} onChange={event => change(event.target.value)}><option value="true">Sì</option><option value="false">No</option></select>
                  : field.type === 'select' ? <select aria-label={field.label} className={fieldClass} required={field.required} value={values[field.name]} onChange={event => change(event.target.value)}>
                    <option value="">Nessuna selezione</option>{field.options?.filter(option => !field.dependsOn || option.group === values[field.dependsOn])
                      .map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                  : ['longtext', 'json'].includes(field.type) ? <textarea aria-label={field.label} className={fieldClass} rows={5} required={field.required} value={values[field.name]} onChange={event => change(event.target.value)} />
                    : <input aria-label={field.label} className={fieldClass} required={field.required} type={field.type === 'number' ? 'number' : 'text'}
                      step={field.type === 'number' ? 'any' : undefined} value={values[field.name]} onChange={event => change(event.target.value)} />}
              </label>}
            {field.help && <p className="text-sm">{field.help}</p>}
            {field.readOnly && <p className="text-sm">Valore storico conservato. Usa la rettifica o il percorso di nuova bozza indicato sopra.</p>}
          </fieldset>;
        })}</div>}

        {needsContextMove && <section aria-label="Riepilogo del nuovo contesto" className="space-y-3 rounded-xl border border-amber-400 p-4">
          <h2 className="font-bold">Schede interessate dal cambio di contesto</h2>
          <button type="button" className="underline" onClick={async () => {
            setPending(true); setGraphConfirmed(false);
            try {
              const prepared = await prepareAdminContextMoveAction({ model: data.model, id: data.id, expectedVersion: data.version, values });
              if (prepared.ok) { setGraphBinding({ ...prepared.value, draft: JSON.stringify(values) }); setResult(null); }
              else { setGraphBinding(null); setResult({ ok: false, message: prepared.message }); }
            } catch { setGraphBinding(null); setResult({ ok: false, message: 'Riepilogo non disponibile. La bozza è conservata.' }); }
            finally { setPending(false); }
          }}>Prepara il riepilogo delle schede collegate</button>
          {boundGraph && <>
            <ul className="space-y-2">{boundGraph.rows.map(row => <li key={row.model + row.id}>{row.label}: {row.changedFields.join(', ') || 'collegamento conservato'}</li>)}</ul>
            {boundGraph.blocked.map(message => <p key={message} role="alert">{message}</p>)}
            {!boundGraph.blocked.length && <label className="flex gap-3"><input required type="checkbox" checked={graphConfirmed} onChange={event => setGraphConfirmed(event.target.checked)} />
              Confermo il nuovo contesto selezionato e l’aggiornamento insieme delle schede elencate. Le versioni e le prove originali restano conservate.
            </label>}
          </>}
        </section>}

        {publishingCatalog && <section className="space-y-4 rounded-xl border p-4">
          <button type="button" className="underline" disabled={!values.serviceCatalogId} onClick={async () => {
            setPending(true); setCatalogConfirmed(false); setCatalogContentReady(false);
            try { const result = await prepareAdminCatalogPublicationAction(values.serviceCatalogId);
              setCatalogBinding(result.ok ? result.value : null);
              if (!result.ok) setResult({ ok: false, message: 'Servizio non disponibile per la preparazione della revisione.' });
            } catch { setCatalogBinding(null); setResult({ ok: false, message: 'Preparazione non disponibile. Le scelte sono conservate; riprova la preparazione.' }); }
            finally { setPending(false); }
          }}>Prepara la revisione del servizio scelto</button>
          {boundCatalog && <>
            <p>Servizio: {boundCatalog.name}. Le revisioni pubblicate da ritirare sono: {boundCatalog.activeVersions.map(row => row.version + ' · ' + row.name).join('; ') || 'nessuna'}.</p>
            <AdminCatalogRevisionContent key={boundCatalog.serviceId + boundCatalog.hash} digitalProjectTypes={boundCatalog.digitalProjectTypes}
              initial={values.operationalConditions}
              onChange={patch => { setValues(current => ({ ...current, ...patch })); setCatalogContentReady(true); }} />
            <label className="flex gap-3"><input required type="checkbox" checked={catalogConfirmed} onChange={event => setCatalogConfirmed(event.target.checked)} />
              Confermo la nuova revisione interna e il ritiro delle versioni elencate. Le offerte e gli incarichi storici restano collegati alla versione originaria.</label>
          </>}
        </section>}
        {correctingPayment && <section aria-label="Prova della rettifica del pagamento" className="space-y-4 rounded-xl border border-amber-400 p-4">
          <h2 className="font-bold">Rettifica documentata del pagamento</h2>
          <p>L’incasso originario, la sua data e la sua prova restano conservati. I servizi collegati ricevono lo stesso aggiornamento contabile. Il CRM non esegue rimborsi o trasferimenti di denaro.</p>
          <AdminReferenceSelect model="Payment" field={{ name: 'administrativeEvidenceVersionId', label: 'Documento e versione a prova della rettifica', type: 'select', required: true, reference: true, options: [] }} value={evidenceVersionId} onChange={setEvidenceVersionId} />
          <RomeDateTimeInput label="Data effettiva della rettifica documentata" value={effectiveAt} onChange={setEffectiveAt} required className={fieldClass} />
          <label className="flex gap-3"><input type="checkbox" required checked={declared} onChange={event => setDeclared(event.target.checked)} />Dichiaro di avere verificato la prova e lo stato amministrativo indicato; non sto registrando un nuovo incasso.</label>
        </section>}
        {data.noticeLifecycle?.action && operation === 'UPDATE' && <label className="flex gap-3 rounded-xl border border-amber-400 p-4">
          <input type="checkbox" required checked={noticeReviewed} onChange={event => setNoticeReviewed(event.target.checked)} />
          <span>{data.noticeLifecycle.action === 'ACTIVATE' ? 'Ho verificato il testo corrispondente all’hash mostrato e confermo l’attivazione di questa versione da ora. Se esiste una versione attiva dello stesso codice e finalità, va prima ritirata.' : 'Confermo il ritiro da ora di questa versione. Le ricevute già registrate restano conservate; il ripristino richiede una nuova versione.'}</span>
        </label>}
        {operation === 'RECTIFY' && <p>La rettifica viene aggiunta al registro della scheda. Non cambia il contenuto originale, non sostituisce una firma e non attesta una consegna o una presa in carico.</p>}
        {data.revokeDelivery && operation === 'UPDATE' && <p>La revoca impedisce di registrare una consegna usando questa autorizzazione. Destinatari, versione e decisione originale restano conservati. Nessuna autorizzazione già consumata può essere revocata.</p>}
        {operation === 'TRASH' && <p>Il record e il suo contenuto vengono conservati per il ripristino. I collegamenti e le prove storiche non vengono ricreati.</p>}
        <label className="block font-semibold">Motivazione della correzione<textarea required minLength={3} maxLength={2000} className={fieldClass}
          value={reason} onChange={event => setReason(event.target.value)} /></label>
        <button type="submit" disabled={(publishingCatalog && (!boundCatalog || !catalogConfirmed || !catalogContentReady)) || (needsContextMove && (!boundGraph || boundGraph.blocked.length > 0 || !graphConfirmed))} className="rounded-xl bg-blue-900 px-5 py-3 font-bold text-white disabled:opacity-50">{pending ? 'Registrazione…' : 'Salva operazione'}</button>
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
    {result?.ok && <a className="inline-block rounded-xl bg-green-800 px-5 py-3 text-white" href={href}>Riapri e verifica il salvataggio</a>}
    {result?.closed && <a className="underline" href={data.create ? `/admin/records/${data.model}/new?draft=${data.id}` : href}>Riapri per una nuova operazione</a>}
    <section className="space-y-3"><h2 className="text-xl font-bold">Correzioni e rettifiche registrate</h2>
      {!data.history.length && <p>Nessuna correzione amministrativa registrata da questa funzione.</p>}
      {data.history.map(row => <article key={row.id} className="space-y-2 rounded-xl border p-3"><p>{({ CREATE: 'Creazione', UPDATE: 'Correzione dati', TRASH: 'Cestino', RESTORE: 'Ripristino', RECTIFY: 'Rettifica annotata' } as Record<string, string>)[row.action]} · {operationalRomeTime(row.at)} · {row.actor}</p><p className="whitespace-pre-wrap">{row.reason}</p>
        {row.canRestore && <Link className="underline" href={`${href}?restoreRevision=${row.id}`}>Prepara il ripristino dei dati precedenti</Link>}</article>)}
    </section>
  </div>;
}
