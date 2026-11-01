'use client';
import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { mutateAdminRequest } from '@/lib/admin-request-actions';
const subscribeReady = () => () => {};
const browserReady = () => true;
const serverReady = () => false;
const pendingKey = (scope: string) => 'fai.admin-request.pending-command.v1:' + scope;
const pendingCommand = (scope: string) => {
  try { return sessionStorage.getItem(pendingKey(scope)) ?? ''; } catch { return ''; }
};
const serverCommand = () => '';
function remember(scope: string, commandId: string) {
  try { sessionStorage.setItem(pendingKey(scope), commandId); } catch { /* The visible recovery link remains available. */ }
}
function forget(scope: string, commandId: string) {
  try { if (sessionStorage.getItem(pendingKey(scope)) === commandId) sessionStorage.removeItem(pendingKey(scope)); } catch { /* no credentials or payload are stored */ }
}
export function AdminRequestForm({ children, className, recoveryScope }: { children: ReactNode; className?: string; recoveryScope: string }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const prior = useSyncExternalStore(subscribeReady, () => pendingCommand(recoveryScope), serverCommand);
  const sent = useRef(false), [command, setCommand] = useState(''), [pending, setPending] = useState(false), [unknown, setUnknown] = useState(false);
  const [savedHref, setSavedHref] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<'UNAVAILABLE' | 'INVALID' | null>(null);
  const unresolved = prior && !command;
  const recovery = command || prior;
  return <form action={async form => {
    try {
      const result = await mutateAdminRequest(form);
      setPending(false);
      if (result.status === 'RECORDED') {
        forget(recoveryScope, String(form.get('commandId') ?? '')); setSavedHref(result.target); setUnknown(false);
      } else { setRefusal(result.status); setUnknown(false); }
      // A server refusal is observed. Keep the same command available for
      // read-only reconciliation; it must never become a blind resubmission.
      // Keep the durable receipt on this page. Opening it is an explicit GET;
      // no action completion or background refresh can replay the command.
    } catch {
      setUnknown(true); setPending(false);
    }
  }} className={className} data-interactive-ready={ready} aria-busy={pending} onSubmit={event => {
    if (sent.current || unresolved) { event.preventDefault(); return; }
    const id = new FormData(event.currentTarget).get('commandId');
    if (typeof id !== 'string') { event.preventDefault(); return; }
    setCommand(id); remember(recoveryScope, id); sent.current = true; setPending(true);
  }}><fieldset disabled={!ready || !!unresolved || !!savedHref} className="contents">{children}</fieldset>
    {savedHref && <><p role="status">Operazione registrata nello storico. Nessuna email inviata.</p><a className="block font-bold underline" href={savedHref}>Apri richiesta registrata</a></>}
    {pending && <p role="status">Registrazione in corso. Conserva questa pagina fino all’esito; non ripetere la richiesta.</p>}
    {refusal && <p role="status">{refusal === 'UNAVAILABLE'
      ? 'Il perimetro non è più valido oppure l’operazione non è disponibile. Verifica lo stesso comando senza reinviare.'
      : 'I dati non sono validi. Conserva il riferimento e verifica lo stesso comando prima di preparare una nuova richiesta.'}</p>}
    {(unknown || (unresolved && !refusal)) && <p role="status">Risposta non osservata. Verifica lo stesso comando prima di preparare un’altra richiesta.</p>}
    {recovery && !savedHref && <a className="block font-bold underline" href={'/admin-requests?recover=' + encodeURIComponent(recovery)}>Verifica esito dello stesso comando</a>}
  </form>;
}
export function AdminRequestRecovery({ commandId, recoveryScope }: { commandId: string; recoveryScope: string }) {
  const [state, setState] = useState('Verifica l’esito prima di ripetere la richiesta.'), [href, setHref] = useState<string | null>(null), [pending, setPending] = useState(false);
  return <section className="space-y-3 rounded-xl border p-4"><h2 className="font-bold">Verifica esito della richiesta</h2><p role="status">{state}</p>
    <button className="rounded-xl border p-3" disabled={pending} onClick={async () => {
      setPending(true);
      try {
        const result = await fetch('/api/admin-requests/outcome?commandId=' + encodeURIComponent(commandId), { cache: 'no-store' });
        if (!result.ok) throw new Error('UNAVAILABLE');
        const body = await result.json();
        if (body.status === 'RECORDED') {
          forget(recoveryScope, commandId); setState('Operazione registrata nello storico. Nessuna email inviata.'); setHref('/admin-requests/' + body.requestId);
        } else setState('Nessun esito registrato al momento. Il tentativo può essere ancora in corso: verifica di nuovo senza reinviare.');
      } catch { setState('Esito non disponibile: non ripetere finché la sessione e il perimetro non sono stati verificati.'); }
      finally { setPending(false); }
    }}>Verifica esito</button>{href && <a className="ml-3 font-bold underline" href={href}>Apri richiesta registrata</a>}
  </section>;
}
