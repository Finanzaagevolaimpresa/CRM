'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { readAdminOperationalLink, previewAdminOperationalLink } from '@/lib/admin-operational-links';
import { previewAdminOperationalLinkAction, searchAdminOperationalLinkAction, saveAdminOperationalLinkAction, reconcileAdminOperationalLinkAction, type LinkResult } from '@/lib/admin-operational-link-actions';
import { AdminReferenceSelect } from './admin-reference-select';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
type Data = Awaited<ReturnType<typeof readAdminOperationalLink>>;
type Preview = Awaited<ReturnType<typeof previewAdminOperationalLink>>;
const subscribe = () => () => {}, hydrated = () => true, server = () => false;
function savedValues(snapshot: unknown): Record<string, string> | null {
  if (!snapshot || typeof snapshot !== 'object' || !('values' in snapshot) || !snapshot.values || typeof snapshot.values !== 'object') return null;
  return Object.fromEntries(Object.entries(snapshot.values).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
export function AdminOperationalLinkEditor({ data, commandId: initialCommandId, recovering }: { data: Data; commandId: string; recovering: boolean }) {
  const ready = useSyncExternalStore(subscribe, hydrated, server), sending = useRef(false);
  const [commandId] = useState(initialCommandId);
  const [values, setValues] = useState(data.values), [preview, setPreview] = useState<Preview | null>(null), [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false), [closeConfirmed, setCloseConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LinkResult | null>(recovering ? { ok: false, uncertain: true, message: 'Verifica il tentativo conservato prima di proseguire.' } : null);
  const frozen = !ready || busy || Boolean(result?.uncertain || result?.ok || result?.closed), path = '/admin/links/' + data.model + '/' + encodeURIComponent(data.id);
  function remember(value: boolean) { const url = new URL(window.location.href); if (value) url.searchParams.set('decision', commandId); else url.searchParams.delete('decision'); window.history.replaceState(window.history.state, '', url); }
  function choose(next: Record<string, string>) { if (frozen) return; setValues(next); setPreview(null); setConfirmed(false); }
  async function prepare() {
    if (sending.current || frozen) return; sending.current = true; setBusy(true); setConfirmed(false);
    try { const next = await previewAdminOperationalLinkAction({ model: data.model, id: data.id, values });
      if ('error' in next) { setResult({ ok: false, message: next.error }); setPreview(null); } else { setPreview(next); setResult(null); }
    } catch { setResult({ ok: false, message: 'Anteprima interrotta. Nessuna modifica richiesta; riprova con le scelte conservate.' }); }
    finally { sending.current = false; setBusy(false); }
  }
  async function save() {
    if (sending.current || frozen || !preview || !confirmed) return; sending.current = true; setBusy(true); remember(true);
    try { const next = await saveAdminOperationalLinkAction({ model: data.model, id: data.id, values, commandId,
      expectedVersion: preview.version, reason, confirmed: true }); setResult(next); if (!next.ok && !next.uncertain) remember(false);
    } catch { setResult({ ok: false, uncertain: true, message: 'Risposta interrotta. Verifica il tentativo prima di ripetere.' }); }
    finally { sending.current = false; setBusy(false); }
  }
  async function reconcile(close = false) {
    if (sending.current || !ready) return; sending.current = true; setBusy(true);
    try { setResult(await reconcileAdminOperationalLinkAction({ model: data.model, id: data.id, commandId, close })); }
    catch { setResult({ ok: false, uncertain: true, message: 'Verifica interrotta. Conserva il riferimento.' }); }
    finally { sending.current = false; setBusy(false); }
  }
  return <div className="space-y-5" data-interactive-ready={ready}>
    <Link className="underline" href={data.model === 'PracticeReadiness' ? '/practice-readiness#practice-' + data.id : '/admin/records/' + data.model + '/' + data.id}>Torna ai dati della scheda</Link>
    <p>La rettifica aggiorna i collegamenti correnti mostrati nell’anteprima. Conversioni, firme, incassi e accettazioni personali originali restano conservati. Nessun invio o nuova condivisione viene creato.</p>
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}><fieldset className="space-y-4" disabled={frozen}>
      {data.fields.map(field => <AdminReferenceSelect key={field.name} model={data.model} field={{ ...field, type: 'select', reference: true }}
        value={values[field.name]} onChange={value => choose({ ...values, [field.name]: value })}
        lookup={input => searchAdminOperationalLinkAction({ ...input, model: data.model, id: data.id })}/>)}
      <button type="button" className="underline" onClick={() => void prepare()}>Prepara anteprima dei collegamenti</button>
      {preview && <section aria-label="Riepilogo collegamenti" className="border rounded-xl p-4 space-y-3">
        {preview.changes.length ? preview.changes.filter(change => change.details.length).map(change => <div key={change.model + change.id}><p className="font-semibold">{change.label}</p>
          <ul className="space-y-2">{change.details.map(detail => <li key={detail.label}><strong>{detail.label}</strong>: {detail.before} → {detail.after}</li>)}</ul></div>) : <p>Nessuna modifica rispetto ai collegamenti correnti.</p>}
        <label className="block"><input type="checkbox" checked={confirmed} required onChange={e => setConfirmed(e.target.checked)}/> Confermo tutti i collegamenti mostrati e la conservazione delle prove storiche.</label></section>}
      <label className="block font-semibold">Motivazione<textarea required minLength={3} maxLength={2000} className="block w-full rounded-xl border p-3" value={reason} onChange={e => setReason(e.target.value)}/></label>
      <button className="rounded-xl bg-blue-900 text-white font-bold p-3" disabled={!preview?.changes.length || !confirmed}>Registra rettifica dei collegamenti</button>
    </fieldset></form>
    {result && <p role="status">{result.message}</p>}{result?.stepUp && <InlinePrivilegedConfirmation/>}
    {result?.uncertain && <section className="border rounded-xl p-4 space-y-3"><p className="break-all">Riferimento: {commandId}</p>
      <button className="block underline" disabled={busy} onClick={() => void reconcile()}>Verifica esito registrato</button>
      <label><input type="checkbox" checked={closeConfirmed} onChange={e => setCloseConfirmed(e.target.checked)}/> Chiudi soltanto se il tentativo non ha prodotto una rettifica.</label>
      <button className="block underline" disabled={busy || !closeConfirmed} onClick={() => void reconcile(true)}>Riconcilia e chiudi il tentativo</button></section>}
    {(result?.ok || result?.closed) && <Link className="block font-bold underline" href={path}>Riapri e verifica i collegamenti</Link>}
    <section className="space-y-3"><h2 className="font-bold">Cronologia delle rettifiche</h2>{data.history.map(h => <div className="border rounded-xl p-3 space-y-2" key={h.commandId}>
      <p>{new Date(h.at).toLocaleString('it-IT')} · {h.actor} · {h.reason}</p>
      <details><summary className="cursor-pointer underline">Identificativi e collegamenti conservati nella rettifica</summary>
        <p className="break-all">Prima: {JSON.stringify(h.before)}</p><p className="break-all">Dopo: {JSON.stringify(h.after)}</p></details>
      {savedValues(h.before) && <button disabled={frozen} className="underline" onClick={() => choose(savedValues(h.before)!)}>Riprendi i collegamenti principali precedenti nella bozza</button>}
      <p>Il ripristino prepara una nuova rettifica; l’anteprima indica anche gli altri collegamenti coinvolti.</p></div>)}
      {!data.history.length && <p>Nessuna rettifica registrata.</p>}
      {data.page > 1 && <Link className="mr-4 underline" href={path + '?page=' + (data.page - 1)}>Cronologia precedente</Link>}
      {data.hasMore && <Link className="underline" href={path + '?page=' + (data.page + 1)}>Altre rettifiche</Link>}
    </section>
  </div>;
}
