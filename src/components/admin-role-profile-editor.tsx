'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { readAdminRoleProfile } from '@/lib/admin-role-profiles';
import { editableRolePermission, type RoleProfileSnapshot } from '@/lib/admin-role-profile-contract';
import { permissionCatalog, roleHasPermission } from '@/lib/permissions';
import { saveAdminRoleProfileAction, reconcileAdminRoleProfileAction, type RoleProfileResult } from '@/lib/admin-role-profile-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

type Data = Awaited<ReturnType<typeof readAdminRoleProfile>>;
const subscribe = () => () => {}, hydrated = () => true, server = () => false;
export function AdminRoleProfileEditor({ data, commandId: initialCommandId, recovering }: { data: Data; commandId: string; recovering: boolean }) {
  const ready = useSyncExternalStore(subscribe, hydrated, server), sending = useRef(false);
  const [expectedVersion] = useState(data.version), [commandId] = useState(initialCommandId);
  const [overrides, setOverrides] = useState(data.current.overrides), [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false), [closeConfirmed, setCloseConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RoleProfileResult | null>(recovering ? { ok: false, uncertain: true, message: 'Verifica il tentativo conservato.' } : null);
  const frozen = !ready || busy || !data.canWrite || Boolean(result?.uncertain || result?.ok || result?.closed), path = '/settings/roles/' + data.role;
  function remember(pending: boolean) {
    const url = new URL(window.location.href);
    if (pending) url.searchParams.set('decision', commandId); else url.searchParams.delete('decision');
    window.history.replaceState(window.history.state, '', url);
  }
  function restore(snapshot: Pick<RoleProfileSnapshot, 'overrides'>) {
    if (frozen) return; setOverrides(snapshot.overrides); setConfirmed(false);
  }
  async function save() {
    if (sending.current || frozen || !confirmed) return;
    sending.current = true; setBusy(true); remember(true);
    try {
      const value = await saveAdminRoleProfileAction({ commandId, role: data.role, expectedVersion, overrides, reason, confirmed: true });
      setResult(value); if (!value.ok && !value.uncertain) remember(false);
    } catch { setResult({ ok: false, uncertain: true, message: 'Risposta interrotta. Verifica lo stesso tentativo prima di ripetere.' }); }
    finally { sending.current = false; setBusy(false); }
  }
  async function reconcile(close = false) {
    if (sending.current || !ready) return; sending.current = true; setBusy(true);
    try { setResult(await reconcileAdminRoleProfileAction({ commandId, role: data.role, close })); }
    catch { setResult({ ok: false, uncertain: true, message: 'Verifica interrotta. Conserva il riferimento del tentativo.' }); }
    finally { sending.current = false; setBusy(false); }
  }
  const effective = (permission: (typeof permissionCatalog)[number]['code']) =>
    overrides.find(item => item.permission === permission)?.allowed ?? roleHasPermission(data.role, permission);
  return <div className="space-y-5" data-interactive-ready={ready}>
    <Link className="underline" href="/settings/roles">Torna ai ruoli</Link>
    <p>Profilo {data.role} · revisione {data.current.revision}. Si applica ai nuovi account; dalla scheda di un account esistente puoi applicare questa versione con una scelta esplicita. Le concessioni su clienti e documenti restano separate.</p>
    <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-4">
      <fieldset disabled={frozen} className="space-y-3">{permissionCatalog.map(item => {
        const editable = editableRolePermission(data.role, item.code), override = overrides.find(value => value.permission === item.code);
        return <div key={item.code} className="rounded-xl border p-3 grid gap-3 md:grid-cols-[1fr_auto]">
          <div><strong>{item.label}</strong><p>{item.description}</p><p>{item.group} · {effective(item.code) ? 'Consentito' : 'Negato'}{!editable && ' · limite protetto'}</p></div>
          <label>Scelta per {item.label}<select className="block border rounded-lg p-2" aria-label={'Profilo · ' + item.label}
            disabled={!editable} value={override === undefined ? 'inherit' : override.allowed ? 'allow' : 'deny'}
            onChange={event => { setOverrides(values => [...values.filter(value => value.permission !== item.code),
              ...(event.target.value === 'inherit' ? [] : [{ permission: item.code, allowed: event.target.value === 'allow' }])]); setConfirmed(false); }}>
            <option value="inherit">Base del sistema</option><option value="allow">Consenti</option><option value="deny">Nega</option>
          </select></label>
        </div>;
      })}
        <label className="block">Motivazione<textarea className="block w-full rounded-xl border p-3" required minLength={3} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)}/></label>
        <section aria-label="Riepilogo del profilo" className="rounded-xl border p-3">
          <p>Funzioni consentite: {permissionCatalog.filter(item => effective(item.code)).map(item => item.label).join(', ') || 'Nessuna'}.</p>
          <p>Nessun account esistente o concessione viene modificato da questo salvataggio.</p>
          <label><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/> Confermo il profilo per i nuovi account.</label>
        </section>
        <button disabled={!confirmed} className="rounded-xl bg-blue-900 px-4 py-3 text-white font-bold">Registra profilo del ruolo</button>
      </fieldset>
    </form>
    {result && <p role="status">{result.message}</p>}{result?.stepUp && <InlinePrivilegedConfirmation/>}
    {result?.uncertain && <section className="space-y-3 border rounded-xl p-3"><p>Riferimento: {commandId}</p>
      <button disabled={busy} className="block underline" onClick={() => void reconcile()}>Verifica esito registrato</button>
      <label><input type="checkbox" checked={closeConfirmed} onChange={event => setCloseConfirmed(event.target.checked)}/> Chiudi solo un tentativo privo di effetto.</label>
      <button disabled={busy || !closeConfirmed} className="block underline" onClick={() => void reconcile(true)}>Riconcilia e chiudi il tentativo</button>
    </section>}
    {(result?.ok || result?.closed) && <a className="block underline" href={path}>Riapri e verifica il profilo</a>}
    <button disabled={frozen} className="underline" onClick={() => restore({ overrides: [] })}>Riprendi la base del sistema nella bozza</button>
    <section className="space-y-3"><h2 className="font-bold">Cronologia · {data.totalRevisions} revisioni</h2>
      {data.history.map(row => <div className="rounded-xl border p-3" key={row.commandId}>
        <p>Revisione {row.after.revision} · {new Date(row.createdAt).toLocaleString('it-IT')} · {row.reason}</p>
        <button disabled={frozen} className="underline" onClick={() => restore(row.after)}>Riprendi questa versione nella bozza</button>
      </div>)}
      {data.page > 1 && <Link className="mr-4 underline" href={path + '?page=' + (data.page - 1)}>Revisioni più recenti</Link>}
      {data.hasMore && <Link className="underline" href={path + '?page=' + (data.page + 1)}>Revisioni precedenti</Link>}
    </section>
  </div>;
}
